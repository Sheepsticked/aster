// @ts-check
// Aster controller — the network a modem uses (2G/3G/4G, technology, band), read from the modem while it is connected and in no
// call: AT+QNWINFO on a Quectel, AT^SYSINFO on a Huawei stick. Held in memory only; the device state carries it to the pages.
// Usage: const network = createNetworkReader({ ami, registry, states: () => devices.states(), onChange: () => devices.schedule() });
//        network.start(); network.get('gsm1') → Network | null; network.want('gsm1') reads again soon when the reading is old
import { DRIVER_STATES } from '../devices/state.js';
import { DEFAULTS, errorText, transact } from './client.js';

/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../config/registry.js').Modem} Modem */
/** @typedef {'2G' | '3G' | '4G' | '5G'} Generation */
/**
 * @typedef {object} Network  what the modem answered, the way the Modem page shows it
 * @property {boolean} service               false: the modem answered that it has no network
 * @property {Generation | null} generation  null without service or for a technology outside the table
 * @property {string | null} tech            the modem's name for it: FDD LTE, HSPA+, EDGE, ...
 * @property {string | null} band            LTE band 3, WCDMA 2100, ... (Quectel only)
 * @property {number} observed_at
 */
/**
 * @typedef {object} Timing
 * @property {number} tickMs       how often the modems' states are looked at (15 s)
 * @property {number} maxAgeMs     a reading older than this is renewed (30 min)
 * @property {number} wantedAgeMs  a page asking for the modem renews a reading older than this (60 s); also the retry pause
 * @property {number} settleMs     the wait after the modem's state or cell changed, so the reading shows where it settled (10 s)
 * @property {number} backoffMs    the pause after an AT timeout, which makes the driver restart the modem (1 h)
 * @property {number} timeoutS
 * @property {number} graceMs
 * @property {number} actionTimeoutMs
 */
/**
 * @typedef {object} Options
 * @property {AmiClient | null} ami
 * @property {() => Registry | null} registry
 * @property {() => Map<string, any>} states  the device state's last observations (devices/state.js states())
 * @property {(modemId: string) => void} [onChange]  after a modem's reading changed or was dropped
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {Partial<Timing>} [timing]
 */
/**
 * @typedef {object} Entry
 * @property {Network | null} network
 * @property {number | null} readAt     the last answered read; null while the modem is not connected
 * @property {string | null} basis      the driver state, registration and cell the last tick saw
 * @property {number} changedAt
 * @property {boolean} dirty            the basis changed since the last read
 * @property {number} wantedAt
 * @property {number} retryAt
 */

export const QUECTEL_QUERY = 'AT+QNWINFO';
export const DONGLE_QUERY = 'AT^SYSINFO';
export const DEFAULT_TIMING = Object.freeze({ tickMs: 15_000, maxAgeMs: 30 * 60_000, wantedAgeMs: 60_000, settleMs: 10_000, backoffMs: 60 * 60_000, timeoutS: 15 });
/** The driver states of a connected modem in no call: the only ones in which the network is read. */
const IDLE = new Set(['Free', 'GSM not registered']);
/** The driver states of a call or an SMS: the reading is kept but not renewed. */
const BUSY = new Set(Object.keys(DRIVER_STATES).filter((state) => DRIVER_STATES[state] === 'busy'));
/** AT^SYSINFO `<sys_submode>` and `<sys_mode>` names (Huawei); sys_mode 7 (GSM/WCDMA) leaves it to the submode. */
const SUBMODES = Object.freeze(/** @type {Readonly<Record<number, string>>} */ ({ 1: 'GSM', 2: 'GPRS', 3: 'EDGE', 4: 'WCDMA', 5: 'HSDPA', 6: 'HSUPA', 7: 'HSPA',
  8: 'TD-SCDMA', 9: 'HSPA+', 17: 'HSPA+', 18: 'HSPA+' }));
