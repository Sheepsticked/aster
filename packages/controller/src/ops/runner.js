// @ts-check
// Operation runner: enqueue() stores an `operations` row and its registered handler runs later, one at a time per queue key
// (modem id or kind), with global kinds running alone. Interrupted rows are re-evaluated at start(); a failed status write is fatal.
import { createBus } from '../bus.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('node:sqlite').SQLOutputValue} SQLOutputValue */
/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../bus.js').Bus} Bus */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {'admin' | 'cli' | 'system'} Actor */
/** @typedef {'queued' | 'running' | 'interrupted' | 'done' | 'failed' | 'uncertain'} Status */
/** @typedef {Record<string, unknown>} Result */
/**
 * @typedef {object} OpInfo  the operation as its handler sees it
 * @property {number} id
 * @property {string} kind
 * @property {string | null} modemId
 * @property {Record<string, unknown> | null} params  parsed back from params_json, so a re-run after a restart gets the same values
 * @property {Actor} actor
 * @property {number} createdAt
 * @property {number | null} interruptedAt  epoch ms at which start() found the operation interrupted; null on its first run
 */
/**
 * @typedef {object} Context
 * @property {Readonly<OpInfo>} op
 * @property {(message: string) => void} progress  publishes op.progress while the operation runs; ignored afterwards
 * @property {DatabaseSync} db  the shared connection: never await while a transaction is open on it
 * @property {AmiClient | null} ami
 * @property {Bus} bus
 * @property {Logger} log
 */
/** @typedef {(ctx: Context) => unknown} Handler  returns (or resolves to) a plain result object, undefined or null */
/**
 * @typedef {object} Registration
 * @property {'global' | 'queue'} [lock]  default 'global' for GLOBAL_KINDS (which cannot take 'queue'), 'queue' otherwise
 * @property {'uncertain' | 'rerun' | Handler} [reevaluate]  what start() does with an interrupted operation (default 'uncertain')
 */
/**
 * @typedef {object} Operation  an operations row with its JSON columns parsed
 * @property {number} id
 * @property {string} kind
 * @property {string | null} modem_id
 * @property {Status} status
 * @property {Record<string, unknown> | null} params
 * @property {Result | null} result
 * @property {string | null} error
 * @property {Actor} actor
 * @property {number} created_at
 * @property {number | null} started_at
 * @property {number | null} finished_at
 */
/**
 * @typedef {object} EnqueueRequest
 * @property {string} kind
 * @property {string | null} [modemId]
 * @property {Record<string, unknown> | null} [params]  JSON-serializable
 * @property {Actor} actor
 */
/**
 * @typedef {object} StartSummary
 * @property {number} interrupted   rows found running
 * @property {number} reevaluating  interrupted rows waiting for a re-run or their reevaluate function
 * @property {number} uncertain     interrupted rows marked uncertain at once
 * @property {number} queued        queued rows that will run
 * @property {number} unknownKind   rows of a kind without a handler: a queued one → failed, an interrupted one → uncertain
 */
/**
 * @typedef {object} RunnerOptions
 * @property {DatabaseSync} db  migrated
 * @property {AmiClient | null} [ami]
 * @property {Bus} [bus]
 * @property {Logger} [log]
 * @property {() => number} [now]  epoch ms
 * @property {(err: Error) => void} [onFatal]  default: the error is rethrown outside the runner, so the controller exits
 */
/**
 * @typedef {object} Runner
 * @property {(kind: string, handler: Handler, registration?: Registration) => void} register  only before start()
 * @property {() => StartSummary} start  once, at boot
 * @property {(request: EnqueueRequest) => number} enqueue  the id; before start() the operation waits for start()
 * @property {(id: number) => Operation | null} get
 * @property {(id: number) => Promise<Operation>} wait  resolves when the operation is done, failed or uncertain
 * @property {() => Promise<void>} stop  nothing starts afterwards (waiting rows stay for the next start); resolves when the running operations have settled
 */
/**
 * @typedef {object} Entry
 * @property {Handler} handler
 * @property {boolean} global
 * @property {'uncertain' | 'rerun' | Handler} reevaluate
 */
/**
 * @typedef {object} Job
 * @property {Readonly<OpInfo>} op
 * @property {Entry} entry
 * @property {string} key  queue key: modem:<id>, or kind:<kind> without a modem
 * @property {string | null} paramsJson  as stored; with id, kind, actor, created_at and modem_id it identifies the row
 */
