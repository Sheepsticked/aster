// @ts-check
// Aster controller — modem state: periodically and after Status events, operations and AMI reconnects, reads both drivers'
// ShowDevices lists, derives each registry modem's UI state and publishes `modem.state` when it changes. A sysfs poll tracks
// USB presence. State is held in memory only, to limit SD-card writes. A started but unconnected device reports
// `CurrentDeviceState: stop` and an empty IMEIState until initialization succeeds.
// Usage: const devices = createDeviceState({ db, ami, bus, log, registry: () => load(path).registry }); devices.start(); await devices.refresh();
//        devices.states() → Map<modem id, ModemState>; uiState(modem, devices.states().get(id) ?? null, devices.seen())
import { AmiError, AmiTimeout } from '../ami/client.js';
import { normalize } from '../at/forwarding.js';
import { FINAL } from '../ops/runner.js';
import { remapReason } from './remap.js';
import { listUsbModems, usbPortOfTty } from './sysfs.js';

/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../ami/parser.js').Packet} Packet */
/** @typedef {import('../bus.js').Bus} Bus */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../config/registry.js').Modem} Modem */
/** @typedef {import('./sysfs.js').UsbModem} UsbModem */
/** @typedef {'quectel' | 'dongle'} Driver */
/**
 * @typedef {object} DeviceEntry  one `…DeviceEntry` event, the headers the controller uses (both drivers' manager.c)
 * @property {Driver} driver
 * @property {string} device
 * @property {string} state         `State`: Stopped | Not connected | Not initialized | GSM not registered | Free | Ring | Waiting |
 *   Dialing | Active | Outgoing | Incoming | Both | Held | SMS | Radio off (chan_quectel.c pvt_str_state, cpvt.c pvt_call_dir; Radio off: the radio patches)
 * @property {string | null} imei   `IMEIState` (empty until the device initialized)
 * @property {string | null} imsi   `IMSIState`
 * @property {string | null} dataTty   `DataState`: the data tty while the device is started
 * @property {string | null} audio     `AudioState`: the audio tty, or the ALSA device of a quec_uac device
 * @property {string} gsmReg        `GSMRegistrationStatus`
 * @property {number | null} rssi   the number before the comma of `RSSI: 12, -101 dBm` (0–31; 99 = unknown → null)
 * @property {string | null} provider  `ProviderName` (`NONE` → null)
 * @property {string | null} number    `SubscriberNumber` (`Unknown` → null)
 * @property {string} current       `CurrentDeviceState`: stop | restart | remove | start (chan_quectel.c dev_state_strs)
 * @property {string} desired       `DesiredDeviceState`
 * @property {string | null} imeiSetting  `IMEISetting` (the configured imei)
 * @property {string | null} dataSetting  `DataSetting`
 * @property {string | null} manufacturer
 * @property {string | null} model
 * @property {string | null} firmware
 * @property {number} calls         `CallsChannels`
 * @property {string | null} radio  `RadioSetting` of the radio patches (keep | on | off); null when the driver does not report it
 */
/** @typedef {'disabled' | 'unmapped' | 'unverified' | 'duplicate-imei' | 'flapping' | 'absent' | 'stopped' | 'connecting' | 'no-network' | 'ready' | 'busy'} UiState */
/**
 * @typedef {object} Detail  the detail of a state row (held in memory only)
 * @property {boolean} listed          the driver listed the device
 * @property {string | null} current   CurrentDeviceState
 * @property {string | null} desired   DesiredDeviceState
 * @property {string | null} imei      IMEIState
 * @property {string | null} imsi
 * @property {string | null} audio
 * @property {string | null} manufacturer
 * @property {string | null} model
 * @property {string | null} firmware
 * @property {number} calls
 * @property {string | null} radio     `RadioSetting` (keep | on | off), null when the driver does not report it
 * @property {number} disconnects      `Status: Disconnect` events within the flapping window
 * @property {boolean} flapping
 * @property {string | null} vendor    of the USB device data_tty belongs to
 * @property {string | null} product
 * @property {string | null} reason    why the state is `unverified` (the driver is not loaded, does not list the device, reports an unknown state)
 * @property {import('../at/forwarding.js').ForwardingState | null} forwarding  what the forwarding operations stored; the refresh keeps it
 */
