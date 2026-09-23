// @ts-check
// Spool ingester: each `.evt` file aster-emit writes becomes its rows exactly once, then is unlinked; a malformed file is
// quarantined, and a file that hits any other error stays in place for a later scan to retry.
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, watch, writeFileSync }
  from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { applyReport } from '../sms/reports.js';
import { DecodeError, decodeFile, MAX_FILE_BYTES, REPORT_TYPES } from './decode.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('node:fs').FSWatcher} FSWatcher */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('./decode.js').SpoolEvent} SpoolEvent */
/** @typedef {import('./decode.js').CallEndData} CallEndData */
/** @typedef {import('../sms/reports.js').Report} Report */
/**
 * @typedef {object} HookContext
 * @property {DatabaseSync} db       inside the ingest transaction
 * @property {SpoolEvent} event
 * @property {number | null} rowId   id of the new messages or calls row; null for sms-report, and for a call-end whose uniqueid
 *                                   already has a calls row (no second row, so no second notification)
 */
/**
 * @typedef {object} Hooks  called inside the transaction of a new event only (never for a replay); a throw rolls the event back
 * @property {(call: CallEndData) => string} [outcome]  calls.outcome; default 'pending'
 * @property {(report: Report, ctx: HookContext) => void} [applyReport]  an sms-report event; default sms/reports.js applyReport
 * @property {(ctx: HookContext) => void} [onEvent]  after the derived row
 * @property {(ctx: HookContext) => void} [afterCommit]  after COMMIT of a new event; `db` has no
 *                                   transaction open, a throw is reported as the result's hookError and changes nothing stored
 */
/**
 * @typedef {object} IngestOptions
 * @property {string} [quarantine]   default: the quarantine directory beside the file's directory (spool/quarantine)
 * @property {Hooks} [hooks]
 * @property {() => number} [now]    epoch ms for events.received_at and the .reason file
 */
/**
 * @typedef {object} IngestResult
 * @property {'ingested' | 'replayed' | 'quarantined' | 'gone'} status  gone: the file disappeared before it was handled
 * @property {string} file           file name
 * @property {string} [id]           event id (ingested, replayed)
 * @property {string} [kind]
 * @property {string} [reason]       quarantined
 * @property {Error} [unlinkError]   stored, but the file could not be removed (a later scan replays it)
 * @property {Error} [hookError]     stored, but the afterCommit hook threw
 */
/**
 * @typedef {object} StartOptions
 * @property {string} [quarantine]   default <dir>/../quarantine
 * @property {Hooks} [hooks]
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {boolean} [watch]       watch the directory with fs.watch (default true); the periodic rescan runs either way
 * @property {number} [rescanMs]     period of the rescan (30 s)
 * @property {number} [debounceMs]   delay between a watch event and its scan (100 ms)
 * @property {number} [staleTmpMs]   age at which a .tmp is read like an .evt (10 min)
 */
/**
 * @typedef {object} ScanResult
 * @property {number} ingested
 * @property {number} replayed
 * @property {number} quarantined
 * @property {number} failed         left in place after an error; retried by a later scan
 * @property {number} skipped        not reached because the scan ended early (database or disk error, stop())
 */
/**
 * @typedef {object} Spool
 * @property {() => Promise<ScanResult>} scan  scan now; while a scan runs, one more follows it and both share its result
 * @property {() => Promise<void>} stop        no scan starts after this; resolves once the running scan has left its current file
 */

export const DEFAULTS = Object.freeze({
  rescanMs: 30_000,
  debounceMs: 100,
  staleTmpMs: 10 * 60_000,
});

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** SQLite primary result codes of the database as a whole: BUSY, LOCKED, NOMEM, READONLY, IOERR, CORRUPT, FULL, CANTOPEN, PROTOCOL, NOTADB. */
const SYSTEMIC_SQLITE = new Set([5, 6, 7, 8, 10, 11, 13, 14, 15, 26]);
/** errno codes of the disk or the process rather than of one file. */
const SYSTEMIC_ERRNO = new Set(['EIO', 'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'ENOMEM']);
const INTEGER = /^[0-9]{1,15}$/;

const INSERT_EVENT = `INSERT INTO events (id, kind, modem_id, uniqueid, emitted_at, received_at, fields_json)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`;
const SELECT_EVENT = 'SELECT kind, modem_id, uniqueid, emitted_at, fields_json FROM events WHERE id = ?';
const INSERT_MESSAGE = 'INSERT INTO messages (event_id, modem_id, sender, text, scts, received_at) VALUES (?, ?, ?, ?, ?, ?)';
const INSERT_CALL = `INSERT INTO calls (event_id, modem_id, uniqueid, caller, did, dialstatus, answered_sec, dialed_sec, disposition,
  hangupcause, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (uniqueid) DO NOTHING`;

/**
 * @param {unknown} err
 * @param {string} code
 */
const isErrno = (err, code) => /** @type {NodeJS.ErrnoException | null | undefined} */ (err)?.code === code;

/**
 * True for an error of the database or the disk as a whole, which the next file would meet as well.
 * @param {unknown} err
 */
function isSystemic(err) {
  const { code, errcode } = /** @type {{ code?: unknown, errcode?: unknown }} */ (err ?? {});
  if (code === 'ERR_SQLITE_ERROR') return typeof errcode === 'number' && SYSTEMIC_SQLITE.has(errcode & 0xff);
  return typeof code === 'string' && SYSTEMIC_ERRNO.has(code);
}

/** @param {DatabaseSync} db */
function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite has already rolled the transaction back itself (e.g. after SQLITE_FULL); the original error is rethrown.
  }
}

