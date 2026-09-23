// @ts-check
// Aster controller — AT transactions over the patched `{Quectel,Dongle}AtCommand` action, correlated by ActionID only.
// The `at` operation runs on the modem's queue: a driver verdict ends done or failed; no verdict (disconnect, deadline) is uncertain.
// Usage: const atOps = createAtOps({ registry }); atOps.register(runner); const op = await atOps.run('gsm1', 'AT+CSQ', { actor: 'admin' })
import { AmiError } from '../ami/client.js';
import { OperationError } from '../ops/runner.js';

/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../ami/parser.js').Packet} Packet */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('../ops/runner.js').Operation} Operation */
/** @typedef {import('../ops/runner.js').Actor} Actor */
/** @typedef {'quectel' | 'dongle'} Driver */
/** @typedef {'OK' | 'ERROR' | 'TIMEOUT' | 'refused' | 'disconnected' | 'down' | 'deadline'} Outcome */
/**
 * @typedef {object} Transaction  what one command produced
 * @property {string} action_id
 * @property {string} device
 * @property {string} command
 * @property {number} timeout_s     the driver's wait for the final line
 * @property {string | null} reply  the driver's ack (`[gsm1] AT command queued`) or its refusal
 * @property {Outcome} outcome
 * @property {string | null} error  the `Error:` text, the refusal, or why there was no AtDone (null for OK)
 * @property {string[]} lines       every AtResponse Line of the transaction, in order
 * @property {number} sent_at
 * @property {number} observed_at
 */
/**
 * @typedef {object} TransactOptions
 * @property {Driver} driver
 * @property {string} device
 * @property {string} command          1–256 characters, no CR/LF/NUL, not starting with a blank
 * @property {string} actionId         `[A-Za-z0-9._-]{1,63}`, not `ami-…`, unique per transaction
 * @property {number} [timeoutS]       1–60 (default 15)
 * @property {number} [graceMs]        added to the timeout for the deadline (5 s)
 * @property {number} [actionTimeoutMs]  the wait for the driver's ack (30 s)
 * @property {Logger} [log]
 * @property {() => number} [now]
 */
/**
 * @typedef {object} Options
 * @property {() => Registry | null} registry  to find a modem's driver
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {Partial<typeof DEFAULTS>} [timing]
 */

export const KIND = 'at';
export const DEFAULT_TIMEOUT_S = 15;
export const MAX_TIMEOUT_S = 60;
export const MAX_COMMAND_LENGTH = 256;
/** @type {Readonly<{ graceMs: number, actionTimeoutMs: number }>} */
export const DEFAULTS = Object.freeze({ graceMs: 5_000, actionTimeoutMs: 30_000 });
export const ACTION_ID = /^[A-Za-z0-9._-]{1,63}$/;
export const OUTCOMES = Object.freeze(/** @type {const} */ (['OK', 'ERROR', 'TIMEOUT', 'refused', 'disconnected', 'down', 'deadline']));
/** The outcomes with a driver verdict (an AtDone or a refusal): an operation ends failed on them, uncertain on the others. */
export const DEFINITE = Object.freeze(/** @type {const} */ (['OK', 'ERROR', 'TIMEOUT', 'refused']));

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {unknown} err */
export const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {Driver} driver */
export const prefix = (driver) => (driver === 'quectel' ? 'Quectel' : 'Dongle');
/** The first value of a header (a repeated header is an array). @param {unknown} value */
const first = (value) => (value === undefined ? undefined : String(Array.isArray(value) ? value[0] : value));
/** The last value of a header: with manager debug on, AtResponse carries two `Line:` headers. @param {unknown} value */
const last = (value) => (value === undefined ? undefined : String(Array.isArray(value) ? value[value.length - 1] : value));

/**
 * The command as the driver accepts it (manager.c: 1–256 characters, no CR/LF); a leading blank would be stripped by Asterisk.
 * @param {unknown} command
 */
export function checkCommand(command) {
  if (typeof command !== 'string') throw new TypeError('the AT command must be a string');
  if (command.length < 1 || command.length > MAX_COMMAND_LENGTH) throw new RangeError(`the AT command must be 1 to ${MAX_COMMAND_LENGTH} characters, not ${command.length}`);
  if (/[\r\n\x00]/.test(command)) throw new TypeError('the AT command must not contain CR, LF or NUL');
  if (command.charCodeAt(0) <= 0x20) throw new TypeError('the AT command must not start with a blank');
  return command;
}

