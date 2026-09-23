// @ts-check
// Retention: deletes finished operations and notifications older than settings.retention_days, a minute after start and
// then daily; unfinished rows, messages, calls and the outbox are kept.
import { FINAL } from './runner.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {{ operations: number, notifications: number }} RetentionDays  whole days, 1–36500 (registry settings.retention_days) */
/** @typedef {{ operations: number, notifications: number }} Purged  deleted rows */
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
 * Deletes the finished operations and notifications created more than their retention days before `now`.
 * @param {DatabaseSync} db
 * @param {{ days: RetentionDays, now?: number }} options
 * @returns {Purged}
 */
export function purge(db, { days, now = Date.now() }) {
  const operationDays = checkDays(days?.operations, 'operations');
  const notificationDays = checkDays(days?.notifications, 'notifications');
  db.exec('BEGIN IMMEDIATE');
  try {
    const operations = db.prepare(DELETE_OPERATIONS).run(now - operationDays * DAY_MS, ...FINAL).changes;
    const notifications = db.prepare(DELETE_NOTIFICATIONS).run(now - notificationDays * DAY_MS, ...NOTIFICATION_FINAL).changes;
    db.exec('COMMIT');
    return { operations: Number(operations), notifications: Number(notifications) };
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
      if (purged.operations > 0 || purged.notifications > 0) log.info('retention deleted old rows', { ...purged });
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
