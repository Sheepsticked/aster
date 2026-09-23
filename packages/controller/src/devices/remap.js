// @ts-check
// Aster controller — remap: a registered modem that moved to another USB port gets its `usb_port` updated and the
// generated files re-applied. remapReason() is the trigger; the `remap` operation finds the port via the driver, then
// `<driver> discovery` by IMEI, then the single unregistered device of the vendor (several → manual Assign, none → absent).
// Usage: const ops = createRemapOps({ paths, apply: configOps.apply, log }); ops.register(runner);
//        runner.enqueue({ kind: 'remap', modemId: 'gsm1', params: { reason }, actor: 'system' })
import { AmiError } from '../ami/client.js';
import { load as loadRegistry } from '../config/registry.js';
import { OperationError } from '../ops/runner.js';
import { parseDiscovery } from './scan.js';
import { showDevices } from './state.js';
import { listUsbModems, MODEM_VENDORS, usbPortOfTty } from './sysfs.js';

/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../config/registry.js').Modem} Modem */
/** @typedef {import('./sysfs.js').UsbModem} UsbModem */
/** @typedef {import('./state.js').SeenDevice} SeenDevice */
/**
 * @typedef {object} Timing
 * @property {number} actionTimeoutMs     AMI actions and ShowDevices (30 s)
 * @property {number} discoveryTimeoutMs  `<driver> discovery` probes every free port (120 s)
 * @property {number} confirmTimeoutMs    wait for the graceful Stop (60 s)
 * @property {number} pollMs              ShowDevices poll while waiting (2 s)
 */
/**
 * @typedef {object} Options
 * @property {{ registry: string }} paths
 * @property {(ctx: Context, params: { registry: unknown, base_hash: string | null, force?: boolean }) => Promise<Record<string, unknown>>} apply  the registry-apply logic (createConfigOps().apply)
 * @property {Logger} [log]
 * @property {string} [sysfsRoot]
 * @property {() => number} [now]
 * @property {Partial<Timing>} [timing]
 */

export const KIND = 'remap';
export const DEFAULTS = Object.freeze({ actionTimeoutMs: 30_000, discoveryTimeoutMs: 120_000, confirmTimeoutMs: 60_000, pollMs: 2_000 });

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {'quectel' | 'dongle'} driver */
const prefix = (driver) => (driver === 'quectel' ? 'Quectel' : 'Dongle');
const VENDOR_OF = Object.freeze({ quectel: '2c7c', dongle: '12d1' });

/**
 * Why a modem needs a remap now, or null. Fixed `ports` and disabled modems are never remapped automatically.
 * @param {Pick<Modem, 'id' | 'driver' | 'enabled' | 'imei' | 'usb_port' | 'ports'>} modem
 * @param {object} facts
 * @param {string | null} facts.observedPort   the port of the driver's DataState per sysfs (null when the device has no tty)
 * @param {ReadonlyArray<UsbModem> | null} facts.usbPresent  plugged-in modem devices; null when sysfs is unknown
 * @param {ReadonlyArray<Pick<SeenDevice, 'usb_port' | 'imei' | 'present'>>} facts.seen
 * @param {ReadonlyMap<string, string>} facts.registeredPorts  usb_port → modem id, every registry modem
 * @returns {string | null}
 */
export function remapReason(modem, { observedPort, usbPresent, seen, registeredPorts }) {
  if (modem.ports !== null || !modem.enabled) return null;
  if (observedPort !== null) {
    if (modem.usb_port === null) return `the ${modem.driver} driver has the device on USB port ${observedPort}; the registry has no usb_port yet`;
    if (observedPort !== modem.usb_port) return `the ${modem.driver} driver has the device on USB port ${observedPort}; the registry says ${modem.usb_port}`;
    return null;
  }
  if (modem.usb_port !== null && usbPresent && !usbPresent.some((device) => device.port === modem.usb_port)) {
    const free = usbPresent.filter((device) => device.driver === modem.driver && !registeredPorts.has(device.port)).map((device) => device.port);
    if (free.length > 0) return `USB port ${modem.usb_port} is not plugged in while an unregistered ${VENDOR_OF[modem.driver]} device is present on ${free.join(', ')}`;
  }
  const elsewhere = seen.find((row) => row.present === 1 && row.imei === modem.imei && row.usb_port !== modem.usb_port);
  if (elsewhere) return `IMEI ${modem.imei} was seen on USB port ${elsewhere.usb_port}${modem.usb_port === null ? '' : `, not on ${modem.usb_port}`}`;
  return null;
}