/** @typedef {{ status: Status, result: Result, error: string | null }} Outcome */
/** @typedef {{ resolve: (op: Operation) => void, reject: (err: Error) => void }} Waiter */

export const GLOBAL_KINDS = Object.freeze(['registry-apply', 'config-apply', 'config-restore', 'asterisk-restart']);
export const ACTORS = Object.freeze(['admin', 'cli', 'system']);
/** The statuses an operation ends in; retention deletes only these. */
export const FINAL = Object.freeze(['done', 'failed', 'uncertain']);

/** @type {Set<string>} */
const GLOBAL = new Set(GLOBAL_KINDS);
/** @type {Set<string>} */
const ACTOR = new Set(ACTORS);
/** @type {Set<string>} */
const FINISHED = new Set(FINAL);
const KIND = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_MODEM_ID = 64;
const RESTARTED = 'the controller restarted while the operation was running';

const INSERT = "INSERT INTO operations (kind, modem_id, status, params_json, actor, created_at) VALUES (?, ?, 'queued', ?, ?, ?)";
const SELECT = 'SELECT * FROM operations WHERE id = ?';
const SELECT_WAITING = "SELECT * FROM operations WHERE status IN ('queued', 'interrupted') ORDER BY id";
const INTERRUPT = "UPDATE operations SET status = 'interrupted', result_json = ?, error = ? WHERE status = 'running' RETURNING id";
// The row must still be the one the job was made from: after an enqueue inside a transaction that rolled back, the next insert hands
// the same id out again.
const MARK_RUNNING = `UPDATE operations SET status = 'running', started_at = COALESCE(started_at, ?), result_json = NULL, error = NULL
  WHERE id = ? AND status IN ('queued', 'interrupted') AND kind = ? AND actor = ? AND created_at = ? AND modem_id IS ? AND params_json IS ?`;
const FINISH = 'UPDATE operations SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ? AND status = ?';

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/** A handler throws this to end its operation `uncertain`, or `failed` with a partial result (e.g. the lines an AT command returned). */
export class OperationError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: 'failed' | 'uncertain', result?: Result, cause?: unknown }} [options]
   */
  constructor(message, { status = 'failed', result, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    if (status !== 'failed' && status !== 'uncertain') {
      throw new TypeError(`an OperationError ends an operation failed or uncertain, not ${String(status)}`);
    }
    this.name = 'OperationError';
    this.status = status;
    this.result = result;
  }
}

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message || err.name : String(err));

/**
 * The outcome of a handler's return value: a plain object, undefined or null → done, with observed_at; anything else → uncertain.
 * @param {unknown} value
 * @param {number} at  epoch ms, used when the result has no observed_at
 * @returns {Outcome}
 */
function fromValue(value, at) {
  if (value === undefined || value === null) return { status: 'done', result: { observed_at: at }, error: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    const what = Array.isArray(value) ? 'an array' : typeof value;
    return { status: 'uncertain', result: { observed_at: at }, error: `the handler returned ${what}, not a result object; the outcome was not recorded` };
  }
  const result = /** @type {Result} */ ({ ...value });
  try {
    JSON.stringify(result);
  } catch (err) {
    return { status: 'uncertain', result: { observed_at: at }, error: `the handler's result cannot be stored (${errorText(err)}); the outcome was not recorded` };
  }
  if (!Object.hasOwn(result, 'observed_at')) return { status: 'done', result: { ...result, observed_at: at }, error: null };
  if (Number.isSafeInteger(result.observed_at) && Number(result.observed_at) >= 0) return { status: 'done', result, error: null };
  return { status: 'uncertain', result: { ...result, observed_at: at }, error: 'the handler returned an observed_at that is not epoch milliseconds' };
}

/**
 * @param {unknown} err
 * @param {number} at
 * @returns {Outcome}
 */
function fromError(err, at) {
  if (!(err instanceof OperationError)) return { status: 'failed', result: { observed_at: at }, error: errorText(err) };
  const stored = fromValue(err.result, at);
  if (stored.status === 'uncertain') return { status: 'uncertain', result: stored.result, error: `${err.message} (${stored.error})` };
  return { status: err.status, result: stored.result, error: err.message };
}

/**
 * @param {Record<string, SQLOutputValue>} row
 * @returns {Operation}
 */
