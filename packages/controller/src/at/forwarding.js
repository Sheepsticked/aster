// @ts-check
// Aster controller — the `forwarding` operation: call forwarding per condition (AT+CCFC) as a mutation followed by a query of each
// condition it covers, so the stored state always comes from the modem's answers, never from a mutation's OK.
// Usage: runner.enqueue({ kind: 'forwarding', modemId: 'gsm1', params: { action: 'set', reason: 'no_reply', number: '+1234567890', time: 20 }, actor: 'admin' })
import { OperationError } from '../ops/runner.js';
import { parse, voiceStatus } from './ccfc.js';
import { DEFAULTS, errorText, modemDriver, prefix, requireAmi, transact } from './client.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('./client.js').Transaction} Transaction */
/** @typedef {'set' | 'enable' | 'disable' | 'erase' | 'query'} Action */
/** @typedef {'unconditional' | 'busy' | 'no_reply' | 'not_reachable'} Condition */
/** @typedef {Condition | 'conditional' | 'all'} Reason */
/**
 * @typedef {object} Forwarding  what the last query of one condition answered
 * @property {boolean} verified              true only for an OK query with a usable +CCFC line
 * @property {'ok' | 'error' | 'timeout' | 'uncertain'} outcome  of the query (uncertain: it did not run or gave no verdict)
 * @property {boolean | null} enabled
 * @property {string | null} number
 * @property {number | null} type
 * @property {number | null} class
 * @property {number | null} time            seconds before a no-reply forward, when the modem reports it
 * @property {import('./ccfc.js').Entry[]} entries
 * @property {string[]} lines
 * @property {string | null} error
 * @property {number} observed_at
 */
/** @typedef {Partial<Record<Condition, Forwarding>>} ForwardingState  the stored verdict per condition */
/**
 * @typedef {object} Options
 * @property {DatabaseSync} db
 * @property {() => Registry | null} registry
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {Partial<typeof DEFAULTS & { timeoutS: number }>} [timing]
 */

export const KIND = 'forwarding';
export const ACTIONS = Object.freeze(/** @type {const} */ (['set', 'enable', 'disable', 'erase', 'query']));
/** The `<reason>` of AT+CCFC for each condition. */
export const REASONS = Object.freeze(/** @type {Readonly<Record<Reason, number>>} */ ({
  unconditional: 0, busy: 1, no_reply: 2, not_reachable: 3, all: 4, conditional: 5,
}));
/** The conditions a state is kept for, in display order. */
export const CONDITIONS = Object.freeze(/** @type {const} */ (['unconditional', 'busy', 'no_reply', 'not_reachable']));
/** The conditions each reason covers: the ones queried after it. */
const COVERS = Object.freeze(/** @type {Readonly<Record<Reason, readonly Condition[]>>} */ ({
  unconditional: ['unconditional'], busy: ['busy'], no_reply: ['no_reply'], not_reachable: ['not_reachable'],
  conditional: ['busy', 'no_reply', 'not_reachable'], all: CONDITIONS,
}));
/** The reasons a no-reply wait applies to. */
export const TIMED = Object.freeze(/** @type {const} */ (['no_reply', 'conditional']));
/** The no-reply waits a network accepts (TS 22.082). */
export const TIMES = Object.freeze([5, 10, 15, 20, 25, 30]);
export const NUMBER = /^\+[0-9]{6,15}$/;
// Long: supplementary services may wait for a fallback from LTE to 3G, and a driver timeout restarts the modem.
export const TIMEOUT_S = 40;
// The verdict outlives the process, so it has its own table, written only when the operation runs (limits SD-card writes).
const STORE = `INSERT INTO modem_forwarding (modem_id, forwarding_json, observed_at) VALUES (?, ?, ?)
  ON CONFLICT(modem_id) DO UPDATE SET forwarding_json = excluded.forwarding_json, observed_at = excluded.observed_at`;
const SELECT = 'SELECT forwarding_json AS forwarding FROM modem_forwarding WHERE modem_id = ?';

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * The AT command of a mutation (null for query).
 * @param {Action} action
 * @param {Reason} [reason]
 * @param {string | null} [number]
 * @param {number | null} [time]  class 7 is the default the short form implies
 */
