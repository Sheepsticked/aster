// @ts-check
// Opt-in Telegram alerts: a modem `absent` or `no-network` for a while, or AMI down for a while, raises one alert and later
// one recovery. Active alerts are stored with their notifications so a restart neither repeats nor forgets them.
import { hostname } from 'node:os';
import { enqueue } from './queue.js';
import { amiAlertText, amiRecoveredText, modemAlertText, modemRecoveredText } from './texts.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../bus.js').Bus} Bus */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {{ readonly connected: boolean }} AmiState  the part of the AMI client the alerts read */
/**
 * @typedef {object} Timing
 * @property {number} checkMs  period of the check (5 s)
 * @property {number} modemMs  how long a modem is absent or without network before it alerts (5 min)
 * @property {number} amiMs    how long AMI is not up before it alerts (2 min)
 */
/**
 * @typedef {object} AlertOptions
 * @property {DatabaseSync} db
 * @property {Bus} bus
 * @property {AmiState | null} ami  null: the controller runs without AMI, so there is no Asterisk alert
 * @property {() => Registry | null} registry  the registry now; null while it cannot be loaded (the check then waits)
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {() => string} [host]  the host name that starts each text (default: this machine's)
 * @property {Partial<Timing>} [timing]
 */
/** @typedef {{ ami: { since: number } | null, modems: Record<string, { state: string, since: number }> }} Active  settings.alerts_active */
/** @typedef {{ alerts: string[], recoveries: string[], skipped: string | null }} CheckResult  alert keys: `ami` or the modem id */

export const DEFAULTS = Object.freeze({ checkMs: 5_000, modemMs: 5 * 60_000, amiMs: 2 * 60_000 });
/** Modem UI states that alert once they last modemMs. */
export const ALERT_STATES = Object.freeze(/** @type {const} */ (['absent', 'no-network']));
export const SETTINGS_KEY = 'alerts_active';

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @type {ReadonlySet<string>} */
const PROBLEM = new Set(ALERT_STATES);
const SELECT_ACTIVE = 'SELECT value FROM settings WHERE key = ?';
const UPSERT_ACTIVE = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';

/**
 * The stored active alerts; nothing active when the row is missing or unreadable.
 * @param {DatabaseSync} db
 * @param {Logger} log
 * @returns {Active}
 */
function loadActive(db, log) {
  const row = db.prepare(SELECT_ACTIVE).get(SETTINGS_KEY);
  if (!row) return { ami: null, modems: {} };
  try {
    const value = JSON.parse(String(row.value));
    const ami = value?.ami && Number.isFinite(value.ami.since) ? { since: Number(value.ami.since) } : null;
    /** @type {Active['modems']} */
    const modems = {};
    for (const [id, entry] of Object.entries(value?.modems ?? {})) {
      if (entry && typeof entry.state === 'string' && Number.isFinite(entry.since)) modems[id] = { state: entry.state, since: Number(entry.since) };
    }
    return { ami, modems };
  } catch (err) {
    log.warn('the stored active alerts cannot be read; starting without any', { err });
    return { ami: null, modems: {} };
  }
}

/**
 * @param {AlertOptions} options
 */