/**
 * The driver's Timeout: 1–60 s, default 15 for undefined/null.
 * @param {unknown} timeout
 */
export function checkTimeout(timeout) {
  if (timeout === undefined || timeout === null) return DEFAULT_TIMEOUT_S;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_S) {
    throw new RangeError(`the AT timeout must be an integer from 1 to ${MAX_TIMEOUT_S} seconds, not ${JSON.stringify(timeout)}`);
  }
  return timeout;
}

/** @param {unknown} actionId */
export function checkActionId(actionId) {
  if (typeof actionId !== 'string' || !ACTION_ID.test(actionId) || actionId.startsWith('ami-')) {
    throw new TypeError(`the ActionID must match [A-Za-z0-9._-]{1,63} and not start with ami-, not ${JSON.stringify(actionId)}`);
  }
  return actionId;
}

/**
 * Runs one AT command on a device and resolves with what the driver reported; it never rejects for a protocol outcome (only for
 * invalid arguments, synchronously). Subscribes before it sends; unsubscribes when it settles.
 * @param {AmiClient} ami
 * @param {TransactOptions} options
 * @returns {Promise<Transaction>}
 */
export function transact(ami, { driver, device, command, actionId, timeoutS = DEFAULT_TIMEOUT_S, graceMs = DEFAULTS.graceMs, actionTimeoutMs = DEFAULTS.actionTimeoutMs, log = SILENT, now = Date.now }) {
  checkCommand(command);
  checkTimeout(timeoutS);
  checkActionId(actionId);
  if (typeof device !== 'string' || device === '') throw new TypeError('the device name must be a non-empty string');
  const p = prefix(driver);
  const names = { response: `event:${p}AtResponse`, done: `event:${p}AtDone`, status: `event:${p}Status` };
  return new Promise((resolve) => {
    const sentAt = now();
    /** @type {string[]} */
    const lines = [];
    /** @type {string | null} */
    let reply = null;
    /** the verdict, once there is one @type {{ outcome: Outcome, error: string | null } | null} */
    let verdict = null;
    let acked = false;
    /** @type {NodeJS.Timeout | null} */
    let deadline = null;
    // Events may arrive in the same chunk as the ack, so the verdict can come first; resolve once both are in.
    const settle = () => {
      if (!verdict || !acked) return;
      const { outcome, error } = verdict;
      log.debug('AT transaction ended', { device, action_id: actionId, command, outcome, error, lines: lines.length });
      resolve({ action_id: actionId, device, command, timeout_s: timeoutS, reply, outcome, error, lines, sent_at: sentAt, observed_at: now() });
    };
    /** @param {Outcome} outcome @param {string | null} error */
    const finish = (outcome, error) => {
      if (verdict) return;
      verdict = { outcome, error };
      if (deadline) clearTimeout(deadline);
      ami.off(names.response, onResponse);
      ami.off(names.done, onDone);
      ami.off(names.status, onStatus);
      ami.off('down', onDown);
      settle();
    };
    /** @param {Packet} packet @param {string} event */
    const mine = (packet, event) => {
      const id = first(packet.get('ActionID'));
      if (id === actionId) return true;
      log.debug(`${event} of another transaction dropped`, { device: first(packet.get('Device')) ?? null, action_id: id ?? null, expected: actionId });
      return false;
    };
    /** @param {Packet} packet */
    const onResponse = (packet) => {
      if (!mine(packet, `${p}AtResponse`)) return;
      lines.push(last(packet.get('Line')) ?? '');
    };
    /** @param {Packet} packet */
    const onDone = (packet) => {
      if (!mine(packet, `${p}AtDone`)) return;
      const result = first(packet.get('Result')) ?? '';
      const error = last(packet.get('Error'));
      if (result === 'OK') finish('OK', null);
      else if (result === 'TIMEOUT') finish('TIMEOUT', error || 'timeout');
      else finish('ERROR', error || result || 'ERROR');
    };
    /** @param {Packet} packet */
    const onStatus = (packet) => {
      if (first(packet.get('Device')) === device && first(packet.get('Status')) === 'Disconnect') finish('disconnected', 'the device disconnected before the command completed');
    };
    /** @param {unknown} err */
    const onDown = (err) => finish('down', `the AMI connection dropped before the command completed: ${errorText(err)}`);
    ami.on(names.response, onResponse);
    ami.on(names.done, onDone);
    ami.on(names.status, onStatus);
    ami.on('down', onDown);
    deadline = setTimeout(() => finish('deadline', `no AtDone within ${timeoutS} s + ${graceMs / 1000} s`), timeoutS * 1000 + graceMs);
    ami.action(`${p}AtCommand`, { Device: device, Command: command, ActionID: actionId, Timeout: String(timeoutS) }, { timeout: actionTimeoutMs }).then((packet) => {
      reply = first(packet.get('Message')) ?? null;
      acked = true;
      settle();
    }, (err) => {
      if (err instanceof AmiError) {
        reply = err.message;
        finish('refused', err.message);
      } else finish('down', `the AtCommand request did not complete: ${errorText(err)}`);
      acked = true;
      settle();
    });
  });
}

