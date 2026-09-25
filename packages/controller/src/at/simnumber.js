// @ts-check
// Aster controller — `sim-number`: writes the modem's own number into the SIM's own-number list (phonebook "ON", read by
// AT+CNUM), reads it back, selects the phonebook in use again and runs AT+CNUM so the driver reports the number at once.
import { OperationError } from '../ops/runner.js';
import { DEFAULTS, DEFAULT_TIMEOUT_S, modemDriver, prefix, requireAmi, transact } from './client.js';
import { NUMBER } from './forwarding.js';

/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('./client.js').Transaction} Transaction */
/**
 * @typedef {object} Options
 * @property {() => Registry | null} registry
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {Partial<typeof DEFAULTS & { timeoutS: number }>} [timing]
 */

export const KIND = 'sim-number';
export { NUMBER };
export const QUERY_STORAGE = 'AT+CPBS?';
export const READ_ENTRY = 'AT+CPBR=1';
export const OWN_NUMBERS = 'AT+CNUM';
/** The phonebook a modem selects after a restart, used when AT+CPBS? names none. */
export const DEFAULT_STORAGE = 'SM';

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/** @param {string} storage  a two-letter phonebook name */
export const selectCommand = (storage) => `AT+CPBS="${storage}"`;
/** Entry 1 of the selected phonebook, type 145 (international, the number starts with +), no name. @param {string} number */
export const writeCommand = (number) => `AT+CPBW=1,"${number}",145`;

/**
 * The phonebook AT+CPBS? names (`+CPBS: "SM",1,250`), or null.
 * @param {readonly string[]} lines
 */
export function storageOf(lines) {
  for (const line of lines) {
    const match = /^\+CPBS:\s*"([A-Z]{2})"/.exec(line.trim());
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * The number of entry 1 in an AT+CPBR=1 answer (`+CPBR: 1,"+1234567890",145,""`), or null.
 * @param {readonly string[]} lines
 */
export function entryNumber(lines) {
  for (const line of lines) {
    const match = /^\+CPBR:\s*1,"([^"]*)",\d+/.exec(line.trim());
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * The numbers of an AT+CNUM answer (`+CNUM: ,"+1234567890",145` or `+CNUM: "Name","+1234567890",145`); empty ones are left out.
 * @param {readonly string[]} lines
 * @returns {string[]}
 */
export function ownNumbers(lines) {
  /** @type {string[]} */
  const numbers = [];
  for (const line of lines) {
    const match = /^\+CNUM:\s*(?:"[^"]*")?\s*,\s*"([^"]*)"/.exec(line.trim());
    if (match?.[1]) numbers.push(match[1]);
  }
  return numbers;
}

/**
 * @param {Options} options
 */
export function createSimNumberOps({ registry, log = SILENT, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, timeoutS: DEFAULT_TIMEOUT_S, ...timing };

  /**
   * @param {Context} ctx
   */
  async function handler(ctx) {
    const modemId = ctx.op.modemId;
    if (modemId === null) throw new OperationError('sim-number needs the modem id');
    const params = ctx.op.params ?? {};
    if (typeof params.number !== 'string' || !NUMBER.test(params.number)) {
      throw new OperationError(`the number must be like +1234567890 (+ and 6 to 15 digits), not ${JSON.stringify(params.number)}`);
    }
    const number = params.number;
    const driver = modemDriver(registry, modemId, params);
    const ami = requireAmi(ctx, 'nothing was written to the SIM');
    /** @type {{ modem_id: string, driver: string, number: string, storage: string | null, read_back: string | null, reported: string[], restored: boolean, transactions: Transaction[] }} */
    const result = { modem_id: modemId, driver, number, storage: null, read_back: null, reported: [], restored: false, transactions: [] };
    const common = { driver, device: modemId, timeoutS: t.timeoutS, graceMs: t.graceMs, actionTimeoutMs: t.actionTimeoutMs, log: ctx.log, now };
    /** @param {string} command */
    const step = async (command) => {
      ctx.progress(`${prefix(driver)}AtCommand ${command}`);
      const tx = await transact(ami, { ...common, command, actionId: `at-${ctx.op.id}.${result.transactions.length + 1}` });
      result.transactions.push(tx);
      return tx;
    };
    /** The modem answered the last command, so it can take the next one (a timeout restarts it). */
    const answering = () => ['OK', 'ERROR'].includes(result.transactions.at(-1)?.outcome ?? '');
    const done = () => ({ ...result, observed_at: now() });

    const current = await step(QUERY_STORAGE);
    if (current.outcome !== 'OK') throw new OperationError(`${QUERY_STORAGE}: ${current.error}; nothing was written to the SIM`, { status: 'failed', result: done() });
    result.storage = storageOf(current.lines) ?? DEFAULT_STORAGE;
    const select = await step(selectCommand('ON'));
    if (select.outcome !== 'OK') {
      const why = select.outcome === 'ERROR' ? 'the modem cannot select the SIM\'s own-number list' : String(select.error);
      throw new OperationError(`${selectCommand('ON')}: ${why}${select.outcome === 'ERROR' ? ` (${select.error})` : ''}; nothing was written to the SIM`, { status: 'failed', result: done() });
    }
    const write = await step(writeCommand(number));
    if (write.outcome === 'OK') {
      const read = await step(READ_ENTRY);
      if (read.outcome === 'OK') result.read_back = entryNumber(read.lines);
    }
    // Back to the phonebook that was in use, whatever the write did, while the modem still answers.
    if (answering()) result.restored = (await step(selectCommand(result.storage))).outcome === 'OK';
    // A +CNUM line updates the number the driver reports (at_response_cnum), so the pages show it without a restart.
    if (write.outcome === 'OK' && answering()) {
      const own = await step(OWN_NUMBERS);
      if (own.outcome === 'OK') result.reported = ownNumbers(own.lines);
    }
    if (!result.restored) log.warn('the phonebook in use could not be selected again after the SIM number write', { modem: modemId, storage: result.storage });

    if (write.outcome === 'TIMEOUT') throw new OperationError(`${write.command}: no final line within ${t.timeoutS} s; the driver restarts the modem after an AT timeout`, { status: 'failed', result: done() });
    if (write.outcome === 'ERROR' || write.outcome === 'refused') throw new OperationError(`${write.command}: ${write.error}`, { status: 'failed', result: done() });
    if (write.outcome !== 'OK') throw new OperationError(`${write.command}: ${write.error}; whether the SIM stored the number is unknown`, { status: 'uncertain', result: done() });
    if (result.read_back !== number) {
      const read = result.read_back === null ? 'could not be read back' : `reads ${result.read_back}`;
      throw new OperationError(`the SIM accepted the number, but its own-number entry ${read}`, { status: 'uncertain', result: done() });
    }
    log.info('SIM number written', { modem: modemId, restored: result.restored, reported: result.reported.includes(number) });
    return done();
  }

  return {
    handler,
    /** Registers the kind on the modem's queue (an interrupted one is uncertain at the next start). @param {Runner} runner */
    register(runner) {
      runner.register(KIND, handler);
    },
  };
}