export function createAlerts({ db, bus, ami, registry, log = SILENT, now = Date.now, host = hostname, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };
  /** The last published state per modem and since when its problem lasts (null: no problem). @type {Map<string, { state: string, since: number | null }>} */
  const tracked = new Map();
  /** @type {Active} */
  let active = { ami: null, modems: {} };
  /** Epoch ms since which AMI has not been up; null while it is up. @type {number | null} */
  let amiDownSince = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  let started = false;
  let registryMissing = false;

  /**
   * @param {string} modemId
   * @param {string} state
   */
  function observe(modemId, state) {
    const previous = tracked.get(modemId);
    if (previous?.state === state) return;
    const since = PROBLEM.has(state) || state === 'unverified' ? previous?.since ?? (PROBLEM.has(state) ? now() : null) : null;
    tracked.set(modemId, { state, since });
  }

  /** @returns {CheckResult} */
  function check() {
    /** @type {CheckResult} */
    const result = { alerts: [], recoveries: [], skipped: null };
    const reg = registry();
    if (!reg) {
      if (!registryMissing) log.warn('alerts wait: the registry cannot be loaded');
      registryMissing = true;
      result.skipped = 'registry';
      return result;
    }
    registryMissing = false;
    const at = now();
    const enabled = reg.telegram.alerts;
    const timeZone = reg.settings.timezone;
    const name = host();
    /** @type {Array<{ chatIds: readonly string[], text: string }>} */
    const messages = [];
    /** @type {Active} */
    const next = { ami: active.ami, modems: { ...active.modems } };

    if (ami) {
      if (ami.connected) {
        amiDownSince = null;
        if (next.ami) {
          if (enabled) messages.push({ chatIds: reg.telegram.default_recipients, text: amiRecoveredText({ host: name, since: next.ami.since, timeZone }) });
          result.recoveries.push('ami');
          next.ami = null;
        }
      } else {
        amiDownSince ??= at;
        if (!next.ami && enabled && at - amiDownSince >= t.amiMs) {
          messages.push({ chatIds: reg.telegram.default_recipients, text: amiAlertText({ host: name, since: amiDownSince, timeZone }) });
          result.alerts.push('ami');
          next.ami = { since: amiDownSince };
        }
      }
    }

    const ids = new Set(reg.modems.map((modem) => modem.id));
    for (const id of tracked.keys()) if (!ids.has(id)) tracked.delete(id);
    for (const id of Object.keys(next.modems)) if (!ids.has(id)) delete next.modems[id];
    for (const modem of reg.modems) {
      const entry = tracked.get(modem.id);
      if (!entry) continue;
      const alerted = next.modems[modem.id];
      const chatIds = modem.recipients ?? reg.telegram.default_recipients;
      if (PROBLEM.has(entry.state)) {
        if (!alerted && enabled && entry.since !== null && at - entry.since >= t.modemMs) {
          messages.push({ chatIds, text: modemAlertText({ host: name, modem: modem.id, state: entry.state, since: entry.since, timeZone }) });
          result.alerts.push(modem.id);
          next.modems[modem.id] = { state: entry.state, since: entry.since };
        }
      } else if (alerted && entry.state !== 'unverified') {
        if (enabled) messages.push({ chatIds, text: modemRecoveredText({ host: name, modem: modem.id, state: entry.state, alertState: alerted.state, since: alerted.since, timeZone }) });
        result.recoveries.push(modem.id);
        delete next.modems[modem.id];
      }
    }

    if (JSON.stringify(next) === JSON.stringify(active)) return result;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const message of messages) enqueue(db, { sourceKind: 'alert', chatIds: message.chatIds, text: message.text, now: at });
      db.prepare(UPSERT_ACTIVE).run(SETTINGS_KEY, JSON.stringify(next));
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite has already rolled the transaction back; the original error is rethrown.
      }
      throw err;
    }
    active = next;
    for (const key of result.alerts) log.warn('alert raised', { alert: key, notified: enabled });
    for (const key of result.recoveries) log.info('alert recovered', { alert: key, notified: enabled });
    return result;
  }

  return {
    /** Loads the active alerts, subscribes to modem.state and checks every checkMs. Call before the device state refresher starts. */
    start() {
      if (started) throw new Error('alerts already started');
      started = true;
      active = loadActive(db, log);
      amiDownSince = ami && !ami.connected ? now() : null;
      unsubscribe = bus.subscribe((event) => {
        if (event.type !== 'modem.state') return;
        const { modem_id: modemId, state } = /** @type {{ modem_id?: unknown, state?: unknown }} */ (event.payload);
        if (typeof modemId === 'string' && typeof state === 'string') observe(modemId, state);
      });
      timer = setInterval(() => {
        try {
          check();
        } catch (err) {
          log.error('alert check failed', { err });
        }
      }, t.checkMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    check,
    /** The active alerts (a copy). @returns {Active} */
    active: () => structuredClone(active),
  };
}
