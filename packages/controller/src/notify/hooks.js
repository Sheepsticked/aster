// @ts-check
// Spool ingester hooks: sets calls.outcome, queues Telegram notifications for new SMS and missed calls, and publishes
// message.new / call.new after COMMIT. Without any loadable registry the hook throws so the spool file is retried.
import { hostname } from 'node:os';
import { missedReason, outcome } from '../calls/outcome.js';
import { enqueue } from './queue.js';
import { missedCallText, smsText } from './texts.js';

/** @typedef {import('../bus.js').Bus} Bus */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../spool/ingest.js').Hooks} Hooks */
/**
 * @typedef {object} HookOptions
 * @property {() => Registry | null} registry  the registry now; null while it cannot be loaded
 * @property {Bus | null} [bus]                message.new / call.new after COMMIT
 * @property {Logger} [log]
 * @property {() => number} [now]              notifications.created_at
 * @property {() => string} [host]             the host name that starts each text (default: this machine's)
 */

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * @param {HookOptions} options
 * @returns {Required<Pick<Hooks, 'outcome' | 'onEvent' | 'afterCommit'>>}
 */
export function createIngestHooks({ registry, bus = null, log = SILENT, now = Date.now, host = hostname }) {
  /** @type {Registry | null} */
  let lastGood = null;
  let usingLastGood = false;

  /** The registry that decides recipients now. */
  function current() {
    const reg = registry();
    if (reg) {
      if (usingLastGood) log.info('the registry loads again; notifications use it');
      usingLastGood = false;
      lastGood = reg;
      return reg;
    }
    if (!lastGood) throw new Error('the registry cannot be loaded, so the recipients of this event are unknown; its spool file is retried later');
    if (!usingLastGood) log.warn('the registry cannot be loaded; notifications use the last valid registry');
    usingLastGood = true;
    return lastGood;
  }

  return {
    outcome: (call) => outcome(call),
    onEvent({ db, event, rowId }) {
      if (rowId === null || event.kind === 'sms-report') return;
      if (event.kind === 'call-end' && outcome(event.data) !== 'missed') return;
      const reg = current();
      const modem = reg.modems.find((entry) => entry.id === event.modem) ?? null;
      const chatIds = modem?.recipients ?? reg.telegram.default_recipients;
      if (chatIds.length === 0) return;
      if (event.kind === 'sms') {
        const { sender, scts, text } = event.data;
        enqueue(db, { sourceKind: 'sms', sourceId: rowId, chatIds, text: smsText({ host: host(), modem: event.modem, sender, scts, text }), now: now() });
      } else {
        const { caller, dialstatus } = event.data;
        const text = missedCallText({ host: host(), modem: event.modem, caller, at: event.emittedMs, timeZone: reg.settings.timezone, reason: missedReason(dialstatus) ?? dialstatus });
        enqueue(db, { sourceKind: 'call', sourceId: rowId, chatIds, text, now: now() });
      }
    },
    afterCommit({ db, event, rowId }) {
      if (!bus || rowId === null) return;
      if (event.kind === 'sms') bus.publish('message.new', { ...db.prepare('SELECT * FROM messages WHERE id = ?').get(rowId) });
      else if (event.kind === 'call-end') bus.publish('call.new', { ...db.prepare('SELECT * FROM calls WHERE id = ?').get(rowId) });
    },
  };
}
