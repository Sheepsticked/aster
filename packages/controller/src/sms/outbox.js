// @ts-check
// Outbound SMS: send() queues an sms_outbox row with an `sms-send` operation that submits it through the driver's
// SendSMS; status reports then move the attempt on (sms/reports.js), and silent attempts turn `uncertain` after validity + grace.
import { AmiError, MAX_LINE_BYTES } from '../ami/client.js';
import { ACTORS, OperationError } from '../ops/runner.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../ami/parser.js').Packet} Packet */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('../ops/runner.js').Actor} Actor */
/** @typedef {import('./reports.js').Attempt} Attempt */
/** @typedef {import('./reports.js').AttemptStatus} AttemptStatus */
/** @typedef {'quectel' | 'dongle'} Driver */
/** @typedef {'queued' | AttemptStatus} OutboxStatus */
/**
 * @typedef {object} OutboxRow  an sms_outbox row
 * @property {number} id
 * @property {string} modem_id
 * @property {string} number
 * @property {string} text
 * @property {OutboxStatus} status
 * @property {number} attempt_no   the current attempt (0 before the first)
 * @property {number} created_at
 * @property {number} updated_at
 * @property {string | null} last_error
 */
/**
 * @typedef {object} Timing
 * @property {number} actionTimeoutMs  the SendSMS action (30 s)
 * @property {number} validityMs       the Validity given to the driver, in ms (180 min; sent as whole minutes)
 * @property {number} graceMs          how long after the validity a report is still awaited (10 min)
 * @property {number} sweepMs          period of the expiry check (60 s)
 */
/**
 * @typedef {object} Options
 * @property {DatabaseSync} db
 * @property {() => Registry | null} registry  the registry now; null while it cannot be loaded
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {Partial<Timing>} [timing]
 */
/** @typedef {{ id: number, operationId: number, attemptNo: number }} Queued  attemptNo: the attempt the operation will create */
/** @typedef {'invalid' | 'not-found' | 'confirm-required' | 'not-retryable' | 'not-removable' | 'unavailable'} ErrorCode */

export const KIND = 'sms-send';
export const VALIDITY_MINUTES = 180;
export const DEFAULTS = Object.freeze({ actionTimeoutMs: 30_000, validityMs: VALIDITY_MINUTES * 60_000, graceMs: 10 * 60_000, sweepMs: 60_000 });
/** A destination both drivers accept (helpers.c is_valid_phone_number: an optional `+`, then digits). */
export const NUMBER = /^\+?[0-9]{2,20}$/;
/** The escaped text must fit one AMI header line with `Message: ` and its CRLF. */
export const MAX_TEXT_BYTES = MAX_LINE_BYTES - 2 - 'Message: '.length;
export const RETRY_FREELY = Object.freeze(/** @type {const} */ (['failed']));
export const RETRY_WITH_CONFIRM = Object.freeze(/** @type {const} */ (['uncertain', 'rejected', 'undelivered', 'undelivered_expired']));
export const RESTARTED = 'the controller restarted while the SMS was being submitted; whether the driver received it is unknown';
/** What purge() deletes: the statuses a sending ended in without success. */
export const UNSUCCESSFUL = Object.freeze(/** @type {const} */ ([...RETRY_FREELY, ...RETRY_WITH_CONFIRM]));
/** What remove() deletes: every status a sending ended in. */
export const REMOVABLE = Object.freeze(/** @type {const} */ (['delivered', ...UNSUCCESSFUL]));

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @type {Set<string>} */
const ACTOR = new Set(ACTORS);
/** Control characters the header value cannot carry: everything below space except LF, CR and TAB (escaped), and DEL. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
/** What Asterisk skips at the start of a header value (ast_skip_blanks: every byte up to and including space). */
const LEADING_BLANKS = /^[\x00-\x20]+/;

