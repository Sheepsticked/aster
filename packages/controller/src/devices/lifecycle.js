// @ts-check
// Aster controller — modem lifecycle operations (start, stop, restart, reset, remove): send the driver's action for the
// device and confirm the outcome through ShowDevices polls and Status events; unconfirmed in time → `uncertain`.
// A restart of a stopped device is refused (the driver would start it). All actions are idempotent, so they re-run after a restart.
// Usage: createLifecycleOps({ registry: () => load(path).registry, log }).register(runner);
//        runner.enqueue({ kind: 'modem-stop', modemId: 'gsm1', params: { when: 'gracefully' }, actor: 'admin' })
import { AmiError } from '../ami/client.js';
import { OperationError } from '../ops/runner.js';
import { showDevices } from './state.js';

/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../ami/parser.js').Packet} Packet */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('./state.js').DeviceEntry} DeviceEntry */
/** @typedef {'quectel' | 'dongle'} Driver */
/** @typedef {'start' | 'stop' | 'restart' | 'reset' | 'remove'} Verb */
/**
 * @typedef {object} Timing
 * @property {number} actionTimeoutMs   the action and each ShowDevices (30 s)
 * @property {number} confirmTimeoutMs  how long the outcome may take (60 s)
 * @property {number} pollMs            ShowDevices poll period (2 s)
 */
/**
 * @typedef {object} Options
 * @property {() => Registry | null} registry  to find the modem's driver
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {Partial<Timing>} [timing]
 */

export const KINDS = Object.freeze(/** @type {const} */ (['modem-start', 'modem-stop', 'modem-restart', 'modem-reset', 'modem-remove']));
export const WHEN = Object.freeze(/** @type {const} */ (['now', 'gracefully', 'when convenient']));
export const DEFAULTS = Object.freeze({ actionTimeoutMs: 30_000, confirmTimeoutMs: 60_000, pollMs: 2_000 });
/** @type {Readonly<Record<Verb, string>>} */
const ACTION = Object.freeze({ start: 'Start', stop: 'Stop', restart: 'Restart', reset: 'Reset', remove: 'Remove' });

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {Driver} driver */
const prefix = (driver) => (driver === 'quectel' ? 'Quectel' : 'Dongle');

/**
 * Whether the driver reached the wanted outcome.
 * @param {Verb} verb
 * @param {DeviceEntry | null} entry  the device's entry, null when not listed
 * @param {boolean} disconnected  a Status: Disconnect arrived since the action
 */
export function confirmed(verb, entry, disconnected) {
  switch (verb) {
    case 'start':
      return entry !== null && entry.desired === 'start' && entry.state !== 'Stopped';
    case 'stop':
      return entry !== null && entry.state === 'Stopped';
    case 'restart':
      return entry !== null && entry.desired === 'start';
    case 'remove':
      return entry === null;
    case 'reset':
      return disconnected || (entry !== null && entry.state === 'Not connected');
    default:
      return false;
  }
}

/**
 * @param {Options} options
 */