const SYS_MODES = Object.freeze(/** @type {Readonly<Record<number, string>>} */ ({ 3: 'GSM', 5: 'WCDMA', 15: 'TD-SCDMA' }));

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * The comma-separated fields of an answer, unquoted; empty fields are kept so positions hold.
 * @param {string} text
 */
function fields(text) {
  /** @type {string[]} */
  const out = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

/**
 * The generation of a technology name as the modems report it.
 * @param {string} tech
 * @returns {Generation | null}
 */
export function generationOf(tech) {
  const name = tech.toUpperCase();
  if (/NR5G|^NR\b/.test(name)) return '5G';
  if (/LTE|EMTC|CAT-?M|NB-?IOT/.test(name)) return '4G';
  if (/WCDMA|HSDPA|HSUPA|HSPA|TD-?SCDMA|UMTS|EVDO|HDR/.test(name)) return '3G';
  if (/GSM|GPRS|EDGE|CDMA/.test(name)) return '2G';
  return null;
}

/** @param {number} at @returns {Network} */
const noService = (at) => ({ service: false, generation: null, tech: null, band: null, observed_at: at });

/**
 * The network of an AT+QNWINFO answer (`+QNWINFO: "FDD LTE","00101","LTE BAND 3",1300`, `+QNWINFO: No Service`), or null.
 * @param {readonly string[]} lines
 * @param {number} at
 * @returns {Network | null}
 */
export function quectelNetwork(lines, at) {
  for (const line of lines) {
    const match = /^\+QNWINFO:\s*(.*)$/i.exec(line.trim());
    if (!match) continue;
    const [tech = '', , band = ''] = fields(match[1] ?? '');
    if (tech === '' || /^no service$/i.test(tech)) return noService(at);
    return { service: true, generation: generationOf(tech), tech, band: band === '' ? null : band.replace(/\bBAND\b/, 'band'), observed_at: at };
  }
  return null;
}

/**
 * The network of an AT^SYSINFO answer (`^SYSINFO:2,3,0,5,1,,9`: service status, domain, roaming, mode, SIM, lock, submode), or null.
 * @param {readonly string[]} lines
 * @param {number} at
 * @returns {Network | null}
 */
export function dongleNetwork(lines, at) {
  for (const line of lines) {
    const match = /^\^SYSINFO:\s*(.*)$/i.exec(line.trim());
    if (!match) continue;
    const [status = NaN, , , mode = NaN, , , submode = NaN] = fields(match[1] ?? '').map((field) => (field === '' ? NaN : Number(field)));
    if (status === 0 || mode === 0 || !Number.isInteger(mode)) return noService(at);
    const tech = SUBMODES[submode] ?? SYS_MODES[mode] ?? null;
    return { service: true, generation: tech === null ? null : generationOf(tech), tech, band: null, observed_at: at };
  }
  return null;
}

/** @param {Network | null} a @param {Network | null} b */
const same = (a, b) => (a === null || b === null ? a === b : a.service === b.service && a.generation === b.generation && a.tech === b.tech && a.band === b.band);

/**
 * @param {Options} options
 */
export function createNetworkReader({ ami, registry, states, onChange = () => {}, log = SILENT, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, ...DEFAULT_TIMING, ...timing };
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** @type {Promise<void> | null} */
  let running = null;
  let again = false;
  let stopped = false;
  let seq = 0;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** @param {string} id */
  function entryOf(id) {
    let entry = entries.get(id);
    if (!entry) {
      entry = { network: null, readAt: null, basis: null, changedAt: 0, dirty: false, wantedAt: 0, retryAt: 0 };
      entries.set(id, entry);
    }
    return entry;
  }

  /** @param {string} id @param {Network | null} network */
  function set(id, network) {
    const entry = entryOf(id);
    const before = entry.network;
    entry.network = network;
    if (same(before, network)) return;
    if (network !== null) log.info('modem network', { modem: id, generation: network.generation, tech: network.tech, band: network.band });
    try {
      onChange(id);
    } catch (err) {
      log.error('network change handler failed', { modem: id, err });
    }
  }

  /**
   * Follows each modem's state and returns the ones due a reading: a connected modem without one, one whose state or cell
   * changed and settled, an old one, or one a page asked for. A modem that is not connected loses its reading.
   * @returns {Modem[]}
   */
  function due() {
    const reg = registry();
    if (!reg) return [];
    const rows = states();
    const at = now();
    /** @type {Modem[]} */
    const out = [];
    for (const modem of reg.modems) {
      const entry = entryOf(modem.id);
      const row = rows.get(modem.id);
      const driverState = row?.detail?.listed ? row.driver_state ?? null : null;
      const basis = driverState === null ? null : `${driverState}|${row.gsm_reg ?? ''}|${row.detail.cell ?? ''}`;
      if (basis !== entry.basis) {
        entry.basis = basis;
        entry.changedAt = at;
        entry.dirty = true;
      }
      if (!modem.enabled || driverState === null || (!IDLE.has(driverState) && !BUSY.has(driverState))) {
        entry.readAt = null;
        set(modem.id, null);
        continue;
      }
      if (!IDLE.has(driverState) || row.detail.restarting || at < entry.retryAt) continue;
      const age = entry.readAt === null ? Infinity : at - entry.readAt;
      const settled = entry.dirty && at - entry.changedAt >= t.settleMs;
      const wanted = entry.wantedAt > (entry.readAt ?? 0) && age >= t.wantedAgeMs;
      if (age >= t.maxAgeMs || settled || wanted) out.push(modem);
    }
    const ids = new Set(reg.modems.map((modem) => modem.id));
    for (const id of [...entries.keys()]) if (!ids.has(id)) entries.delete(id);
    return out;
  }

  /** @param {Modem} modem */
  async function read(modem) {
    if (!ami || !ami.connected) return;
    const entry = entryOf(modem.id);
    const command = modem.driver === 'quectel' ? QUECTEL_QUERY : DONGLE_QUERY;
    const tx = await transact(ami, { driver: modem.driver, device: modem.id, command, actionId: `net-${++seq}`, timeoutS: t.timeoutS, graceMs: t.graceMs,
      actionTimeoutMs: t.actionTimeoutMs, log, now });
    const at = now();
    if (tx.outcome === 'OK' || tx.outcome === 'ERROR') {
      // an ERROR is a modem without the command: nothing to show, asked again only after maxAgeMs or a change
      entry.readAt = at;
      entry.dirty = false;
      set(modem.id, tx.outcome === 'OK' ? (modem.driver === 'quectel' ? quectelNetwork : dongleNetwork)(tx.lines, at) : null);
      if (tx.outcome === 'ERROR') log.debug('network not read: the modem refused the command', { modem: modem.id, command, error: tx.error });
      return;
    }
    if (tx.outcome === 'TIMEOUT') log.warn('network not read: the modem did not answer in time; the next read waits', { modem: modem.id, command, pause_s: t.backoffMs / 1000 });
    entry.retryAt = at + (tx.outcome === 'TIMEOUT' ? t.backoffMs : t.wantedAgeMs);
  }

  /** One pass over the modems due a reading, one at a time; a pass asked for meanwhile runs right after, under the same promise. */
  function tick() {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        for (const modem of due()) {
          if (stopped) break;
          try {
            await read(modem);
          } catch (err) {
            log.warn('network read failed', { modem: modem.id, err: errorText(err) });
          }
        }
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), t.tickMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
    },
    tick,
    /** The last reading of a modem, or null. @param {string} modemId */
    get: (modemId) => entries.get(modemId)?.network ?? null,
    /** A page shows the modem: a reading older than wantedAgeMs is renewed now. @param {string} modemId */
    want(modemId) {
      entryOf(modemId).wantedAt = now();
      void tick();
    },
  };
}