/** @param {string} value  '' (an empty or absent field) → null */
const nullIfEmpty = (value) => (value === '' ? null : value);
/** @param {string} value  a decimal integer (as ANSWEREDTIME, DIALEDTIME and HANGUPCAUSE are written) → number; anything else → null */
const integerOrNull = (value) => (INTEGER.test(value) ? Number(value) : null);

/**
 * The rows of a new event, inside the ingest transaction.
 * @param {DatabaseSync} db
 * @param {SpoolEvent} event
 * @param {Hooks} hooks
 * @returns {number | null} the id of the new messages or calls row (HookContext.rowId)
 */
function derive(db, event, hooks) {
  /** @type {number | null} */
  let rowId = null;
  if (event.kind === 'sms') {
    const { data } = event;
    const { lastInsertRowid } = db.prepare(INSERT_MESSAGE)
      .run(event.id, event.modem, nullIfEmpty(data.sender), data.text, nullIfEmpty(data.scts), event.emittedMs);
    rowId = Number(lastInsertRowid);
  } else if (event.kind === 'call-end') {
    const { data } = event;
    const outcome = hooks.outcome ? hooks.outcome(data) : 'pending';
    const { changes, lastInsertRowid } = db.prepare(INSERT_CALL).run(event.id, event.modem, event.uniqueid, nullIfEmpty(data.caller),
      nullIfEmpty(data.did), nullIfEmpty(data.dialstatus), integerOrNull(data.answeredtime), integerOrNull(data.dialedtime),
      nullIfEmpty(data.disposition), integerOrNull(data.hangupcause), outcome, event.emittedMs);
    rowId = Number(changes) === 1 ? Number(lastInsertRowid) : null;
  } else {
    const { data } = event;
    /** @type {Report} */
    const report = {
      payload: data.payload,
      type: REPORT_TYPES[data.type],
      success: data.success === '1' ? 1 : 0,
      scts: nullIfEmpty(data.scts),
      dt: nullIfEmpty(data.dt),
      raw: nullIfEmpty(data.report),
      source: 'spool',
      modemId: event.modem,
      at: event.emittedMs,
    };
    if (hooks.applyReport) hooks.applyReport(report, { db, event, rowId: null });
    else applyReport(db, report);
  }
  hooks.onEvent?.({ db, event, rowId });
  return rowId;
}

/**
 * Stores an event in one transaction: 'inserted' (with its rows), 'exists' (the same event is already stored) or 'conflict'
 * (its id is stored with other content). Throws after a rollback.
 * @param {DatabaseSync} db
 * @param {SpoolEvent} event
 * @param {Hooks} hooks
 * @param {number} receivedAt
 * @returns {{ result: 'inserted' | 'exists' | 'conflict', rowId: number | null }}
 */
function store(db, event, hooks, receivedAt) {
  const fieldsJson = JSON.stringify(event.data);
  db.exec('BEGIN IMMEDIATE');
  try {
    /** @type {'inserted' | 'exists' | 'conflict'} */
    let result;
    /** @type {number | null} */
    let rowId = null;
    const { changes } = db.prepare(INSERT_EVENT)
      .run(event.id, event.kind, event.modem, event.uniqueid, event.emittedMs, receivedAt, fieldsJson);
    if (Number(changes) === 1) {
      rowId = derive(db, event, hooks);
      result = 'inserted';
    } else {
      const row = db.prepare(SELECT_EVENT).get(event.id);
      if (!row) throw new Error(`events row ${event.id} was neither inserted nor found`);
      const same = row.kind === event.kind && row.modem_id === event.modem && row.uniqueid === event.uniqueid
        && row.emitted_at === event.emittedMs && row.fields_json === fieldsJson;
      result = same ? 'exists' : 'conflict';
    }
    db.exec('COMMIT');
    return { result, rowId };
  } catch (err) {
    rollback(db);
    throw err;
  }
}