export function createLifecycleOps({ registry, log = SILENT, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };

  /** @param {string} message @param {Record<string, unknown>} [result] */
  const failed = (message, result) => new OperationError(message, { status: 'failed', result: result ? { ...result, observed_at: now() } : undefined });
  /** @param {string} message @param {Record<string, unknown>} [result] */
  const uncertain = (message, result) => new OperationError(message, { status: 'uncertain', result: result ? { ...result, observed_at: now() } : undefined });

  /** @param {Context} ctx @param {string} what */
  function requireAmi(ctx, what) {
    if (!ctx.ami) throw failed(`the controller has no AMI connection to Asterisk; the modem was not ${what}`);
    if (!ctx.ami.connected) throw failed(`Asterisk is not connected over AMI (${ctx.ami.lastError ? errorText(ctx.ami.lastError) : ctx.ami.state}); the modem was not ${what}`);
    return ctx.ami;
  }

  /**
   * @param {Verb} verb
   * @returns {(ctx: Context) => Promise<Record<string, unknown>>}
   */
  function handler(verb) {
    const past = { start: 'started', stop: 'stopped', restart: 'restarted', reset: 'reset', remove: 'removed' }[verb];
    return async (ctx) => {
      const modemId = ctx.op.modemId;
      if (modemId === null) throw failed(`modem-${verb} needs the modem id`);
      const params = ctx.op.params ?? {};
      /** @type {Driver} */
      let driver;
      const paramDriver = params.driver;
      if (paramDriver === 'quectel' || paramDriver === 'dongle') driver = paramDriver;
      else if (paramDriver !== undefined && paramDriver !== null) throw failed(`driver must be quectel or dongle, not ${JSON.stringify(paramDriver)}`);
      else {
        const reg = registry();
        if (!reg) throw failed('the registry cannot be loaded, so the modem\'s driver is unknown (pass params.driver)');
        const modem = reg.modems.find((entry) => entry.id === modemId);
        if (!modem) throw failed(`modem ${modemId} is not in the registry (pass params.driver for a device that is not registered)`);
        driver = modem.driver;
      }
      const when = params.when ?? 'gracefully';
      if (!WHEN.includes(/** @type {any} */ (when))) throw failed(`when must be one of ${WHEN.join(', ')}, not ${JSON.stringify(when)}`);
      const ami = requireAmi(ctx, past);
      const action = `${prefix(driver)}${ACTION[verb]}`;
      /** @type {Record<string, unknown>} */
      const result = { modem_id: modemId, driver, action, when: verb === 'reset' ? null : when, reply: null, confirmed: false, state: null, current: null, desired: null, events: [] };
      /** @type {string[]} */
      const events = /** @type {string[]} */ (result.events);
      let disconnected = false;
      /** @param {Packet} packet */
      const onStatus = (packet) => {
        const device = packet.get('Device');
        if ((Array.isArray(device) ? device[0] : device) !== modemId) return;
        const status = packet.get('Status');
        const text = String(Array.isArray(status) ? status[0] : status ?? '');
        events.push(text);
        if (text === 'Disconnect') disconnected = true;
      };
      const statusEvent = `event:${prefix(driver)}Status`;
      ami.on(statusEvent, onStatus);
      try {
        /** @type {DeviceEntry | null} */
        let entry = null;
        if (verb === 'restart') {
          entry = (await showDevices(ami, driver, { device: modemId, timeout: t.actionTimeoutMs }))[0] ?? null;
          if (!entry) throw failed(`${modemId} is not a device of chan_${driver}`, result);
          if (entry.state === 'Stopped') throw failed(`${modemId} is stopped; a Restart would start it — use start instead`, { ...result, state: entry.state, current: entry.current, desired: entry.desired });
        }
        ctx.progress(action);
        /** @type {Packet} */
        let reply;
        try {
          reply = await ami.action(action, verb === 'reset' ? { Device: modemId } : { Device: modemId, When: String(when) }, { timeout: t.actionTimeoutMs });
        } catch (err) {
          if (err instanceof AmiError) throw failed(`${action} ${modemId}: ${errorText(err)}`, result);
          throw uncertain(`${action} ${modemId}: ${errorText(err)}; whether the driver acted is unknown`, result);
        }
        const message = reply.get('Message');
        result.reply = Array.isArray(message) ? message.join(' ') : message ?? null;
        ctx.progress('confirming');
        const deadline = now() + t.confirmTimeoutMs;
        for (;;) {
          try {
            entry = (await showDevices(ami, driver, { device: modemId, timeout: t.actionTimeoutMs }))[0] ?? null;
          } catch (err) {
            throw uncertain(`the driver accepted ${action} for ${modemId} (${result.reply}), but the outcome could not be read: ${errorText(err)}`, result);
          }
          result.state = entry?.state ?? null;
          result.current = entry?.current ?? null;
          result.desired = entry?.desired ?? null;
          if (confirmed(verb, entry, disconnected)) {
            result.confirmed = true;
            break;
          }
          if (now() >= deadline) {
            const shown = entry ? `state ${entry.state}, current ${entry.current}, desired ${entry.desired}` : 'the device is not listed';
            throw uncertain(`the driver accepted ${action} for ${modemId} (${result.reply}), but it was not ${past} within ${Math.round(t.confirmTimeoutMs / 1000)} s: ${shown}${when === 'gracefully' && verb !== 'start' ? ' (a graceful action waits for calls to end)' : ''}`, result);
          }
          await sleep(t.pollMs);
        }
        log.info(`modem ${past}`, { modem: modemId, action, reply: result.reply, state: result.state });
        return { ...result, observed_at: now() };
      } finally {
        ami.off(statusEvent, onStatus);
      }
    };
  }

  const handlers = Object.freeze({
    'modem-start': handler('start'),
    'modem-stop': handler('stop'),
    'modem-restart': handler('restart'),
    'modem-reset': handler('reset'),
    'modem-remove': handler('remove'),
  });

  return {
    handlers,
    /** Registers the five kinds on the modem's queue; interrupted ones run again at the next start. @param {Runner} runner */
    register(runner) {
      for (const kind of KINDS) runner.register(kind, handlers[kind], { reevaluate: 'rerun' });
    },
  };
}