const INSERT_OUTBOX = "INSERT INTO sms_outbox (modem_id, number, text, status, attempt_no, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?)";
const SELECT_OUTBOX = 'SELECT * FROM sms_outbox WHERE id = ?';
const SELECT_ATTEMPTS = 'SELECT * FROM sms_attempts WHERE outbox_id = ? ORDER BY attempt_no';
const REQUEUE = "UPDATE sms_outbox SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ? AND status = ?";
const INSERT_ATTEMPT = "INSERT INTO sms_attempts (outbox_id, attempt_no, submitted_at, status) VALUES (?, ?, ?, 'submitting')";
const START_ATTEMPT = "UPDATE sms_outbox SET status = 'submitting', attempt_no = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'";
const FAIL_QUEUED = "UPDATE sms_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'queued'";
/** The send's outcome; a report that arrived first keeps the status it gave (the reply text is stored either way). */
const SETTLE_ATTEMPT = "UPDATE sms_attempts SET ami_result = ?, status = CASE WHEN status = 'submitting' THEN ? ELSE status END WHERE outbox_id = ? AND attempt_no = ?";
const SETTLE_OUTBOX = "UPDATE sms_outbox SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND attempt_no = ? AND status = 'submitting'";
const SELECT_ATTEMPT = 'SELECT * FROM sms_attempts WHERE outbox_id = ? AND attempt_no = ?';
const INTERRUPTED = "UPDATE sms_attempts SET status = 'uncertain' WHERE status = 'submitting' RETURNING outbox_id, attempt_no";
const INTERRUPTED_ONE = "UPDATE sms_attempts SET status = 'uncertain' WHERE outbox_id = ? AND attempt_no = ? AND status = 'submitting'";
/** A `submitted` attempt has no report column (a report always moves the status), so the status alone selects the silent ones. */
const EXPIRED = "UPDATE sms_attempts SET status = 'uncertain' WHERE status = 'submitted' AND submitted_at <= ? RETURNING outbox_id, attempt_no";
const UNCERTAIN_OUTBOX = "UPDATE sms_outbox SET status = 'uncertain', last_error = ?, updated_at = ? WHERE id = ? AND attempt_no = ? AND status = ?";
const statusIn = (/** @type {readonly string[]} */ statuses) => `status IN (${statuses.map((status) => `'${status}'`).join(', ')})`;
const DELETE_ONE = `DELETE FROM sms_outbox WHERE id = ? AND ${statusIn(REMOVABLE)}`;
const DELETE_ALL = `DELETE FROM sms_outbox WHERE ${statusIn(UNSUCCESSFUL)} RETURNING id`;
const DELETE_MODEM = `DELETE FROM sms_outbox WHERE modem_id = ? AND ${statusIn(UNSUCCESSFUL)} RETURNING id`;

/** A refused send or retry; `code` tells the API which status to answer. */
export class OutboxError extends Error {
  /**
   * @param {string} message
   * @param {ErrorCode} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'OutboxError';
    this.code = code;
  }
}

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {Driver} driver */
const prefix = (driver) => (driver === 'quectel' ? 'Quectel' : 'Dongle');

/** @param {DatabaseSync} db */
function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite has already rolled the transaction back; the original error is rethrown.
  }
}

/**
 * Resolves once the client is up, or after `ms`; true when it is up.
 * @param {AmiClient} ami
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
function awaitUp(ami, ms) {
  if (ami.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onUp = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      ami.off('up', onUp);
      resolve(ami.connected);
    }, ms);
    ami.once('up', onUp);
  });
}

/**
 * The text as the Message header carries it: the four escapes ast_unescape_c reverses (main/utils.c), so the driver sends the text
 * as given.
 * @param {string} text
 */
export function escapeMessage(text) {
  return text.replace(/[\\\n\r\t]/g, (char) => (char === '\\' ? '\\\\' : char === '\n' ? '\\n' : char === '\r' ? '\\r' : '\\t'));
}

/**
 * The number to send to; throws OutboxError for anything the drivers refuse.
 * @param {unknown} number
 * @returns {string}
 */
export function checkNumber(number) {
  if (typeof number !== 'string' || !NUMBER.test(number)) {
    throw new OutboxError('the number must be 2 to 20 digits with an optional leading + (no spaces, * or #)', 'invalid');
  }
  return number;
}