/**
 * @typedef {object} ModemState  one modem's last observation, held in memory only to limit SD-card writes
 * @property {string} modem_id
 * @property {UiState} state           the UI state at observation time (uiState with the observation fresh)
 * @property {string | null} driver_state  the entry's `State`
 * @property {string | null} gsm_reg
 * @property {number | null} rssi
 * @property {string | null} provider
 * @property {string | null} number
 * @property {string | null} data_tty
 * @property {string | null} usb_port  the USB port of data_tty per sysfs (null when the device has no tty or sysfs cannot place it)
 * @property {number} observed_at      epoch ms of the ShowDevices read
 * @property {Detail} detail
 */
/**
 * @typedef {object} SeenDevice  a devices_seen row
 * @property {string} usb_port
 * @property {string | null} vendor
 * @property {string | null} product
 * @property {string | null} imei
 * @property {string | null} imsi
 * @property {string | null} data_tty
 * @property {number} first_seen
 * @property {number} last_seen
 * @property {0 | 1} present
 */
/**
 * @typedef {object} Timing
 * @property {number} refreshMs        ShowDevices period (10 s)
 * @property {number} sysfsPollMs      /sys/bus/usb/devices poll period (5 s)
 * @property {number} debounceMs       a Status event or an operation end triggers a refresh this much later, once (300 ms)
 * @property {number} actionTimeoutMs  ShowDevices timeout (10 s)
 * @property {number} staleMs          an observation older than this is `unverified` (30 s = three missed refreshes)
 * @property {number} flapWindowMs     the flapping window (2 min)
 * @property {number} flapDisconnects  Disconnects within the window that mean flapping (3)
 */
/**
 * @typedef {object} Options
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {AmiClient | null} ami
 * @property {Bus} bus
 * @property {Logger} [log]
 * @property {() => Registry | null} registry  the current registry; null when it cannot be loaded (the rows are then left alone)
 * @property {string} [sysfsRoot]  default /sys
 * @property {() => number} [now]
 * @property {Partial<Timing>} [timing]
 * @property {(change: { added: UsbModem[], removed: UsbModem[], present: UsbModem[] }) => void} [onUsbChange]  after a sysfs poll that saw a difference
 * @property {(modemId: string, reason: string) => void} [onRemapNeeded]  once per modem and reason (remap.js remapReason)
 */
/** @typedef {{ skipped: string | null, modems: number, listed: number, errors: Record<Driver, string | null>, published: string[] }} RefreshResult */

export const DEFAULTS = Object.freeze({ refreshMs: 10_000, sysfsPollMs: 5_000, debounceMs: 300, actionTimeoutMs: 10_000, staleMs: 30_000, flapWindowMs: 120_000, flapDisconnects: 3,
  seenTouchMs: 15 * 60_000 });
export const DRIVERS = Object.freeze(/** @type {const} */ (['quectel', 'dongle']));
/** The eleven UI states; `unverified` carries `since` = the row's observed_at. */
export const UI_STATES = Object.freeze(/** @type {const} */ (['disabled', 'unmapped', 'unverified', 'duplicate-imei', 'flapping', 'absent', 'stopped', 'connecting', 'no-network', 'ready', 'busy']));
/** The driver's `State` texts → the UI state of a listed, present, non-flapping, enabled and mapped modem. */
export const DRIVER_STATES = Object.freeze(/** @type {Readonly<Record<string, UiState>>} */ ({
  'Stopped': 'stopped',
  'Not connected': 'connecting',
  'Not initialized': 'connecting',
  // radio = off: a disabled modem, which uiState reports as `disabled` before it looks at the driver; an enabled modem shows it
  // only until the reload that enabled it has restarted the device with its radio on
  'Radio off': 'connecting',
  'GSM not registered': 'no-network',
  'Free': 'ready',
  'Ring': 'busy',
  'Waiting': 'busy',
  'Dialing': 'busy',
  'Active': 'busy',
  'Outgoing': 'busy',
  'Incoming': 'busy',
  'Both': 'busy',
  'Held': 'busy',
  'SMS': 'busy',
}));
/** Operation kinds whose end changes what ShowDevices reports. */
const REFRESH_AFTER = new Set(['modem-start', 'modem-stop', 'modem-restart', 'modem-reset', 'modem-remove', 'registry-apply', 'remap', 'scan']);
const IMEI = /^[0-9]{15}$/;
const IMSI = /^[0-9]{6,15}$/;
const FINISHED = new Set(FINAL);

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