/** @param {string} path */
function readEventFile(path) {
  const fd = openSync(path, 'r');
  try {
    if (fstatSync(fd).size > MAX_FILE_BYTES) throw new DecodeError(`larger than ${MAX_FILE_BYTES} bytes`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Moves a file into the quarantine directory beside <name>.reason (ISO time, a space, the reason, LF). False when the file had
 * already disappeared.
 * @param {string} path
 * @param {string} dir
 * @param {string} reason
 * @param {number} at
 */
function quarantineFile(path, dir, reason, at) {
  const name = basename(path);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const reasonFile = join(dir, `${name}.reason`);
  writeFileSync(reasonFile, `${new Date(at).toISOString()} ${reason}\n`, { mode: 0o644 });
  try {
    renameSync(path, join(dir, name));
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
    rmSync(reasonFile, { force: true });
    return false;
  }
  return true;
}

/**
 * Ingests one spool file: decode, store in one transaction, unlink. Throws, leaving the file in place, on any error other
 * than a malformed file.
 * @param {DatabaseSync} db
 * @param {string} path  spool/events/<event_id>.evt, or a stale <event_id>.tmp
 * @param {IngestOptions} [options]
 * @returns {IngestResult}
 */
export function ingestFile(db, path, { quarantine = join(dirname(dirname(path)), 'quarantine'), hooks = {}, now = Date.now } = {}) {
  const file = basename(path);
  /** @param {string} reason @returns {IngestResult} */
  const toQuarantine = (reason) =>
    (quarantineFile(path, quarantine, reason, now()) ? { status: 'quarantined', file, reason } : { status: 'gone', file });
  /** @type {SpoolEvent} */
  let event;
  try {
    event = decodeFile(readEventFile(path));
    if (file !== `${event.id}.evt` && file !== `${event.id}.tmp`) throw new DecodeError('the file name is not <event_id>.evt');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { status: 'gone', file };
    if (!(err instanceof DecodeError)) throw err;
    return toQuarantine(err.reason);
  }
  const stored = store(db, event, hooks, now());
  if (stored.result === 'conflict') return toQuarantine('the event id is already stored with different content');
  /** @type {IngestResult} */
  const result = { status: stored.result === 'inserted' ? 'ingested' : 'replayed', file, id: event.id, kind: event.kind };
  if (stored.result === 'inserted' && hooks.afterCommit) {
    try {
      hooks.afterCommit({ db, event, rowId: stored.rowId });
    } catch (err) {
      result.hookError = err instanceof Error ? err : new Error(String(err));
    }
  }
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) result.unlinkError = /** @type {Error} */ (err);
  }
  return result;
}

/**
 * The files a scan handles, in name order: every regular `*.evt` file, and every regular `*.tmp` file at least staleTmpMs old.
 * A missing directory is created (by the controller's user, which must be able to remove the files).
 * @param {string} dir
 * @param {number} staleTmpMs
 * @param {number} nowMs
 * @returns {string[]}
 */
function listFiles(dir, staleTmpMs, nowMs) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    return [];
  }
  /** @type {string[]} */
  const names = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.evt')) {
      names.push(entry.name);
    } else if (entry.name.endsWith('.tmp')) {
      try {
        if (nowMs - lstatSync(join(dir, entry.name)).mtimeMs >= staleTmpMs) names.push(entry.name);
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) throw err; // aster-emit renamed it meanwhile
      }
    }
  }
  return names.sort();
}

/**
 * Starts ingesting a spool events directory (created if missing): a scan now, after watch events and every rescanMs.
 * @param {DatabaseSync} db
 * @param {string} dir  spool/events
 * @param {StartOptions} [options]
 * @returns {Spool}
 */