export function mutationCommand(action, reason = 'unconditional', number = null, time = null) {
  const code = REASONS[reason];
  switch (action) {
    case 'set':
      return time === null ? `AT+CCFC=${code},3,"${number}",145` : `AT+CCFC=${code},3,"${number}",145,7,,,${time}`;
    case 'enable':
      return `AT+CCFC=${code},1`;
    case 'disable':
      return `AT+CCFC=${code},0`;
    case 'erase':
      return `AT+CCFC=${code},4`;
    default:
      return null;
  }
}

/** @param {Condition} condition */
export const queryCommand = (condition) => `AT+CCFC=${REASONS[condition]},2`;

/**
 * A stored forwarding_json as a state per condition; a verdict stored before conditions existed is the unconditional one.
 * @param {unknown} value
 * @returns {ForwardingState | null}
 */
export function normalize(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('verified' in value) return { unconditional: /** @type {Forwarding} */ (value) };
  /** @type {ForwardingState} */
  const state = {};
  for (const condition of CONDITIONS) {
    const verdict = /** @type {Record<string, unknown>} */ (value)[condition];
    if (verdict !== null && typeof verdict === 'object') state[condition] = /** @type {Forwarding} */ (verdict);
  }
  return Object.keys(state).length > 0 ? state : null;
}

/**
 * The forwarding state a query transaction gives (null: the query did not run).
 * @param {Transaction | null} query
 * @param {number} observedAt
 * @returns {Forwarding}
 */
export function fromQuery(query, observedAt) {
  /** @type {Forwarding} */
  const none = { verified: false, outcome: 'uncertain', enabled: null, number: null, type: null, class: null, time: null, entries: [], lines: query?.lines ?? [], error: null, observed_at: observedAt };
  if (!query) return { ...none, error: 'the query did not run' };
  switch (query.outcome) {
    case 'OK': {
      /** @type {import('./ccfc.js').Entry[]} */
      let entries;
      try {
        entries = parse(query.lines);
      } catch (err) {
        return { ...none, error: errorText(err) };
      }
      const voice = voiceStatus(entries);
      if (!voice) return { ...none, entries, error: 'the answer holds no +CCFC line' };
      return { ...none, verified: true, outcome: 'ok', enabled: voice.enabled, number: voice.number, type: voice.type, class: voice.class, time: voice.time, entries };
    }
    case 'ERROR':
    case 'refused':
      return { ...none, outcome: 'error', error: query.error };
    case 'TIMEOUT':
      return { ...none, outcome: 'timeout', error: query.error };
    default:
      return { ...none, error: query.error };
  }
}

/**
 * @param {Options} options
 */