// Modem state is rebuilt from ShowDevices after every start, so it is not stored; only forwarding results persist.
const SELECT_FORWARDING = 'SELECT forwarding_json AS forwarding FROM modem_forwarding WHERE modem_id = ?';
const DELETE_FORWARDING = 'DELETE FROM modem_forwarding WHERE modem_id = ?';
/** A tty placed on a port, or a device found by a scan: identity fields replace what is stored only when known. */
const UPSERT_SEEN = `INSERT INTO devices_seen (usb_port, vendor, product, imei, imsi, data_tty, first_seen, last_seen, present) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT (usb_port) DO UPDATE SET vendor = COALESCE(excluded.vendor, devices_seen.vendor), product = COALESCE(excluded.product, devices_seen.product),
  imei = COALESCE(excluded.imei, devices_seen.imei), imsi = COALESCE(excluded.imsi, devices_seen.imsi), data_tty = COALESCE(excluded.data_tty, devices_seen.data_tty),
  last_seen = excluded.last_seen, present = 1`;
/** A freshly plugged port: present, identity unknown until a driver or a scan reports it (the previous modem may be gone). */
const PLUGGED_SEEN = `INSERT INTO devices_seen (usb_port, vendor, product, imei, imsi, data_tty, first_seen, last_seen, present) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, 1)
  ON CONFLICT (usb_port) DO UPDATE SET vendor = excluded.vendor, product = excluded.product, imei = NULL, imsi = NULL, data_tty = NULL, last_seen = excluded.last_seen, present = 1`;
const UNPLUGGED_SEEN = 'UPDATE devices_seen SET present = 0, last_seen = ? WHERE usb_port = ?';
const SELECT_SEEN = 'SELECT * FROM devices_seen ORDER BY usb_port';

/**
 * @param {Packet} packet
 * @param {string} name
 */
function header(packet, name) {
  const value = packet.get(name);
  const text = Array.isArray(value) ? value[0] : value;
  return text === undefined ? null : String(text);
}
/** @param {string | null} text */
const nullIfEmpty = (text) => (text === null || text === '' ? null : text);

/**
 * The fields of one `…DeviceEntry` event.
 * @param {Packet} packet
 * @param {Driver} driver
 * @returns {DeviceEntry}
 */
export function parseDeviceEntry(packet, driver) {
  const rssiText = header(packet, 'RSSI') ?? '';
  const rssiMatch = /^(\d+)/.exec(rssiText.trim());
  const rssi = rssiMatch ? Number(rssiMatch[1]) : null;
  const provider = nullIfEmpty(header(packet, 'ProviderName'));
  const number = nullIfEmpty(header(packet, 'SubscriberNumber'));
  const calls = Number(header(packet, 'CallsChannels') ?? '0');
  return {
    driver,
    device: header(packet, 'Device') ?? '',
    state: header(packet, 'State') ?? '',
    imei: nullIfEmpty(header(packet, 'IMEIState')),
    imsi: nullIfEmpty(header(packet, 'IMSIState')),
    dataTty: nullIfEmpty(header(packet, 'DataState')),
    audio: nullIfEmpty(header(packet, 'AudioState')),
    gsmReg: header(packet, 'GSMRegistrationStatus') ?? '',
    rssi: rssi === null || rssi === 99 ? null : rssi,
    provider: provider === 'NONE' ? null : provider,
    number: number === 'Unknown' ? null : number,
    current: header(packet, 'CurrentDeviceState') ?? '',
    desired: header(packet, 'DesiredDeviceState') ?? '',
    imeiSetting: nullIfEmpty(header(packet, 'IMEISetting')),
    dataSetting: nullIfEmpty(header(packet, 'DataSetting')),
    manufacturer: nullIfEmpty(header(packet, 'Manufacturer')),
    model: nullIfEmpty(header(packet, 'Model')),
    firmware: nullIfEmpty(header(packet, 'Firmware')),
    calls: Number.isInteger(calls) ? calls : 0,
    radio: nullIfEmpty(header(packet, 'RadioSetting')),
  };
}