export function start(db, dir, options = {}) {
  const { quarantine = join(dirname(dir), 'quarantine'), hooks = {}, log = SILENT, now = Date.now, watch: watching = true, ...timing } = options;
  const { rescanMs, debounceMs, staleTmpMs } = { ...DEFAULTS, ...timing };
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  /** @param {unknown} err */
  const errorText = (err) => (err instanceof Error ? err.message : String(err));
  /** The last error logged for each file left in place by an error other than a database/disk one. @type {Map<string, string>} */
  const problems = new Map();
  /** The last database or disk error logged; null again once a file is handled. @type {string | null} */
  let systemic = null;
  /** Files stored but not removable, already logged. @type {Set<string>} */
  const unremovable = new Set();
  /** @type {Promise<ScanResult> | null} */
  let running = null;
  let again = false;
  let stopped = false;
  /** @type {FSWatcher | null} */
  let watcher = null;
  /** @type {NodeJS.Timeout | null} */
  let debounce = null;

  function watchDir() {
    if (!watching || watcher || stopped) return;
    try {
      const current = watch(dir, () => schedule());
      current.on('error', (err) => {
        log.warn('spool watch failed; the periodic rescan continues', { dir, err });
        current.close();
        if (watcher === current) watcher = null;
      });
      watcher = current;
    } catch (err) {
      log.warn('cannot watch the spool directory; the periodic rescan continues', { dir, err });
    }
  }

  function schedule() {
    if (stopped || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void scan();
    }, debounceMs);
  }

  /**
   * @param {IngestResult} outcome
   * @param {ScanResult} result
   */
  function count(outcome, result) {
    if (outcome.status === 'ingested') {
      result.ingested += 1;
      log.info('spool event ingested', { id: outcome.id, kind: outcome.kind });
    } else if (outcome.status === 'replayed') {
      result.replayed += 1;
      log.info('spool event was already stored', { id: outcome.id });
    } else if (outcome.status === 'quarantined') {
      result.quarantined += 1;
      log.warn('spool file quarantined', { file: outcome.file, reason: outcome.reason });
    }
    if (outcome.hookError) log.error('spool event stored, but its afterCommit hook failed', { id: outcome.id, err: outcome.hookError });
    if (!outcome.unlinkError) {
      unremovable.delete(outcome.file);
    } else if (!unremovable.has(outcome.file)) {
      unremovable.add(outcome.file);
      log.error('spool event stored but its file cannot be removed; later scans replay it', { file: outcome.file, err: outcome.unlinkError });
    }
  }

  /**
   * A file left in place by an error other than a database/disk one; logged unless its last logged error was the same.
   * @param {string} name
   * @param {unknown} err
   * @param {ScanResult} result
   */
  function failed(name, err, result) {
    result.failed += 1;
    const message = errorText(err);
    if (problems.get(name) === message) return;
    problems.set(name, message);
    log.error('spool ingest failed; the file stays and later scans retry it', { file: name, err });
  }

  /** @param {ScanResult} result */
  async function scanOnce(result) {
    let names;
    try {
      names = listFiles(dir, staleTmpMs, now());
    } catch (err) {
      log.error('spool scan failed', { dir, err });
      return;
    }
    watchDir();
    const present = new Set(names);
    for (const name of problems.keys()) if (!present.has(name)) problems.delete(name);
    for (const name of unremovable) if (!present.has(name)) unremovable.delete(name);
    for (const [index, name] of names.entries()) {
      if (stopped) {
        result.skipped += names.length - index;
        return;
      }
      try {
        count(ingestFile(db, join(dir, name), { quarantine, hooks, now }), result);
        if (problems.delete(name)) log.info('spool file handled after earlier failures', { file: name });
        if (systemic !== null) {
          systemic = null;
          log.info('spool ingest works again');
        }
      } catch (err) {
        if (isSystemic(err)) {
          result.failed += 1;
          result.skipped += names.length - index - 1;
          const message = errorText(err);
          if (systemic !== message) {
            systemic = message;
            log.error('spool ingest failed; the scan stops until the next one', { file: name, err });
          }
          return;
        }
        failed(name, err, result);
      }
      await nextTurn();
    }
  }

  /** @returns {Promise<ScanResult>} */
  function scan() {
    if (running) {
      again = true;
      return running;
    }
    if (stopped) return Promise.resolve({ ingested: 0, replayed: 0, quarantined: 0, failed: 0, skipped: 0 });
    running = (async () => {
      /** @type {ScanResult} */
      const result = { ingested: 0, replayed: 0, quarantined: 0, failed: 0, skipped: 0 };
      try {
        do {
          again = false;
          await scanOnce(result);
        } while (again && !stopped);
      } catch (err) {
        log.error('spool scan failed', { dir, err });
      } finally {
        running = null;
      }
      return result;
    })();
    return running;
  }

  const timer = setInterval(() => void scan(), rescanMs);
  watchDir();
  void scan();

  return {
    scan,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      debounce = null;
      watcher?.close();
      watcher = null;
      if (running) await running;
    },
  };
}