function toOperation(row) {
  /** @param {SQLOutputValue | undefined} value */
  const optional = (value) => (value === null || value === undefined ? null : Number(value));
  return {
    id: Number(row.id),
    kind: String(row.kind),
    modem_id: row.modem_id === null ? null : String(row.modem_id),
    status: /** @type {Status} */ (String(row.status)),
    params: row.params_json === null ? null : JSON.parse(String(row.params_json)),
    result: row.result_json === null ? null : JSON.parse(String(row.result_json)),
    error: row.error === null ? null : String(row.error),
    actor: /** @type {Actor} */ (String(row.actor)),
    created_at: Number(row.created_at),
    started_at: optional(row.started_at),
    finished_at: optional(row.finished_at),
  };
}

/**
 * @param {RunnerOptions} options
 * @returns {Runner}
 */
export function createRunner({ db, ami = null, bus = createBus(), log = SILENT, now = Date.now, onFatal }) {
  const insert = db.prepare(INSERT);
  const select = db.prepare(SELECT);
  const markRunning = db.prepare(MARK_RUNNING);
  const finishRow = db.prepare(FINISH);
  /** @type {Map<string, Entry>} */
  const handlers = new Map();
  /** Operations not started yet, in id order. @type {Job[]} */
  const waiting = [];
  /** @type {Map<number, Job>} */
  const running = new Map();
  /** @type {Map<number, Waiter[]>} */
  const waiters = new Map();
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();
  /** @type {'new' | 'started' | 'stopped' | 'broken'} */
  let state = 'new';
  let pumpQueued = false;

  /**
   * @param {Readonly<OpInfo>} op
   * @param {Status} status
   * @param {{ message?: string | null, result?: Result | null, error?: string | null }} [extra]
   */
  function announce(op, status, { message = null, result = null, error = null } = {}) {
    bus.publish('op.progress', { id: op.id, kind: op.kind, modem_id: op.modemId, actor: op.actor, status, message, result, error, at: now() });
  }

  /**
   * @param {number} id
   * @param {(waiter: Waiter) => void} settle
   */
  function settleWaiters(id, settle) {
    const list = waiters.get(id);
    waiters.delete(id);
    for (const waiter of list ?? []) settle(waiter);
  }

  /** @param {unknown} err */
  function fatal(err) {
    if (state === 'broken') return;
    state = 'broken';
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('operations runner stopped: an operation status cannot be stored; restart the controller', { err: error });
    waiting.length = 0;
    for (const id of [...waiters.keys()]) settleWaiters(id, (waiter) => waiter.reject(error));
    if (onFatal) {
      onFatal(error);
    } else {
      process.nextTick(() => {
        throw error;
      });
    }
  }

  /** A status write inside a handler's open transaction would be committed or rolled back with that transaction. */
  function assertNoTransaction() {
    if (db.isTransaction) {
      throw new Error('a transaction is open on the database connection across an await; operation statuses cannot be stored safely');
    }
  }

  /**
   * @param {OpInfo} op
   * @param {Entry} entry
   * @param {string | null} paramsJson
   * @returns {Job}
   */
  function jobFor(op, entry, paramsJson) {
    return { op: Object.freeze(op), entry, key: op.modemId === null ? `kind:${op.kind}` : `modem:${op.modemId}`, paramsJson };
  }

  /**
   * @param {Job} a
   * @param {Job} b
   */
  const conflicts = (a, b) => a.entry.global || b.entry.global || a.key === b.key;

  function schedule() {
    if (pumpQueued || state !== 'started') return;
    pumpQueued = true;
    setImmediate(pump);
  }

  /** Starts every waiting operation that conflicts with no running operation and no earlier waiting one. */
  function pump() {
    pumpQueued = false;
    /** @type {Job[]} */
    const blocked = [];
    for (const job of [...waiting]) {
      if (state !== 'started') return;
      if (blocked.some((other) => conflicts(job, other)) || [...running.values()].some((other) => conflicts(job, other))) {
        blocked.push(job);
      } else {
        waiting.splice(waiting.indexOf(job), 1);
        launch(job);
      }
    }
  }

  /**
   * @param {Job} job
   * @returns {Context}
   */
  function context(job) {
    const { op } = job;
    return Object.freeze({
      op,
      progress(message) {
        if (running.get(op.id) === job) announce(op, 'running', { message: String(message) });
      },
      db,
      ami,
      bus,
      log: log.child({ op: op.id, kind: op.kind }),
    });
  }

  /** @param {Job} job */
  function launch(job) {
    const { op, entry } = job;
    try {
      assertNoTransaction();
      const { changes } = markRunning.run(now(), op.id, op.kind, op.actor, op.createdAt, op.modemId, job.paramsJson);
      if (Number(changes) !== 1) {
        log.error('operation row is gone or no longer waiting; not started', { op: op.id, kind: op.kind });
        // When the id now belongs to another stored operation, the waiters are that operation's.
        if (!get(op.id)) settleWaiters(op.id, (waiter) => waiter.reject(new Error(`operation ${op.id} is no longer stored and was not started`)));
        return;
      }
    } catch (err) {
      fatal(err);
      return;
    }
    running.set(op.id, job);
    announce(op, 'running');
    const fn = op.interruptedAt === null || entry.reevaluate === 'rerun' ? entry.handler : /** @type {Handler} */ (entry.reevaluate);
    const ctx = context(job);
    const settled = Promise.resolve()
      .then(() => fn(ctx))
      .then((value) => finish(job, fromValue(value, now())), (err) => finish(job, fromError(err, now()), err));
    inFlight.add(settled);
    void settled.finally(() => inFlight.delete(settled));
  }

  /**
   * @param {Job} job
   * @param {Outcome} outcome
   * @param {unknown} [thrown]
   */
  function finish(job, outcome, thrown) {
    const { op } = job;
    try {
      if (state === 'broken') return;
      const { status, error } = outcome;
      const json = JSON.stringify(op.interruptedAt === null ? outcome.result : { ...outcome.result, interrupted_at: op.interruptedAt });
      try {
        assertNoTransaction();
        if (Number(finishRow.run(status, json, error, now(), op.id, 'running').changes) !== 1) {
          log.error('operation row changed while the operation ran; its outcome was not stored', { op: op.id, kind: op.kind, status });
          settleWaiters(op.id, (waiter) => waiter.reject(new Error(`operation ${op.id} changed while it ran; its outcome was not stored`)));
          return;
        }
      } catch (err) {
        fatal(err);
        return;
      }
      const fields = { op: op.id, kind: op.kind, modem: op.modemId, actor: op.actor, status };
      if (status === 'done') log.info('operation done', fields);
      else log.warn(`operation ${status}`, { ...fields, error, ...(thrown === undefined ? {} : { err: thrown }) });
      announce(op, status, { result: JSON.parse(json), error });
      const row = get(op.id);
      settleWaiters(op.id, (waiter) => (row ? waiter.resolve(row) : waiter.reject(new Error(`operation ${op.id} is gone`))));
    } catch (err) {
      fatal(err);
    } finally {
      running.delete(op.id);
      schedule();
    }
  }

  /** @param {number} id */
  function get(id) {
    const row = select.get(id);
    return row ? toOperation(row) : null;
  }

  return {
    register(kind, handler, { lock, reevaluate = 'uncertain' } = {}) {
      if (state !== 'new') throw new Error('operation handlers must be registered before start()');
      if (typeof kind !== 'string' || !KIND.test(kind)) throw new TypeError(`invalid operation kind: ${JSON.stringify(kind)}`);
      if (handlers.has(kind)) throw new Error(`a handler for operation kind ${kind} is already registered`);
      if (typeof handler !== 'function') throw new TypeError(`the handler of operation kind ${kind} must be a function`);
      if (lock !== undefined && lock !== 'global' && lock !== 'queue') {
        throw new TypeError(`the lock of operation kind ${kind} must be 'global' or 'queue', not ${JSON.stringify(lock)}`);
      }
      if (GLOBAL.has(kind) && lock === 'queue') throw new Error(`operation kind ${kind} always takes the global lock`);
      if (reevaluate !== 'uncertain' && reevaluate !== 'rerun' && typeof reevaluate !== 'function') {
        throw new TypeError(`reevaluate of operation kind ${kind} must be 'uncertain', 'rerun' or a function`);
      }
      handlers.set(kind, { handler, global: lock === 'global' || GLOBAL.has(kind), reevaluate });
    },

    start() {
      if (state !== 'new') throw new Error(`start() can be called once (the runner is ${state})`);
      const at = now();
      /** @type {StartSummary} */
      const summary = { interrupted: 0, reevaluating: 0, uncertain: 0, queued: 0, unknownKind: 0 };
      /** @type {Job[]} */
      const jobs = [];
      /** @type {Array<{ op: Readonly<OpInfo>, status: Status, result: Result, error: string | null }>} */
      const changed = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const marked = new Set(db.prepare(INTERRUPT).all(JSON.stringify({ observed_at: at, interrupted_at: at }), RESTARTED)
          .map((row) => Number(row.id)));
        summary.interrupted = marked.size;
        for (const row of db.prepare(SELECT_WAITING).all()) {
          const stored = toOperation(row);
          const entry = handlers.get(stored.kind);
          const previous = stored.result?.interrupted_at;
          const interruptedAt = stored.status !== 'interrupted' ? null : Number.isSafeInteger(previous) ? Number(previous) : at;
          const op = Object.freeze({ id: stored.id, kind: stored.kind, modemId: stored.modem_id, params: stored.params, actor: stored.actor,
            createdAt: stored.created_at, interruptedAt });
          if (marked.has(op.id)) changed.push({ op, status: 'interrupted', result: { observed_at: at, interrupted_at: at }, error: RESTARTED });
          /** @type {Outcome | null} */
          let outcome = null;
          if (!entry) {
            summary.unknownKind += 1;
            outcome = interruptedAt === null
              ? { status: 'failed', result: { observed_at: at }, error: `no handler is registered for operation kind ${op.kind}; the operation did not run` }
              : { status: 'uncertain', result: { observed_at: at, interrupted_at: interruptedAt },
                error: `${RESTARTED}, and no handler is registered for its kind; the outcome is unknown` };
          } else if (interruptedAt !== null && entry.reevaluate === 'uncertain') {
            summary.uncertain += 1;
            outcome = { status: 'uncertain', result: { observed_at: at, interrupted_at: interruptedAt }, error: `${RESTARTED}; the outcome is unknown` };
          }
          if (outcome) {
            finishRow.run(outcome.status, JSON.stringify(outcome.result), outcome.error, at, op.id, stored.status);
            changed.push({ op, ...outcome });
          } else {
            summary[interruptedAt === null ? 'queued' : 'reevaluating'] += 1;
            jobs.push(jobFor({ ...op }, /** @type {Entry} */ (entry), row.params_json === null ? null : String(row.params_json)));
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // SQLite has already rolled the transaction back; the original error is rethrown.
        }
        throw err;
      }
      state = 'started';
      for (const { op, status, result, error } of changed) announce(op, status, { result, error });
      waiting.push(...jobs);
      log.info('operations runner started', { ...summary });
      schedule();
      return summary;
    },

    enqueue({ kind, modemId = null, params = null, actor }) {
      if (state === 'stopped' || state === 'broken') throw new Error(`the operations runner is ${state}; ${String(kind)} was not queued`);
      const entry = handlers.get(kind);
      if (!entry) throw new Error(`no handler is registered for operation kind ${JSON.stringify(kind)}`);
      if (!ACTOR.has(actor)) throw new TypeError(`an operation actor is admin, cli or system, not ${JSON.stringify(actor)}`);
      if (modemId !== null && (typeof modemId !== 'string' || modemId.length === 0 || modemId.length > MAX_MODEM_ID)) {
        throw new TypeError(`an operation modemId is null or a string of 1 to ${MAX_MODEM_ID} characters`);
      }
      if (params !== null && (typeof params !== 'object' || Array.isArray(params))) throw new TypeError('operation params must be an object or null');
      const paramsJson = params === null ? null : JSON.stringify(params);
      const createdAt = now();
      const id = Number(insert.run(kind, modemId, paramsJson, actor, createdAt).lastInsertRowid);
      const job = jobFor({ id, kind, modemId, params: paramsJson === null ? null : JSON.parse(paramsJson), actor, createdAt, interruptedAt: null }, entry, paramsJson);
      announce(job.op, 'queued');
      if (state === 'started') {
        waiting.push(job);
        schedule();
      }
      return id;
    },

    get,

    wait(id) {
      const op = get(id);
      if (!op) return Promise.reject(new Error(`no operation ${id}`));
      if (FINISHED.has(op.status)) return Promise.resolve(op);
      if (state === 'stopped' || state === 'broken') {
        return Promise.reject(new Error(`operation ${id} is ${op.status} and the operations runner is ${state}`));
      }
      return new Promise((resolve, reject) => {
        waiters.set(id, [...(waiters.get(id) ?? []), { resolve, reject }]);
      });
    },

    async stop() {
      if (state === 'new' || state === 'started') state = 'stopped';
      waiting.length = 0;
      for (const id of [...waiters.keys()]) {
        if (!running.has(id)) {
          settleWaiters(id, (waiter) => waiter.reject(new Error(`operation ${id} did not start before the operations runner stopped`)));
        }
      }
      await Promise.allSettled([...inFlight]);
    },
  };
}