/**
 * The driver's `…ShowDevices` list (all devices, or one with `device`) as entries, in list order. Rejects like the AMI client
 * (AmiError for an unknown action when the driver is not loaded, AmiTimeout, AmiDisconnected).
 * @param {AmiClient} ami
 * @param {Driver} driver
 * @param {{ device?: string, timeout?: number }} [options]
 * @returns {Promise<DeviceEntry[]>}
 */
export async function showDevices(ami, driver, { device, timeout } = {}) {
  const action = driver === 'quectel' ? 'QuectelShowDevices' : 'DongleShowDevices';
  const packets = await ami.list(action, device === undefined ? {} : { Device: device }, `${action}Complete`, { timeout });
  return packets.map((packet) => parseDeviceEntry(packet, driver));
}

/**
 * Both drivers' lists, by device name; a driver whose list fails is reported in `errors` and contributes no entries.
 * @param {AmiClient} ami
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<{ entries: Map<string, DeviceEntry>, errors: Record<Driver, string | null> }>}
 */
export async function showAllDevices(ami, options = {}) {
  /** @type {Map<string, DeviceEntry>} */
  const entries = new Map();
  /** @type {Record<Driver, string | null>} */
  const errors = { quectel: null, dongle: null };
  for (const driver of DRIVERS) {
    try {
      for (const entry of await showDevices(ami, driver, options)) if (!entries.has(entry.device)) entries.set(entry.device, entry);
    } catch (err) {
      if (err instanceof AmiError || err instanceof AmiTimeout) errors[driver] = errorText(err);
      else throw err;
    }
  }
  return { entries, errors };
}

/**
 * The UI state of a registry modem (one of UI_STATES), from the registry entry, the last observation and the devices seen
 * on USB. Order: `disabled` (registry) → `unmapped` (uac without usb_port) → `unverified` (no observation, one older than staleMs, or
 * the driver does not list the device) → `duplicate-imei` (the modem's IMEI present on two ports) → `flapping` → `absent` (the
 * registry port is not plugged in; only decided when sysfs presence is known) → the driver's State (`stopped` when the driver keeps
 * an enabled modem stopped, `connecting`, `no-network`, `ready`, `busy`; an unknown text is `unverified`).
 * @param {Pick<Modem, 'enabled' | 'uac' | 'usb_port' | 'imei'>} modem
 * @param {Pick<ModemState, 'observed_at' | 'driver_state'> & { detail: Pick<Detail, 'listed' | 'flapping'> } | null} state
 * @param {ReadonlyArray<Pick<SeenDevice, 'usb_port' | 'imei' | 'present'>> | null} seen  null when USB presence is unknown (no sysfs)
 * @param {{ now?: number, staleMs?: number }} [options]
 * @returns {UiState}
 */
export function uiState(modem, state, seen, { now = Date.now(), staleMs = DEFAULTS.staleMs } = {}) {
  if (!modem.enabled) return 'disabled';
  if (modem.uac && modem.usb_port === null) return 'unmapped';
  if (!state || now - state.observed_at > staleMs || !state.detail.listed || state.driver_state === null) return 'unverified';
  if (seen && seen.filter((row) => row.present === 1 && row.imei === modem.imei).length >= 2) return 'duplicate-imei';
  if (state.detail.flapping) return 'flapping';
  if (seen && modem.usb_port !== null && !seen.some((row) => row.present === 1 && row.usb_port === modem.usb_port)) return 'absent';
  return DRIVER_STATES[state.driver_state] ?? 'unverified';
}

/**
 * @param {ModemState} row  what changed since the last publish is judged on these fields (not on observed_at or counters)
 */