/**
 * @param {Options} options
 */
export function createRemapOps({ paths, apply, log = SILENT, sysfsRoot = '/sys', now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };

  /** @param {string} message @param {Record<string, unknown>} [result] */
  const failed = (message, result) => new OperationError(message, { status: 'failed', result: result ? { ...result, observed_at: now() } : undefined });
  /** @param {string} message @param {Record<string, unknown>} [result] */
  const uncertain = (message, result) => new OperationError(message, { status: 'uncertain', result: result ? { ...result, observed_at: now() } : undefined });

  /** @param {Context} ctx */
  function requireAmi(ctx) {
    if (!ctx.ami) throw failed('the controller has no AMI connection to Asterisk; the modem was not remapped');
    if (!ctx.ami.connected) throw failed(`Asterisk is not connected over AMI (${ctx.ami.lastError ? errorText(ctx.ami.lastError) : ctx.ami.state}); the modem was not remapped`);
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

  /**
   * @param {AmiClient} ami
   * @param {Modem} modem
   * @returns {Promise<import('./state.js').DeviceEntry | null>}
   */
  async function entryOf(ami, modem) {
    const entries = await showDevices(ami, modem.driver, { device: modem.id, timeout: t.actionTimeoutMs });
    return entries[0] ?? null;
  }

  /** @param {Context} ctx */
  async function remap(ctx) {
    const modemId = ctx.op.modemId;
    if (modemId === null) throw failed('remap needs the modem id');
    const { registry: reg, hash } = loadRegistry(paths.registry);
    const modem = reg.modems.find((entry) => entry.id === modemId);
    if (!modem) throw failed(`modem ${modemId} is not in the registry`);
    if (modem.ports !== null) throw failed(`modem ${modemId} uses fixed ports (${modem.ports.data}); there is nothing to remap`);
    const ami = requireAmi(ctx);
    const others = new Map(reg.modems.filter((entry) => entry.id !== modem.id && entry.usb_port !== null).map((entry) => [entry.usb_port, entry.id]));
    /** @type {Record<string, unknown>} */
    const result = { modem_id: modem.id, driver: modem.driver, previous_port: modem.usb_port, port: null, found: false, by: null, changed: false, stopped: false, restarted: false, cleared: [], candidates: [], apply: null };

    ctx.progress('locating the device');
    /** @type {{ port: string, by: 'driver' | 'discovery' | 'sysfs' } | null} */
    let found = null;
    let entry = await entryOf(ami, modem);
    if (entry?.dataTty) {
      const usb = place(entry.dataTty);
      if (usb) found = { port: usb.port, by: 'driver' };
    }
    if (!found) {
      // A running device locks its ports against discovery, so stop it first.
      if (entry && entry.state !== 'Stopped') {
        ctx.progress(`${prefix(modem.driver)}Stop ${modem.id}`);
        try {
          await ami.action(`${prefix(modem.driver)}Stop`, { Device: modem.id, When: 'gracefully' }, { timeout: t.actionTimeoutMs });
        } catch (err) {
          throw failed(`${prefix(modem.driver)}Stop ${modem.id}: ${errorText(err)}`, result);
        }
        result.stopped = true;
        const deadline = now() + t.confirmTimeoutMs;
        for (;;) {
          entry = await entryOf(ami, modem);
          if (!entry || entry.state === 'Stopped') break;
          if (now() >= deadline) throw uncertain(`${modem.id} did not stop within ${Math.round(t.confirmTimeoutMs / 1000)} s (state ${entry.state}; a graceful stop waits for calls to end), so its port could not be probed`, result);
          await sleep(t.pollMs);
        }
      }
      ctx.progress(`${modem.driver} discovery`);
      /** @type {string[]} */
      let lines;
      try {
        lines = await ami.command(`${modem.driver} discovery`, { timeout: t.discoveryTimeoutMs });
      } catch (err) {
        if (err instanceof AmiError) throw failed(`${modem.driver} discovery: ${errorText(err)}`, result);
        throw uncertain(`${modem.driver} discovery: ${errorText(err)}`, result);
      }
      const discovered = parseDiscovery(lines, modem.driver);
      const hit = discovered.find((device) => device.imei === modem.imei);
      const hitPort = hit ? place(hit.data_tty) : null;
      if (hitPort) found = { port: hitPort.port, by: 'discovery' };
      else {
        // Discovery sometimes reports an empty or wrong IMEI: fall back to the one free probed device.
        /** @type {UsbModem[]} */
        let present = [];
        try {
          present = listUsbModems(sysfsRoot);
        } catch (err) {
          throw uncertain(`the device was not found by ${modem.driver} discovery and sysfs is not readable (${errorText(err)})`, result);
        }
        const probed = new Set(discovered.map((device) => place(device.data_tty)?.port).filter((port) => port !== undefined));
        const candidates = present.filter((device) => device.driver === modem.driver && !others.has(device.port) && probed.has(device.port)).map((device) => device.port);
        result.candidates = candidates;
        if (candidates.length === 1) found = { port: /** @type {string} */ (candidates[0]), by: 'sysfs' };
        else if (candidates.length > 1) {
          throw failed(`${modem.id} answered no discovery with IMEI ${modem.imei}, and ${candidates.length} unregistered ${VENDOR_OF[modem.driver]} devices are plugged in (${candidates.join(', ')}); assign the port by hand`, result);
        }
      }
    }
    if (!found) {
      if (result.stopped) await startAgain(ctx, ami, modem, result);
      throw failed(`${modem.id} (IMEI ${modem.imei}) was not found on any USB port${modem.usb_port === null ? '' : `: ${modem.usb_port} is not plugged in`} and no free ${VENDOR_OF[modem.driver]} device answered ${modem.driver} discovery; the modem is absent`, result);
    }
    result.found = true;
    result.by = found.by;
    result.port = found.port;
    if (found.by === 'sysfs') log.warn('remap by presence only: the device on the port did not report its IMEI', { modem: modem.id, port: found.port });
    if (found.port === modem.usb_port) {
      if (result.stopped) await startAgain(ctx, ami, modem, result);
      return { ...result, observed_at: now() };
    }

    ctx.progress(`usb_port ${modem.usb_port ?? 'none'} → ${found.port}`);
    const updated = structuredClone(/** @type {any} */ (reg));
    for (const other of updated.modems) {
      if (other.id !== modem.id && other.usb_port === found.port) {
        other.usb_port = null;
        /** @type {string[]} */ (result.cleared).push(other.id);
      }
    }
    const target = updated.modems.find((/** @type {{ id: string }} */ other) => other.id === modem.id);
    target.usb_port = found.port;
    const applied = await apply(ctx, { registry: updated, base_hash: hash });
    result.changed = true;
    result.apply = { registry_hash: applied.registry_hash, files_written: applied.files_written, actions: applied.actions, restarted: applied.restarted };
    if (result.stopped) await startAgain(ctx, ami, modem, result);
    return { ...result, observed_at: now() };
  }

  /**
   * @param {Context} ctx
   * @param {AmiClient} ami
   * @param {Modem} modem
   * @param {Record<string, unknown>} result
   */
  async function startAgain(ctx, ami, modem, result) {
    ctx.progress(`${prefix(modem.driver)}Start ${modem.id}`);
    try {
      await ami.action(`${prefix(modem.driver)}Start`, { Device: modem.id, When: 'now' }, { timeout: t.actionTimeoutMs });
      result.restarted = true;
    } catch (err) {
      log.warn('the device stopped for discovery could not be started again', { modem: modem.id, err: errorText(err) });
    }
  }

  /** @type {Runner | null} */
  let registered = null;
  /** @type {import('node:sqlite').StatementSync | null} */
  let pending = null;

  return {
    handlers: Object.freeze({ [KIND]: remap }),
    /** Registers `remap` (global lock: it writes the registry; rerun after a controller restart). @param {Runner} runner */
    register(runner) {
      runner.register(KIND, remap, { lock: 'global', reevaluate: 'rerun' });
      registered = runner;
    },
    /**
     * The automatic trigger (state.js onRemapNeeded): enqueues a system `remap` for the modem unless one is already queued or running.
     * @param {string} modemId
     * @param {string} reason
     * @param {import('node:sqlite').DatabaseSync} db
     * @returns {number | null} the operation id, or null when skipped
     */
    trigger(modemId, reason, db) {
      if (!registered) return null;
      pending ??= db.prepare(`SELECT id FROM operations WHERE kind = '${KIND}' AND modem_id = ? AND status IN ('queued', 'running') LIMIT 1`);
      if (pending.get(modemId)) {
        log.info('remap already pending', { modem: modemId, reason });
        return null;
      }
      const id = registered.enqueue({ kind: KIND, modemId, params: { reason, trigger: 'auto' }, actor: 'system' });
      log.info('remap queued', { modem: modemId, reason, operation: id });
      return id;
    },
  };
}
