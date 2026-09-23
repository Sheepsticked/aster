// @ts-check
// Aster controller — scan for unassigned modems: runs `quectel discovery` and `dongle discovery`, merges the devices by
// data tty, places them on USB ports, marks the ones a registry modem owns and stores the result for `GET /api/scan/latest`.
// A modem device appearing in sysfs queues an auto-scan after a short delay.
// Usage: const ops = createScanOps({ db, registry: () => load(path).registry, log }); ops.register(runner); ops.onUsbChange({ added, … })
//        runner.enqueue({ kind: 'scan', modemId: null, params: {}, actor: 'admin' })
import { AmiError } from '../ami/client.js';
import { OperationError } from '../ops/runner.js';
import { MODEM_VENDORS, usbPortOfTty } from './sysfs.js';

/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('./sysfs.js').UsbModem} UsbModem */
/** @typedef {'quectel' | 'dongle'} Driver */
/**
 * @typedef {object} DiscoveredDevice  one block of a discovery command's output
 * @property {Driver} driver        the driver that printed it
 * @property {string | null} section  the suggested section name (`dc_1234_`)
 * @property {string} data_tty      `/dev/ttyUSB5`
 * @property {string | null} audio_tty
 * @property {string | null} imei   15 digits, else null
 * @property {string | null} imsi   6–15 digits and not the IMEI, else null
 */
/**
 * @typedef {object} ScannedDevice  a discovered device placed and classified
 * @property {Driver[]} found_by
 * @property {string} data_tty
 * @property {string | null} audio_tty
 * @property {string | null} imei
 * @property {string | null} imsi
 * @property {string | null} usb_port
 * @property {string | null} vendor
 * @property {string | null} product
 * @property {Driver} suggested_driver  by USB vendor (2c7c → quectel, 12d1 → dongle), else the driver that found it
 * @property {string | null} registered  the registry modem that owns it (IMEI, fixed data port or usb_port), else null
 */
/**
 * @typedef {object} ScanResult
 * @property {number} at
 * @property {string} trigger
 * @property {ScannedDevice[]} devices
 * @property {ScannedDevice[]} unassigned
 * @property {Record<Driver, string | null>} errors  a discovery command that failed
 */
/**
 * @typedef {object} Options
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {() => Registry | null} registry
 * @property {Logger} [log]
 * @property {string} [sysfsRoot]
 * @property {() => number} [now]
 * @property {AmiClient | null} [ami]  for the auto-scan's "AMI is down" check
 * @property {Partial<{ actionTimeoutMs: number, autoScanDelayMs: number }>} [timing]
 */