const fingerprint = (row) => JSON.stringify([row.state, row.driver_state, row.gsm_reg, row.rssi, row.provider, row.number, row.data_tty, row.usb_port,
  row.detail.listed, row.detail.current, row.detail.desired, row.detail.flapping, row.detail.imei, row.detail.radio, row.detail.reason]);

/**
 * @param {Options} options
 */
export function createDeviceState({ db, ami, bus, log = SILENT, registry, sysfsRoot = '/sys', now = Date.now, timing = {}, onUsbChange, onRemapNeeded }) {
  const t = { ...DEFAULTS, ...timing };
  const deleteForwarding = db.prepare(DELETE_FORWARDING);
  const upsertSeen = db.prepare(UPSERT_SEEN);
  const pluggedSeen = db.prepare(PLUGGED_SEEN);
  const unpluggedSeen = db.prepare(UNPLUGGED_SEEN);
  const selectSeen = db.prepare(SELECT_SEEN);
  const selectForwarding = db.prepare(SELECT_FORWARDING);

  /** The forwarding state the last forwarding operation stored for the modem (at/forwarding.js), or null. @param {string} modemId */
  function storedForwarding(modemId) {
    const row = /** @type {{ forwarding: string | null } | undefined} */ (selectForwarding.get(modemId));
    if (!row || row.forwarding === null || row.forwarding === undefined) return null;
    try {
      return normalize(JSON.parse(String(row.forwarding)));
    } catch {
      return null;
    }
  }

  /** The last row written or loaded per modem. @type {Map<string, ModemState>} */
  const rows = new Map();
  /** The fingerprint last published per modem. @type {Map<string, string>} */
  const published = new Map();
  /** `Status: Disconnect` times per device. @type {Map<string, number[]>} */
  const disconnects = new Map();
  /** The last sysfs poll: null until one succeeded, and after one failed. @type {Map<string, UsbModem> | null} */
  let usbPresent = null;
  let sysfsFailed = false;
  let registryFailed = false;
  /** Reasons already reported to onRemapNeeded. @type {Map<string, string>} */
  const remapReported = new Map();
  /** @type {Promise<RefreshResult> | null} */
  let running = null;
  let again = false;
  let stopped = false;
  let started = false;
  /** @type {NodeJS.Timeout | null} */
  let debounce = null;
  /** @type {NodeJS.Timeout | null} */
  let refreshTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let sysfsTimer = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  // Rows start empty; start() refreshes at once, so a restart shows `unverified` only briefly.

  /** @returns {SeenDevice[]} */
  const seenRows = () => /** @type {SeenDevice[]} */ (selectSeen.all());

  /**
   * Would UPSERT_SEEN change anything worth a write? It COALESCEs the identity fields, so a null the driver did not
   * report never clears a stored one; what is left is `last_seen`, which is worth a commit only every seenTouchMs.
   * @param {SeenDevice | undefined} row  what is stored for the port
   * @param {import('./sysfs.js').UsbDevice} usb
   * @param {string | null} imei
   * @param {string | null} imsi
   * @param {string | null} dataTty
   * @param {number} at
   * @returns {boolean}
   */
  function seenIsCurrent(row, usb, imei, imsi, dataTty, at) {
    if (!row || row.present !== 1) return false;
    if (usb.vendor !== null && row.vendor !== usb.vendor) return false;
    if (usb.product !== null && row.product !== usb.product) return false;
    if (imei !== null && row.imei !== imei) return false;
    if (imsi !== null && row.imsi !== imsi) return false;
    if (dataTty !== null && row.data_tty !== dataTty) return false;
    return at - Number(row.last_seen) < t.seenTouchMs;
  }

  /** @param {string} device */
  function disconnectCount(device) {
    const times = disconnects.get(device);
    if (!times) return 0;
    const cutoff = now() - t.flapWindowMs;
    const kept = times.filter((at) => at > cutoff);
    if (kept.length === 0) disconnects.delete(device);
    else disconnects.set(device, kept);
    return kept.length;
  }

  /**
   * @param {string} tty
   * @returns {import('./sysfs.js').UsbDevice | null}
   */
  function placeTty(tty) {
    try {
      return usbPortOfTty(tty, sysfsRoot);
    } catch (err) {
      log.warn('cannot place a tty on a USB port', { tty, err: errorText(err) });
      return null;
    }
  }

  /**
   * Polls sysfs for modem devices: presence in devices_seen, plug/unplug notifications, a refresh when something changed.
   * @returns {{ added: UsbModem[], removed: UsbModem[], present: UsbModem[] } | null}
   */
  function pollSysfs() {
    /** @type {UsbModem[]} */
    let present;
    try {
      present = listUsbModems(sysfsRoot);
    } catch (err) {
      if (!sysfsFailed) log.warn('USB presence unknown: sysfs is not readable (is /sys mounted?)', { root: sysfsRoot, err: errorText(err) });
      sysfsFailed = true;
      usbPresent = null;
      return null;
    }
    if (sysfsFailed) log.info('sysfs readable again', { root: sysfsRoot });
    sysfsFailed = false;
    const at = now();
    const next = new Map(present.map((device) => [device.port, device]));
    const previous = usbPresent;
    const added = previous ? present.filter((device) => !previous.has(device.port)) : [];
    const removed = previous ? [...previous.values()].filter((device) => !next.has(device.port)) : [];
    if (!previous) {
      // the first poll after start: record what is plugged in without reporting it as new
      const stored = new Map(seenRows().map((row) => [row.usb_port, row]));
      for (const device of present) {
        const row = stored.get(device.port);
        if (row && row.present === 1) upsertSeen.run(device.port, device.vendor, device.product, null, null, null, at, at);
        else pluggedSeen.run(device.port, device.vendor, device.product, at, at);
      }
      for (const row of stored.values()) if (row.present === 1 && !next.has(row.usb_port)) unpluggedSeen.run(at, row.usb_port);
    } else {
      for (const device of added) pluggedSeen.run(device.port, device.vendor, device.product, at, at);
      for (const device of removed) unpluggedSeen.run(at, device.port);
    }
    usbPresent = next;
    if (added.length > 0 || removed.length > 0) {
      log.info('USB modem devices changed', { added: added.map((d) => `${d.port} ${d.vendor}:${d.product}`), removed: removed.map((d) => `${d.port} ${d.vendor}:${d.product}`) });
      try {
        onUsbChange?.({ added, removed, present });
      } catch (err) {
        log.error('USB change handler failed', { err });
      }
      schedule();
    }
    return { added, removed, present };
  }

  /**
   * One refresh: ShowDevices → rows → devices_seen → states → bus.
   * @returns {Promise<RefreshResult>}
   */
  async function refreshOnce() {
    /** @type {RefreshResult} */
    const result = { skipped: null, modems: 0, listed: 0, errors: { quectel: null, dongle: null }, published: [] };
    const reg = registry();
    if (!reg) {
      if (!registryFailed) log.warn('modem state not refreshed: the registry cannot be loaded; the stored rows are kept');
      registryFailed = true;
      result.skipped = 'registry';
      return result;
    }
    if (registryFailed) log.info('the registry loads again; modem state refresh resumed');
    registryFailed = false;
    result.modems = reg.modems.length;
    /** @type {Map<string, DeviceEntry> | null} */
    let entries = null;
    if (ami && ami.connected) {
      const listed = await showAllDevices(ami, { timeout: t.actionTimeoutMs });
      entries = listed.entries;
      result.errors = listed.errors;
      result.listed = entries.size;
    } else {
      result.skipped = ami ? `AMI ${ami.state}` : 'no AMI';
    }
    if (stopped) return result;
    const at = now();
    /** Ports per device from the entries' data ttys. @type {Map<string, import('./sysfs.js').UsbDevice | null>} */
    const placed = new Map();
    /** What devices_seen holds before this refresh, by port; reused when nothing is written. */
    const stored = new Map(seenRows().map((row) => [row.usb_port, row]));
    let wrote = false;
    if (entries) {
      for (const entry of entries.values()) {
        if (!entry.dataTty) continue;
        const usb = placeTty(entry.dataTty);
        placed.set(entry.device, usb);
        if (!usb) continue;
        const imei = entry.imei && IMEI.test(entry.imei) ? entry.imei : null;
        const imsi = entry.imsi && IMSI.test(entry.imsi) ? entry.imsi : null;
        // Skip the write while the identity is unchanged and last_seen is recent, to limit SD-card writes.
        if (seenIsCurrent(stored.get(usb.port), usb, imei, imsi, entry.dataTty, at)) continue;
        upsertSeen.run(usb.port, usb.vendor, usb.product, imei, imsi, entry.dataTty, at, at);
        wrote = true;
      }
    }
    const seen = wrote ? seenRows() : [...stored.values()];
    const seenForUi = usbPresent === null ? null : seen;
    const ids = new Set(reg.modems.map((modem) => modem.id));
    for (const modem of reg.modems) {
      /** @type {ModemState | null} */
      let row = rows.get(modem.id) ?? null;
      if (entries) {
        const entry = entries.get(modem.id) ?? null;
        const usb = entry ? placed.get(modem.id) ?? null : null;
        const count = disconnectCount(modem.id);
        /** @type {Detail} */
        const detail = {
          listed: entry !== null,
          current: entry?.current ?? null,
          desired: entry?.desired ?? null,
          imei: entry?.imei ?? null,
          imsi: entry?.imsi ?? null,
          audio: entry?.audio ?? null,
          manufacturer: entry?.manufacturer ?? null,
          model: entry?.model ?? null,
          firmware: entry?.firmware ?? null,
          calls: entry?.calls ?? 0,
          radio: entry?.radio ?? null,
          disconnects: count,
          flapping: count >= t.flapDisconnects,
          vendor: usb?.vendor ?? null,
          product: usb?.product ?? null,
          reason: null,
          forwarding: storedForwarding(modem.id),
        };
        if (!entry) detail.reason = result.errors[modem.driver] ? `${modem.driver} driver: ${result.errors[modem.driver]}` : `${modem.driver} driver does not list the device (registry not applied?)`;
        else if (!(entry.state in DRIVER_STATES)) detail.reason = `unknown driver state ${JSON.stringify(entry.state)}`;
        row = {
          modem_id: modem.id,
          state: 'unverified',
          driver_state: entry?.state ?? null,
          gsm_reg: entry?.gsmReg ?? null,
          rssi: entry?.rssi ?? null,
          provider: entry?.provider ?? null,
          number: entry?.number ?? null,
          data_tty: entry?.dataTty ?? null,
          usb_port: usb?.port ?? null,
          observed_at: at,
          detail,
        };
        row.state = uiState(modem, row, seenForUi, { now: at, staleMs: t.staleMs });
        rows.set(modem.id, row);
        signalRemap(modem, row, seen);
      }
      // what the UI should show now: the last observation, judged at this moment (stale rows turn unverified while AMI is down)
      const shown = row ? { ...row, state: uiState(modem, row, seenForUi, { now: at, staleMs: t.staleMs }) } : null;
      const key = shown ? fingerprint(shown) : `unverified:${modem.enabled}:${modem.uac}:${modem.usb_port}`;
      if (published.get(modem.id) !== key) {
        published.set(modem.id, key);
        result.published.push(modem.id);
        bus.publish('modem.state', shown ?? { modem_id: modem.id, state: uiState(modem, null, seenForUi, { now: at, staleMs: t.staleMs }), driver_state: null, gsm_reg: null, rssi: null,
          provider: null, number: null, data_tty: null, usb_port: null, observed_at: null, detail: null });
      }
    }
    for (const id of [...rows.keys()]) {
      if (ids.has(id)) continue;
      deleteForwarding.run(id);
      rows.delete(id);
      published.delete(id);
      remapReported.delete(id);
    }
    return result;
  }

  /**
   * @param {Modem} modem
   * @param {ModemState} row
   * @param {SeenDevice[]} seen
   */
  function signalRemap(modem, row, seen) {
    const reason = remapReason(modem, { observedPort: row.usb_port, usbPresent: usbPresent ? [...usbPresent.values()] : null, seen, registeredPorts: registeredPorts() });
    if (reason === null) {
      remapReported.delete(modem.id);
      return;
    }
    if (remapReported.get(modem.id) === reason) return;
    remapReported.set(modem.id, reason);
    log.info('remap needed', { modem: modem.id, reason });
    try {
      onRemapNeeded?.(modem.id, reason);
    } catch (err) {
      log.error('remap handler failed', { modem: modem.id, err });
    }
  }

  /** usb_port → modem id of the current registry. */
  function registeredPorts() {
    /** @type {Map<string, string>} */
    const out = new Map();
    for (const modem of registry()?.modems ?? []) if (modem.usb_port !== null) out.set(modem.usb_port, modem.id);
    return out;
  }

  /** @returns {Promise<RefreshResult>} */
  function refresh() {
    if (running) {
      again = true;
      return running;
    }
    running = refreshOnce().catch((err) => {
      log.warn('modem state refresh failed', { err: errorText(err) });
      return /** @type {RefreshResult} */ ({ skipped: `failed: ${errorText(err)}`, modems: 0, listed: 0, errors: { quectel: null, dongle: null }, published: [] });
    }).finally(() => {
      running = null;
      if (again && !stopped) {
        again = false;
        void refresh();
      }
    });
    return running;
  }

  function schedule() {
    if (stopped || !started || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void refresh();
    }, t.debounceMs);
  }

  /** @param {Packet} packet */
  function onStatus(packet) {
    const device = header(packet, 'Device');
    if (!device) return;
    if (header(packet, 'Status') === 'Disconnect') disconnects.set(device, [...(disconnects.get(device) ?? []), now()]);
    schedule();
  }

  return {
    /** Starts the periodic refresh, the sysfs poll, and the listeners (Status events, AMI up, operation ends). */
    start() {
      if (started) throw new Error('device state already started');
      started = true;
      if (ami) {
        ami.on('event:QuectelStatus', onStatus);
        ami.on('event:DongleStatus', onStatus);
        ami.on('up', schedule);
      }
      unsubscribe = bus.subscribe((event) => {
        if (event.type !== 'op.progress') return;
        const payload = /** @type {{ kind?: string, status?: string }} */ (event.payload);
        if (payload.kind && REFRESH_AFTER.has(payload.kind) && payload.status && FINISHED.has(payload.status)) schedule();
      });
      pollSysfs();
      void refresh();
      refreshTimer = setInterval(() => void refresh(), t.refreshMs);
      sysfsTimer = setInterval(() => pollSysfs(), t.sysfsPollMs);
    },
    /** Stops timers and listeners; resolves once a running refresh has ended. */
    async stop() {
      stopped = true;
      if (refreshTimer) clearInterval(refreshTimer);
      if (sysfsTimer) clearInterval(sysfsTimer);
      if (debounce) clearTimeout(debounce);
      refreshTimer = sysfsTimer = debounce = null;
      if (ami) {
        ami.off('event:QuectelStatus', onStatus);
        ami.off('event:DongleStatus', onStatus);
        ami.off('up', schedule);
      }
      unsubscribe?.();
      unsubscribe = null;
      if (running) await running;
    },
    refresh,
    /** A refresh soon (debounced), as after a Status event. */
    schedule,
    pollSysfs,
    /** The last observation per modem id; held only in memory. */
    states: () => new Map(rows),
    /** devices_seen rows. */
    seen: seenRows,
    /** Modem devices plugged in per the last sysfs poll; null when unknown. */
    usb: () => (usbPresent ? [...usbPresent.values()] : null),
    /** The UI state of a modem now (stale rows are unverified). @param {Modem} modem */
    stateOf: (modem) => uiState(modem, rows.get(modem.id) ?? null, usbPresent === null ? null : seenRows(), { now: now(), staleMs: t.staleMs }),
    /** Records a Disconnect for the flapping counter (tests). @param {string} device @param {number} [at] */
    noteDisconnect(device, at = now()) {
      disconnects.set(device, [...(disconnects.get(device) ?? []), at]);
    },
  };
}
