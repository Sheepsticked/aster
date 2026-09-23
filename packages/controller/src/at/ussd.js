// @ts-check
// Aster controller — `ussd`: `…SendUSSD`, then the device's first `…NewUSSD` in time, with the session state of the `…NewCUSD`
// just before it; `ussd-cancel` ends an open session (AT+CUSD=2). A driver refusal fails either; no verdict leaves it uncertain.
// Usage: createUssdOps({ registry }).register(runner); runner.enqueue({ kind: 'ussd', modemId: 'gsm1', params: { code: '*100#' }, actor: 'admin' })
import { AmiError } from '../ami/client.js';
import { OperationError } from '../ops/runner.js';
import { errorText, modemDriver, prefix, requireAmi, transact } from './client.js';

/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../ami/parser.js').Packet} Packet */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/**
 * @typedef {object} Options
 * @property {() => Registry | null} registry
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {Partial<typeof DEFAULTS>} [timing]
 */

export const KIND = 'ussd';
export const CANCEL_KIND = 'ussd-cancel';
export const CANCEL_COMMAND = 'AT+CUSD=2';
export const CODE = /^[0-9*#]{1,64}$/;
/** @type {Readonly<{ answerTimeoutMs: number, actionTimeoutMs: number }>} */
export const DEFAULTS = Object.freeze({ answerTimeoutMs: 30_000, actionTimeoutMs: 30_000 });

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {unknown} value */
const first = (value) => (value === undefined ? undefined : String(Array.isArray(value) ? value[0] : value));

/**
 * The text of a `…NewUSSD` event: MessageLine0…N-1 (N = LineCount; without it, every MessageLine<n> in order).
 * @param {Packet} packet
 * @returns {{ lines: string[], text: string }}
 */
export function ussdText(packet) {
  const count = Number(first(packet.get('LineCount')));
  /** @type {string[]} */
  const lines = [];
  if (Number.isInteger(count) && count >= 0) {
    for (let i = 0; i < count; i++) lines.push(first(packet.get(`MessageLine${i}`)) ?? '');
  } else {
    for (const [name, value] of packet) {
      if (/^MessageLine\d+$/.test(name)) lines.push(first(value) ?? '');
    }
  }
  return { lines, text: lines.join('\n') };
}

/**
 * The session state of a `…NewCUSD` event's raw `+CUSD: <m>[,<str>,<dcs>]` line, or null for anything else.
 * @param {unknown} message
 * @returns {number | null}
 */
export function cusdType(message) {
  const match = /^\+CUSD:\s*([0-5])(?:,|$)/.exec(String(message ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * @param {Options} options
 */
export function createUssdOps({ registry, log = SILENT, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };

  /**
   * @param {Context} ctx
   */
  async function handler(ctx) {
    const modemId = ctx.op.modemId;
    if (modemId === null) throw new OperationError('ussd needs the modem id');
    const params = ctx.op.params ?? {};
    const code = params.code;
    if (typeof code !== 'string' || !CODE.test(code)) throw new OperationError(`code must be 1 to 64 digits, * and #, not ${JSON.stringify(code)}`);
    const driver = modemDriver(registry, modemId, params);
    const ami = requireAmi(ctx, 'the USSD was not sent');
    const p = prefix(driver);
    const names = { ussd: `event:${p}NewUSSD`, cusd: `event:${p}NewCUSD`, status: `event:${p}Status` };
    const sentAt = now();
    /** type: the +CUSD session state of the answer (3GPP TS 27.007): 0 done, 1 the network waits for an answer, 2 ended by
     * the network, 3 answered by another client, 4 not supported, 5 network timeout; null when the driver did not report it
     * @type {{ modem_id: string, driver: string, code: string, reply: string | null, type: number | null, text: string | null, lines: string[], sent_at: number }} */
    const result = { modem_id: modemId, driver, code, reply: null, type: null, text: null, lines: [], sent_at: sentAt };
    /** @param {Record<string, unknown>} [extra] */
    const uncertain = (/** @type {string} */ message, extra) => new OperationError(message, { status: 'uncertain', result: { ...result, ...extra, observed_at: now() } });
    /** @type {Promise<{ lines: string[], text: string, type: number | null } | Error>} */
    const answer = new Promise((resolve) => {
      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      let settled = false;
      /** the session state of the device's latest `…NewCUSD` @type {number | null} */
      let type = null;
      /** @param {{ lines: string[], text: string, type: number | null } | Error} value */
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ami.off(names.ussd, onUssd);
        ami.off(names.cusd, onCusd);
        ami.off(names.status, onStatus);
        ami.off('down', onDown);
        resolve(value);
      };
      /** @param {Packet} packet */
      const onCusd = (packet) => {
        if (first(packet.get('Device')) === modemId) type = cusdType(first(packet.get('Message')));
      };
      /** @param {Packet} packet */
      const onUssd = (packet) => {
        if (first(packet.get('Device')) !== modemId) return;
        finish({ ...ussdText(packet), type });
      };
      /** @param {Packet} packet */
      const onStatus = (packet) => {
        if (first(packet.get('Device')) === modemId && first(packet.get('Status')) === 'Disconnect') finish(new Error('the device disconnected before the network answered'));
      };
      /** @param {unknown} err */
      const onDown = (err) => finish(new Error(`the AMI connection dropped before the network answered: ${errorText(err)}`));
      ami.on(names.ussd, onUssd);
      ami.on(names.cusd, onCusd);
      ami.on(names.status, onStatus);
      ami.on('down', onDown);
      timer = setTimeout(() => finish(new Error(`no USSD answer within ${t.answerTimeoutMs >= 1000 ? `${Math.round(t.answerTimeoutMs / 1000)} s` : `${t.answerTimeoutMs} ms`}`)), t.answerTimeoutMs);
      ctx.progress(`${p}SendUSSD ${code}`);
      ami.action(`${p}SendUSSD`, { Device: modemId, USSD: code }, { timeout: t.actionTimeoutMs }).then((packet) => {
        result.reply = first(packet.get('Message')) ?? null;
      }, (err) => {
        if (err instanceof AmiError) {
          result.reply = err.message;
          finish(new OperationError(`${p}SendUSSD ${modemId}: ${err.message}`, { status: 'failed' }));
        } else finish(new Error(`the SendUSSD request did not complete: ${errorText(err)}`));
      });
    });
    const outcome = await answer;
    if (outcome instanceof OperationError) throw new OperationError(outcome.message, { status: outcome.status, result: { ...result, observed_at: now() } });
    if (outcome instanceof Error) throw uncertain(`${code}: ${outcome.message}; whether the network received the code is unknown`);
    result.type = outcome.type;
    result.lines = outcome.lines;
    result.text = outcome.text;
    log.info('USSD answered', { modem: modemId, code, type: outcome.type, lines: outcome.lines.length });
    return { ...result, observed_at: now() };
  }

  /**
   * The `ussd-cancel` operation: AT+CUSD=2 through the AtCommand action; the modem's OK ends it done.
   * @param {Context} ctx
   */
  async function cancelHandler(ctx) {
    const modemId = ctx.op.modemId;
    if (modemId === null) throw new OperationError('ussd-cancel needs the modem id');
    const driver = modemDriver(registry, modemId, ctx.op.params ?? {});
    const ami = requireAmi(ctx, 'the session was not ended');
    ctx.progress(`${prefix(driver)}AtCommand ${CANCEL_COMMAND}`);
    const tx = await transact(ami, { driver, device: modemId, command: CANCEL_COMMAND, actionId: `ussd-cancel-${ctx.op.id}`, actionTimeoutMs: t.actionTimeoutMs, log: ctx.log, now });
    const result = { modem_id: modemId, driver, ...tx, observed_at: now() };
    if (tx.outcome === 'OK') {
      log.info('USSD session ended', { modem: modemId });
      return result;
    }
    if (tx.outcome === 'TIMEOUT') throw new OperationError(`${CANCEL_COMMAND}: no final line within ${tx.timeout_s} s; the driver restarts the modem after an AT timeout`, { status: 'failed', result });
    if (tx.outcome === 'ERROR' || tx.outcome === 'refused') throw new OperationError(`${CANCEL_COMMAND}: ${tx.error}`, { status: 'failed', result });
    throw new OperationError(`${CANCEL_COMMAND}: ${tx.error}; whether the modem ran it is unknown`, { status: 'uncertain', result });
  }

  return {
    handler,
    cancelHandler,
    /** Registers both kinds on the modem's queue (an interrupted one is uncertain at the next start). @param {Runner} runner */
    register(runner) {
      runner.register(KIND, handler);
      runner.register(CANCEL_KIND, cancelHandler);
    },
  };
}