/**
 * The modem's driver: `params.driver` when given (a device the registry does not know), else from the registry.
 * @param {() => Registry | null} registry
 * @param {string} modemId
 * @param {Record<string, unknown>} params
 * @returns {Driver}
 */
export function modemDriver(registry, modemId, params) {
  const given = params.driver;
  if (given === 'quectel' || given === 'dongle') return given;
  if (given !== undefined && given !== null) throw new OperationError(`driver must be quectel or dongle, not ${JSON.stringify(given)}`);
  const reg = registry();
  if (!reg) throw new OperationError('the registry cannot be loaded, so the modem\'s driver is unknown (pass params.driver)');
  const modem = reg.modems.find((entry) => entry.id === modemId);
  if (!modem) throw new OperationError(`modem ${modemId} is not in the registry (pass params.driver for a device that is not registered)`);
  return modem.driver;
}

/**
 * The connected AMI client, or a failed operation.
 * @param {Context} ctx
 * @param {string} what  `the command was not <what>`
 */
export function requireAmi(ctx, what) {
  if (!ctx.ami) throw new OperationError(`the controller has no AMI connection to Asterisk; ${what}`);
  if (!ctx.ami.connected) throw new OperationError(`Asterisk is not connected over AMI (${ctx.ami.lastError ? errorText(ctx.ami.lastError) : ctx.ami.state}); ${what}`);
  return ctx.ami;
}

/**
 * @param {Options} options
 */
export function createAtOps({ registry, log = SILENT, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };
  /** @type {Runner | null} */
  let runner = null;

  /**
   * The `at` operation: params `{command, timeout?, driver?}`.
   * @param {Context} ctx
   */
  async function handler(ctx) {
    const modemId = ctx.op.modemId;
    if (modemId === null) throw new OperationError('at needs the modem id');
    const params = ctx.op.params ?? {};
    const driver = modemDriver(registry, modemId, params);
    let command;
    let timeoutS;
    try {
      command = checkCommand(params.command);
      timeoutS = checkTimeout(params.timeout);
    } catch (err) {
      throw new OperationError(errorText(err));
    }
    const ami = requireAmi(ctx, 'the command was not sent');
    ctx.progress(`${prefix(driver)}AtCommand ${command}`);
    const tx = await transact(ami, { driver, device: modemId, command, actionId: `at-${ctx.op.id}`, timeoutS, graceMs: t.graceMs, actionTimeoutMs: t.actionTimeoutMs, log: ctx.log, now });
    const result = { modem_id: modemId, driver, ...tx, observed_at: now() };
    if (tx.outcome === 'OK') {
      log.info('AT command done', { modem: modemId, command, lines: tx.lines.length });
      return result;
    }
    if (tx.outcome === 'TIMEOUT') throw new OperationError(`${command}: no final line within ${timeoutS} s; the driver restarts the modem after an AT timeout`, { status: 'failed', result });
    if (tx.outcome === 'ERROR' || tx.outcome === 'refused') throw new OperationError(`${command}: ${tx.error}`, { status: 'failed', result });
    throw new OperationError(`${command}: ${tx.error}; whether the modem ran it is unknown`, { status: 'uncertain', result });
  }

  return {
    handler,
    /** Registers the `at` kind on the modem's queue (an interrupted one is uncertain at the next start). @param {Runner} r */
    register(r) {
      runner = r;
      r.register(KIND, handler);
    },
    /**
     * Enqueues an `at` operation and waits for it.
     * @param {string} modemId
     * @param {string} command
     * @param {{ timeout?: number | null, actor?: Actor }} [options]
     * @returns {Promise<Operation>}
     */
    run(modemId, command, { timeout = null, actor = 'admin' } = {}) {
      if (!runner) throw new Error('createAtOps().register(runner) must run first');
      return runner.wait(runner.enqueue({ kind: KIND, modemId, params: { command, timeout }, actor }));
    },
  };
}