export const KIND = 'scan';
export const SETTING = 'scan_latest';
export const DEFAULTS = Object.freeze({ actionTimeoutMs: 120_000, autoScanDelayMs: 10_000 });
export const DRIVERS = Object.freeze(/** @type {const} */ (['quectel', 'dongle']));
const IMEI = /^[0-9]{15}$/;
const IMSI = /^[0-9]{6,15}$/;
const SECTION = /^\[([^\]]*)\]/;
const FIELD = /^;?\s*(audio|data|imei|imsi)\s*=\s*(.*)$/;
const UPSERT_SETTING = `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
const SELECT_SETTING = 'SELECT value FROM settings WHERE key = ?';
const UPSERT_SEEN = `INSERT INTO devices_seen (usb_port, vendor, product, imei, imsi, data_tty, first_seen, last_seen, present) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT (usb_port) DO UPDATE SET vendor = COALESCE(excluded.vendor, devices_seen.vendor), product = COALESCE(excluded.product, devices_seen.product),
  imei = COALESCE(excluded.imei, devices_seen.imei), imsi = COALESCE(excluded.imsi, devices_seen.imsi), data_tty = excluded.data_tty, last_seen = excluded.last_seen, present = 1`;
const PENDING_SCAN = `SELECT id FROM operations WHERE kind = '${KIND}' AND status IN ('queued', 'running') LIMIT 1`;

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * The devices in a discovery command's output lines (Output headers of the Command action, or CLI lines).
 * The driver can print the IMEI as the IMSI, so an IMSI equal to the IMEI is dropped.
 * @param {readonly string[]} lines
 * @param {Driver} driver
 * @returns {DiscoveredDevice[]}
 */
export function parseDiscovery(lines, driver) {
  /** @type {DiscoveredDevice[]} */
  const out = [];
  /** @type {{ section: string | null, data: string | null, audio: string | null, imei: string | null, imsi: string | null } | null} */
  let current = null;
  const flush = () => {
    if (current && current.data) {
      const imei = current.imei && IMEI.test(current.imei) ? current.imei : null;
      const imsi = current.imsi && IMSI.test(current.imsi) && current.imsi !== imei ? current.imsi : null;
      out.push({ driver, section: current.section, data_tty: current.data, audio_tty: current.audio || null, imei, imsi });
    }
    current = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '') continue;
    const section = SECTION.exec(line);
    if (section) {
      flush();
      current = { section: section[1] ?? null, data: null, audio: null, imei: null, imsi: null };
      continue;
    }
    const field = FIELD.exec(line);
    if (!field) continue;
    if (!current) current = { section: null, data: null, audio: null, imei: null, imsi: null };
    const value = (field[2] ?? '').trim();
    if (field[1] === 'data') current.data = value || null;
    else if (field[1] === 'audio') current.audio = value || null;
    else if (field[1] === 'imei') current.imei = value || null;
    else current.imsi = value || null;
  }
  flush();
  return out;
}

/**
 * @param {Options} options
 */
export function createScanOps({ db, registry, log = SILENT, sysfsRoot = '/sys', now = Date.now, ami = null, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };
  const upsertSetting = db.prepare(UPSERT_SETTING);
  const selectSetting = db.prepare(SELECT_SETTING);
  const upsertSeen = db.prepare(UPSERT_SEEN);
  const pendingScan = db.prepare(PENDING_SCAN);
  /** @type {Runner | null} */
  let runner = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {string[]} */
  let pendingPorts = [];

  /** @param {string} message @param {Record<string, unknown>} [result] */
  const failed = (message, result) => new OperationError(message, { status: 'failed', result: result ? { ...result, observed_at: now() } : undefined });

  /** @param {Context} ctx */
  function requireAmi(ctx) {
    if (!ctx.ami) throw failed('the controller has no AMI connection to Asterisk; nothing was scanned');
    if (!ctx.ami.connected) throw failed(`Asterisk is not connected over AMI (${ctx.ami.lastError ? errorText(ctx.ami.lastError) : ctx.ami.state}); nothing was scanned`);
    return ctx.ami;
  }

  /** @param {string} tty */
  function place(tty) {
    try {
      return usbPortOfTty(tty, sysfsRoot);
    } catch (err) {
      log.warn('cannot place a tty on a USB port', { tty, err: errorText(err) });
      return null;
    }
  }

  /** @param {Context} ctx */
  async function scan(ctx) {
    const ami = requireAmi(ctx);
    const trigger = typeof ctx.op.params?.trigger === 'string' ? ctx.op.params.trigger : 'manual';
    /** @type {Record<Driver, string | null>} */
    const errors = { quectel: null, dongle: null };
    /** @type {DiscoveredDevice[]} */
    const discovered = [];
    for (const driver of DRIVERS) {
      ctx.progress(`${driver} discovery`);
      try {
        discovered.push(...parseDiscovery(await ami.command(`${driver} discovery`, { timeout: t.actionTimeoutMs }), driver));
      } catch (err) {
        if (!(err instanceof AmiError)) throw err;
        errors[driver] = errorText(err);
        log.warn('discovery command failed', { driver, err: errors[driver] });
      }
    }
    if (errors.quectel !== null && errors.dongle !== null) throw failed(`both discovery commands failed: quectel: ${errors.quectel}; dongle: ${errors.dongle}`);
    const reg = registry();
    const modems = reg?.modems ?? [];
    if (!reg) log.warn('scan: the registry cannot be loaded; every device counts as unassigned');
    const at = now();
    /** @type {Map<string, ScannedDevice>} */
    const byTty = new Map();
    for (const device of discovered) {
      const existing = byTty.get(device.data_tty);
      if (existing) {
        if (!existing.found_by.includes(device.driver)) existing.found_by.push(device.driver);
        existing.imei ??= device.imei;
        existing.imsi ??= device.imsi;
        existing.audio_tty ??= device.audio_tty;
        continue;
      }
      const usb = place(device.data_tty);
      const vendorDriver = usb ? MODEM_VENDORS[/** @type {keyof typeof MODEM_VENDORS} */ (usb.vendor)] : undefined;
      byTty.set(device.data_tty, {
        found_by: [device.driver],
        data_tty: device.data_tty,
        audio_tty: device.audio_tty,
        imei: device.imei,
        imsi: device.imsi,
        usb_port: usb?.port ?? null,
        vendor: usb?.vendor ?? null,
        product: usb?.product ?? null,
        suggested_driver: vendorDriver ?? device.driver,
        registered: null,
      });
    }
    const devices = [...byTty.values()];
    for (const device of devices) {
      const owner = modems.find((modem) => device.imei !== null && modem.imei === device.imei)
        ?? modems.find((modem) => modem.ports !== null && modem.ports.data === device.data_tty)
        ?? modems.find((modem) => device.usb_port !== null && modem.usb_port === device.usb_port);
      device.registered = owner?.id ?? null;
      if (device.usb_port) upsertSeen.run(device.usb_port, device.vendor, device.product, device.imei, device.imsi, device.data_tty, at, at);
    }
    /** @type {ScanResult} */
    const result = { at, trigger, devices, unassigned: devices.filter((device) => device.registered === null), errors };
    upsertSetting.run(SETTING, JSON.stringify(result));
    log.info('scan finished', { trigger, devices: devices.length, unassigned: result.unassigned.length, errors });
    return { ...result, observed_at: at };
  }

  function autoScan() {
    timer = null;
    const ports = pendingPorts;
    pendingPorts = [];
    if (!runner) return;
    if (ami && !ami.connected) {
      log.warn('auto-scan skipped: AMI is not connected', { ports });
      return;
    }
    if (pendingScan.get()) {
      log.info('auto-scan skipped: a scan is already queued or running', { ports });
      return;
    }
    const id = runner.enqueue({ kind: KIND, modemId: null, params: { trigger: 'hotplug', ports }, actor: 'system' });
    log.info('auto-scan queued', { operation: id, ports });
  }

  return {
    handlers: Object.freeze({ [KIND]: scan }),
    /** Registers `scan` (its own queue, beside modem operations). @param {Runner} target */
    register(target) {
      target.register(KIND, scan);
      runner = target;
    },
    /**
     * A sysfs change (state.js): a modem device that appeared queues a scan after autoScanDelayMs (a further appearance restarts the delay).
     * @param {{ added: UsbModem[] }} change
     */
    onUsbChange({ added }) {
      if (added.length === 0) return;
      pendingPorts.push(...added.map((device) => device.port));
      if (timer) clearTimeout(timer);
      timer = setTimeout(autoScan, t.autoScanDelayMs);
    },
    /** The stored result of the last scan, or null. @returns {ScanResult | null} */
    latest() {
      const row = /** @type {{ value: string } | undefined} */ (selectSetting.get(SETTING));
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingPorts = [];
    },
  };
}