/**
 * The text to send: leading blanks dropped; then not empty, well-formed Unicode, no control characters other than LF, CR and TAB,
 * and at most MAX_TEXT_BYTES once escaped. Throws OutboxError otherwise.
 * @param {unknown} text
 * @returns {string}
 */
export function checkText(text) {
  if (typeof text !== 'string') throw new OutboxError('the text must be a string', 'invalid');
  const trimmed = text.replace(LEADING_BLANKS, '');
  if (trimmed === '') throw new OutboxError('the text is empty', 'invalid');
  // a lone surrogate becomes U+FFFD in UTF-8, so the text would arrive changed (and the driver's iconv may refuse it)
  if (Buffer.from(trimmed, 'utf8').toString('utf8') !== trimmed) throw new OutboxError('the text is not well-formed Unicode (a lone surrogate)', 'invalid');
  if (CONTROL.test(trimmed)) throw new OutboxError('the text contains a control character other than line feed, carriage return or tab', 'invalid');
  const bytes = Buffer.byteLength(escapeMessage(trimmed));
  if (bytes > MAX_TEXT_BYTES) throw new OutboxError(`the text is ${bytes} bytes of UTF-8 (escaped); at most ${MAX_TEXT_BYTES} fit an AMI request`, 'invalid');
  return trimmed;
}

/**
 * @param {Options} options
 */