export function createForwardingOps({ db, registry, log = SILENT, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, timeoutS: TIMEOUT_S, ...timing };
  const store = db.prepare(STORE);
  const select = db.prepare(SELECT);

  /** @param {string} modemId */
  function stored(modemId) {
    const row = /** @type {{ forwarding: string | null } | undefined} */ (select.get(modemId));
    try {
      return row?.forwarding ? normalize(JSON.parse(String(row.forwarding))) : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {Context} ctx
   */
  async function handler(ctx) {
    const modemId = ctx.op.modemId;
    if (modemId === null) throw new OperationError('forwarding needs the modem id');
    const params = ctx.op.params ?? {};
    const action = /** @type {Action} */ (params.action);
    if (!ACTIONS.includes(action)) throw new OperationError(`action must be one of ${ACTIONS.join(', ')}, not ${JSON.stringify(action)}`);
    const reason = /** @type {Reason} */ (params.reason ?? 'unconditional');
    if (!Object.hasOwn(REASONS, reason)) throw new OperationError(`reason must be one of ${Object.keys(REASONS).join(', ')}, not ${JSON.stringify(reason)}`);
    if (reason === 'all' && action !== 'query') throw new OperationError('reason "all" is only for a query');
    /** @type {string | null} */
    let number = null;
    /** @type {number | null} */
    let time = null;
    if (action === 'set') {
      if (typeof params.number !== 'string' || !NUMBER.test(params.number)) throw new OperationError(`set needs a number like +1234567890 (+ and 6 to 15 digits), not ${JSON.stringify(params.number)}`);
      number = params.number;
      if (params.time !== undefined && params.time !== null) {
        if (!TIMED.includes(/** @type {any} */ (reason))) throw new OperationError(`a wait applies only to ${TIMED.join(' and ')}, not ${reason}`);
        if (!TIMES.includes(/** @type {any} */ (params.time))) throw new OperationError(`time must be one of ${TIMES.join(', ')} seconds, not ${JSON.stringify(params.time)}`);
        time = /** @type {number} */ (params.time);
      }
    }
    const driver = modemDriver(registry, modemId, params);
    const ami = requireAmi(ctx, 'the forwarding was not changed');
    /** @type {{ modem_id: string, driver: string, action: Action, reason: Reason, number: string | null, time: number | null, mutation: Transaction | null, queries: Transaction[], forwarding: ForwardingState }} */
    const result = { modem_id: modemId, driver, action, reason, number, time, mutation: null, queries: [], forwarding: {} };
    const common = { driver, device: modemId, timeoutS: t.timeoutS, graceMs: t.graceMs, actionTimeoutMs: t.actionTimeoutMs, log: ctx.log, now };
    const command = mutationCommand(action, reason, number, time);
    if (command) {
      ctx.progress(`${prefix(driver)}AtCommand ${command}`);
      result.mutation = await transact(ami, { ...common, command, actionId: `at-${ctx.op.id}.1` });
    }
    const conditions = COVERS[reason];
    /** @type {{ command: string, verdict: Forwarding }[]} */
    const read = [];
    // Queries follow a mutation that reached the driver; one the modem did not answer ends the round (a timeout restarts it).
    let next = !result.mutation || result.mutation.outcome === 'OK' || result.mutation.outcome === 'ERROR' || result.mutation.outcome === 'TIMEOUT';
    for (const [index, condition] of conditions.entries()) {
      if (!next) break;
      const query = queryCommand(condition);
      ctx.progress(`${prefix(driver)}AtCommand ${query}`);
      const answer = await transact(ami, { ...common, command: query, actionId: `at-${ctx.op.id}.${index + 2}` });
      const verdict = fromQuery(answer, now());
      result.queries.push(answer);
      result.forwarding[condition] = verdict;
      read.push({ command: query, verdict });
      next = answer.outcome === 'OK' || answer.outcome === 'ERROR';
    }
    // What a mutation may have changed but no query read is not known any more.
    if (command) for (const condition of conditions) result.forwarding[condition] ??= fromQuery(null, now());
    if (Object.keys(result.forwarding).length > 0 && registry()?.modems.some((modem) => modem.id === modemId)) {
      const merged = { ...stored(modemId), ...result.forwarding };
      store.run(modemId, JSON.stringify(merged), now());
    }
    const final = { ...result, observed_at: now() };
    const mutation = result.mutation;
    if (mutation && mutation.outcome !== 'OK') {
      if (mutation.outcome === 'TIMEOUT') throw new OperationError(`${command}: no final line within ${t.timeoutS} s; the driver restarts the modem after an AT timeout`, { status: 'failed', result: final });
      if (mutation.outcome === 'ERROR' || mutation.outcome === 'refused') throw new OperationError(`${command}: ${mutation.error}`, { status: 'failed', result: final });
      throw new OperationError(`${command}: ${mutation.error}; whether the modem changed the forwarding is unknown`, { status: 'uncertain', result: final });
    }
    const problems = read.filter((entry) => entry.verdict.outcome !== 'ok');
    const failed = problems.find((problem) => problem.verdict.outcome === 'error' || problem.verdict.outcome === 'timeout');
    if (failed) throw new OperationError(`${failed.command}: ${failed.verdict.error}`, { status: 'failed', result: final });
    const unsure = problems[0];
    if (unsure) throw new OperationError(`${unsure.command}: ${unsure.verdict.error}; the forwarding state is not verified`, { status: 'uncertain', result: final });
    log.info('forwarding verified', { modem: modemId, action, reason, conditions: Object.fromEntries(Object.entries(result.forwarding).map(([key, value]) => [key, value.enabled ? value.number : false])) });
    return final;
  }

  return {
    handler,
    /** Registers the kind on the modem's queue (an interrupted one is uncertain at the next start). @param {Runner} runner */
    register(runner) {
      runner.register(KIND, handler);
    },
  };
}
