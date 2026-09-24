// @ts-check
// Retention: deletes operations, notifications, SMS and calls older than settings.retention_days, a minute after start and
// then daily; unfinished operations and notifications and SMS still being sent are kept.
import { REMOVABLE } from '../sms/outbox.js';
import { ORPHAN_CALL_EVENTS, ORPHAN_SMS_EVENTS } from '../store/orphans.js';
import { FINAL } from './runner.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {{ operations: number, notifications: number, messages: number, calls: number }} RetentionDays  whole days, 1–36500 (registry settings.retention_days) */
/** @typedef {{ operations: number, notifications: number, messages: number, calls: number }} Purged  deleted rows; messages: received and sent SMS */
/**
 * @typedef {object} RetentionOptions
 * @property {() => RetentionDays} days  read at every run
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {number} [delayMs]     first run after startRetention() (1 min)
 * @property {number} [intervalMs]  between runs (24 h)
 */

export const DAY_MS = 86_400_000;
export const DEFAULTS = Object.freeze({ delayMs: 60_000, intervalMs: DAY_MS });
/** Final notification statuses; pending, sending and retry rows are kept. */
export const NOTIFICATION_FINAL = Object.freeze(['sent', 'failed']);

const placeholders = (/** @type {readonly string[]} */ values) => values.map(() => '?').join(', ');
const DELETE_OPERATIONS = `DELETE FROM operations WHERE created_at < ? AND status IN (${placeholders(FINAL)})`;
const DELETE_NOTIFICATIONS = `DELETE FROM notifications WHERE created_at < ? AND status IN (${placeholders(NOTIFICATION_FINAL)})`;
const DELETE_RECEIVED = 'DELETE FROM messages WHERE received_at < ?';
const DELETE_SENT = `DELETE FROM sms_outbox WHERE created_at < ? AND status IN (${placeholders(REMOVABLE)})`;
/** Delivery reports are part of the SMS history; nothing reads them once they are applied. */
const DELETE_REPORTS = "DELETE FROM events WHERE kind = 'sms-report' AND emitted_at < ?";
const DELETE_CALLS = 'DELETE FROM calls WHERE ended_at < ?';

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * @param {unknown} value
 * @param {string} name
 */
function checkDays(value, name) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 36500) {
    throw new RangeError(`retention_days.${name} must be a whole number of days from 1 to 36500, not ${String(value)}`);
  }
  return Number(value);
}

/**
 * Deletes the rows of each kind that are more than its retention days older than `now`, with the spool events of deleted SMS
 * and calls.
 * @param {DatabaseSync} db
 * @param {{ days: RetentionDays, now?: number }} options
 * @returns {Purged}
 */
export function purge(db, { days, now = Date.now() }) {
  const cutoff = (/** @type {keyof RetentionDays} */ name) => now - checkDays(days?.[name], name) * DAY_MS;
  const before = { operations: cutoff('operations'), notifications: cutoff('notifications'), messages: cutoff('messages'), calls: cutoff('calls') };
  /** @param {string} sql @param {...number | string} params */
  const run = (sql, ...params) => Number(db.prepare(sql).run(...params).changes);
  db.exec('BEGIN IMMEDIATE');
  try {
    const operations = run(DELETE_OPERATIONS, before.operations, ...FINAL);
    const notifications = run(DELETE_NOTIFICATIONS, before.notifications, ...NOTIFICATION_FINAL);
    const received = run(DELETE_RECEIVED, before.messages);
    if (received > 0) run(ORPHAN_SMS_EVENTS);
    const sent = run(DELETE_SENT, before.messages, ...REMOVABLE);
    run(DELETE_REPORTS, before.messages);
    const calls = run(DELETE_CALLS, before.calls);
    if (calls > 0) run(ORPHAN_CALL_EVENTS);
    db.exec('COMMIT');
    return { operations, notifications, messages: received + sent, calls };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite has already rolled the transaction back; the original error is rethrown.
    }
    throw err;
  }
}

/**
 * @param {DatabaseSync} db
 * @param {RetentionOptions} options
 * @returns {{ run: () => Purged | null, stop: () => void }}  run: purge now (null after an error or stop())
 */
export function startRetention(db, { days, log = SILENT, now = Date.now, ...timing }) {
  const { delayMs, intervalMs } = { ...DEFAULTS, ...timing };
  let stopped = false;
  /** @type {NodeJS.Timeout | null} */
  let interval = null;

  function run() {
    if (stopped) return null;
    try {
      const purged = purge(db, { days: days(), now: now() });
      if (Object.values(purged).some((count) => count > 0)) log.info('retention deleted old rows', { ...purged });
      else log.debug('retention found nothing to delete');
      return purged;
    } catch (err) {
      log.error('retention failed; the next run tries again', { err });
      return null;
    }
  }

  const first = setTimeout(() => {
    run();
    if (stopped) return;
    interval = setInterval(run, intervalMs);
    interval.unref();
  }, delayMs);
  first.unref();

  return {
    run,
    stop() {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