export function createOutbox({ db, registry, log = SILENT, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };
  const validityMinutes = Math.max(1, Math.round(t.validityMs / 60_000));
  /** @type {Runner | null} */
  let runner = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** @param {string} message @param {Record<string, unknown>} [result] */
  const failed = (message, result) => new OperationError(message, { status: 'failed', result: result ? { ...result, observed_at: now() } : undefined });
  /** @param {string} message @param {Record<string, unknown>} [result] */
  const uncertain = (message, result) => new OperationError(message, { status: 'uncertain', result: result ? { ...result, observed_at: now() } : undefined });

  /** @param {number} id @returns {OutboxRow | null} */
  const row = (id) => /** @type {OutboxRow | null} */ (db.prepare(SELECT_OUTBOX).get(id) ?? null);

  /**
   * The registry modem to send through; OutboxError when it is unknown or the registry cannot be loaded.
   * @param {unknown} modemId
   */
  function modemOf(modemId) {
    if (typeof modemId !== 'string' || modemId === '') throw new OutboxError('the modem id must be a non-empty string', 'invalid');
    const reg = registry();
    if (!reg) throw new OutboxError('the registry cannot be loaded, so the modem is unknown; fix config/aster.yaml first', 'unavailable');
    const modem = reg.modems.find((entry) => entry.id === modemId);
    if (!modem) throw new OutboxError(`modem ${modemId} is not in the registry`, 'invalid');
    return modem;
  }

  /** @param {unknown} actor @returns {Actor} */
  function checkActor(actor) {
    if (typeof actor !== 'string' || !ACTOR.has(actor)) throw new OutboxError(`the actor is admin, cli or system, not ${JSON.stringify(actor)}`, 'invalid');
    return /** @type {Actor} */ (actor);
  }

  /** @param {Actor} actor @param {string} modemId @param {number} id */
  function enqueue(actor, modemId, id) {
    if (!runner) throw new Error('the outbox is not registered with the operations runner');
    return runner.enqueue({ kind: KIND, modemId, params: { outbox_id: id }, actor });
  }

  /**
   * Marks an attempt and, while it is the row's current one, the row `uncertain`.
   * @param {number} id
   * @param {number} attemptNo
   * @param {string} why
   * @param {'submitting' | 'submitted'} from  the row status the mark replaces
   */
  function markUncertain(id, attemptNo, why, from) {
    db.prepare(INTERRUPTED_ONE).run(id, attemptNo);
    db.prepare(UNCERTAIN_OUTBOX).run(why, now(), id, attemptNo, from);
  }

  /**
   * Settles the attempt after the SendSMS action and returns the attempt as stored (a report may have moved it on already).
   * @param {number} id
   * @param {number} attemptNo
   * @param {AttemptStatus} status
   * @param {string | null} reply
   * @param {string | null} error
   */
  function settle(id, attemptNo, status, reply, error) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(SETTLE_ATTEMPT).run(reply, status, id, attemptNo);
      const attempt = /** @type {Attempt} */ (db.prepare(SELECT_ATTEMPT).get(id, attemptNo));
      db.prepare(SETTLE_OUTBOX).run(attempt.status, attempt.status === status ? error : null, now(), id, attemptNo);
      db.exec('COMMIT');
      return attempt;
    } catch (err) {
      rollback(db);
      throw err;
    }
  }

  /** @param {Context} ctx */
  function outboxIdOf(ctx) {
    const id = ctx.op.params?.outbox_id;
    if (!Number.isSafeInteger(id) || Number(id) < 1) throw failed(`sms-send needs params.outbox_id, not ${JSON.stringify(id)}`);
    return Number(id);
  }

  /** @param {OutboxRow} entry @param {Record<string, unknown>} [more] */
  const resultOf = (entry, more = {}) => ({ outbox_id: entry.id, attempt_no: entry.attempt_no, modem_id: entry.modem_id, number: entry.number, status: entry.status, ...more });

  /**
   * The `sms-send` operation: Success → `submitted`, Error → `failed`, no response → `uncertain`.
   * @param {Context} ctx
   * @returns {Promise<Record<string, unknown>>}
   */
  async function handler(ctx) {
    const id = outboxIdOf(ctx);
    const entry = row(id);
    if (!entry) throw failed(`outbox ${id} does not exist; nothing was sent`);
    if (entry.status !== 'queued') throw failed(`outbox ${id} is ${entry.status}, not queued; nothing was sent`, resultOf(entry));
    /** @type {Driver} */
    let driver;
    try {
      driver = modemOf(entry.modem_id).driver;
    } catch (err) {
      const message = `${errorText(err)}; the SMS was not sent`;
      db.prepare(FAIL_QUEUED).run(message, now(), id);
      throw failed(message, resultOf(entry, { status: 'failed' }));
    }
    const attemptNo = entry.attempt_no + 1;
    const at = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(INSERT_ATTEMPT).run(id, attemptNo, at);
      if (Number(db.prepare(START_ATTEMPT).run(attemptNo, at, id).changes) !== 1) throw new Error(`outbox ${id} changed while the attempt was being created`);
      db.exec('COMMIT');
    } catch (err) {
      rollback(db);
      throw err;
    }
    const action = `${prefix(driver)}SendSMS`;
    const result = { outbox_id: id, attempt_no: attemptNo, modem_id: entry.modem_id, driver, action, number: entry.number, reply: null, status: 'submitting' };
    const { ami } = ctx;
    if (ami && !ami.connected) {
      ctx.progress('waiting for the AMI connection');
      await awaitUp(ami, t.actionTimeoutMs);
    }
    if (!ami || !ami.connected) {
      const why = !ami ? 'the controller has no AMI connection to Asterisk' : `Asterisk is not connected over AMI (${ami.lastError ? errorText(ami.lastError) : ami.state})`;
      const message = `${why}; the SMS was not sent`;
      settle(id, attemptNo, 'failed', null, message);
      throw failed(message, { ...result, status: 'failed' });
    }
    ctx.progress(action);
    /** @type {Packet} */
    let reply;
    try {
      reply = await ami.action(action, {
        Device: entry.modem_id, Number: entry.number, Message: escapeMessage(entry.text), Validity: validityMinutes, Report: 1, Payload: `${id}:${attemptNo}`,
      }, { timeout: t.actionTimeoutMs });
    } catch (err) {
      const message = errorText(err);
      if (err instanceof AmiError) {
        settle(id, attemptNo, 'failed', message, message);
        log.warn('SMS refused by the driver', { outbox: id, attempt: attemptNo, modem: entry.modem_id, action, error: message });
        throw failed(`${action} ${entry.modem_id}: ${message}`, { ...result, reply: message, status: 'failed' });
      }
      const why = `${action} ${entry.modem_id}: ${message}; whether the driver received the SMS is unknown`;
      settle(id, attemptNo, 'uncertain', null, why);
      throw uncertain(why, { ...result, status: 'uncertain' });
    }
    const message = reply.get('Message');
    const text = Array.isArray(message) ? message.join(' ') : message ?? null;
    const attempt = settle(id, attemptNo, 'submitted', text, null);
    log.info('SMS submitted', { outbox: id, attempt: attemptNo, modem: entry.modem_id, action, reply: text, status: attempt.status });
    return { ...result, reply: text, status: attempt.status, observed_at: now() };
  }

  /**
   * An interrupted `sms-send` after a restart: the row says how far it got.
   * @param {Context} ctx
   */
  async function reevaluate(ctx) {
    const id = outboxIdOf(ctx);
    const entry = row(id);
    if (!entry) throw failed(`outbox ${id} does not exist`);
    if (entry.status === 'queued') return handler(ctx);
    if (entry.status === 'submitting') {
      markUncertain(id, entry.attempt_no, RESTARTED, 'submitting');
      throw uncertain(RESTARTED, resultOf(entry, { status: 'uncertain' }));
    }
    if (entry.status === 'failed') throw failed(entry.last_error ?? 'the SMS was not sent', resultOf(entry));
    if (entry.status === 'uncertain') throw uncertain(entry.last_error ?? RESTARTED, resultOf(entry));
    return { ...resultOf(entry), observed_at: now() };
  }

  /**
   * start()'s sweep and the periodic one: attempts left `submitting` (a restart mid-flight) and attempts `submitted` without any
   * report for validity + grace → `uncertain`.
   * @param {boolean} boot
   */
  function sweep(boot) {
    const at = now();
    let interrupted = 0;
    let expired = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (boot) {
        for (const found of db.prepare(INTERRUPTED).all()) {
          db.prepare(UNCERTAIN_OUTBOX).run(RESTARTED, at, Number(found.outbox_id), Number(found.attempt_no), 'submitting');
          interrupted += 1;
        }
      }
      const minutes = Math.round((t.validityMs + t.graceMs) / 60_000);
      const why = `no report within ${minutes} min of the submission (validity ${validityMinutes} min); the driver no longer tracks the SMS`;
      for (const found of db.prepare(EXPIRED).all(at - t.validityMs - t.graceMs)) {
        db.prepare(UNCERTAIN_OUTBOX).run(why, at, Number(found.outbox_id), Number(found.attempt_no), 'submitted');
        expired += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      rollback(db);
      throw err;
    }
    if (interrupted > 0) log.warn('SMS attempts interrupted by the restart are uncertain', { attempts: interrupted });
    if (expired > 0) log.warn('SMS attempts without any report after the validity are uncertain', { attempts: expired });
    return { interrupted, expired };
  }

  return {
    handlers: Object.freeze({ [KIND]: handler }),
    /** Registers `sms-send` on the modem queue; an interrupted one is re-evaluated from its row. @param {Runner} target */
    register(target) {
      target.register(KIND, handler, { reevaluate });
      runner = target;
    },

    /**
     * Stores the SMS `queued` with its `sms-send` operation; OutboxError for an invalid request.
     * @param {{ modemId: string, number: string, text: string, actor: Actor }} request
     * @returns {Queued}
     */
    send({ modemId, number, text, actor }) {
      const modem = modemOf(modemId);
      const to = checkNumber(number);
      const body = checkText(text);
      const by = checkActor(actor);
      const at = now();
      const own = !db.isTransaction;
      if (own) db.exec('BEGIN IMMEDIATE');
      try {
        const id = Number(db.prepare(INSERT_OUTBOX).run(modem.id, to, body, at, at).lastInsertRowid);
        const operationId = enqueue(by, modem.id, id);
        if (own) db.exec('COMMIT');
        log.info('SMS queued', { outbox: id, modem: modem.id, op: operationId, actor: by });
        return { id, operationId, attemptNo: 1 };
      } catch (err) {
        if (own) rollback(db);
        throw err;
      }
    },

    /**
     * Queues attempt n+1 of a stored SMS (`failed` freely, other unsuccessful statuses only with confirm); OutboxError when
     * the row is missing, not retryable, or needs confirm.
     * @param {number} id
     * @param {{ confirm?: boolean, actor: Actor }} options
     * @returns {Queued}
     */
    retry(id, { confirm = false, actor }) {
      const by = checkActor(actor);
      const entry = row(id);
      if (!entry) throw new OutboxError(`no outbox SMS ${id}`, 'not-found');
      const { status } = entry;
      if (RETRY_WITH_CONFIRM.includes(/** @type {any} */ (status))) {
        if (confirm !== true) throw new OutboxError(`SMS ${id} is ${status}: it may have reached the recipient, so a retry needs confirm`, 'confirm-required');
      } else if (!RETRY_FREELY.includes(/** @type {any} */ (status))) {
        throw new OutboxError(`SMS ${id} is ${status}; only a failed, uncertain, rejected or undelivered SMS can be retried`, 'not-retryable');
      }
      const modem = modemOf(entry.modem_id);
      const at = now();
      const own = !db.isTransaction;
      if (own) db.exec('BEGIN IMMEDIATE');
      try {
        if (Number(db.prepare(REQUEUE).run(at, id, status).changes) !== 1) throw new OutboxError(`SMS ${id} changed meanwhile; look at it again`, 'not-retryable');
        const operationId = enqueue(by, modem.id, id);
        if (own) db.exec('COMMIT');
        log.info('SMS retry queued', { outbox: id, attempt: entry.attempt_no + 1, from: status, modem: modem.id, op: operationId, actor: by });
        return { id, operationId, attemptNo: entry.attempt_no + 1 };
      } catch (err) {
        if (own) rollback(db);
        throw err;
      }
    },

    /**
     * Deletes one SMS whose sending has ended, with its attempts; OutboxError when the row is missing or still
     * being sent.
     * @param {number} id
     * @param {{ actor: Actor }} options
     * @returns {{ id: number, status: OutboxStatus }}  the status it had
     */
    remove(id, { actor }) {
      const by = checkActor(actor);
      const entry = row(id);
      if (!entry) throw new OutboxError(`no outbox SMS ${id}`, 'not-found');
      if (!REMOVABLE.includes(/** @type {any} */ (entry.status))) {
        throw new OutboxError(`SMS ${id} is ${entry.status}; an SMS still being sent cannot be deleted`, 'not-removable');
      }
      if (Number(db.prepare(DELETE_ONE).run(id).changes) !== 1) throw new OutboxError(`SMS ${id} changed meanwhile; look at it again`, 'not-removable');
      log.info('SMS deleted', { outbox: id, status: entry.status, modem: entry.modem_id, actor: by });
      return { id, status: entry.status };
    },

    /**
     * Deletes every SMS whose sending ended without success — of one modem when modemId is given, which need not be in the
     * registry any more — with their attempts.
     * @param {{ modemId?: string, actor: Actor }} options
     * @returns {{ deleted: number }}
     */
    purge({ modemId, actor }) {
      const by = checkActor(actor);
      if (modemId !== undefined && (typeof modemId !== 'string' || modemId === '')) throw new OutboxError('the modem id must be a non-empty string', 'invalid');
      const gone = modemId === undefined ? db.prepare(DELETE_ALL).all() : db.prepare(DELETE_MODEM).all(modemId);
      if (gone.length > 0) log.info('SMS without success deleted', { count: gone.length, modem: modemId ?? null, actor: by });
      return { deleted: gone.length };
    },

    /**
     * The row with its attempts, or null.
     * @param {number} id
     * @returns {(OutboxRow & { attempts: Attempt[] }) | null}
     */
    get(id) {
      const entry = row(id);
      if (!entry) return null;
      return { ...entry, attempts: /** @type {Attempt[]} */ (db.prepare(SELECT_ATTEMPTS).all(id).map((attempt) => ({ ...attempt }))) };
    },

    /** The boot sweep now, then the expiry check every sweepMs. */
    start() {
      if (timer) throw new Error('the outbox is already started');
      const summary = sweep(true);
      timer = setInterval(() => {
        try {
          sweep(false);
        } catch (err) {
          log.error('outbox sweep failed', { err });
        }
      }, t.sweepMs);
      timer.unref(); // a background check never keeps the process alive on its own
      return summary;
    },

    /** The expiry check now (tests). */
    sweep: () => sweep(false),

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
