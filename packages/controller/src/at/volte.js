// @ts-check
// Aster controller — VoLTE on Quectel modems: `volte-query` reads AT+QCFG="ims" and the operator profiles (MBN); `volte` sets the
// mode, selects the generic profile when none is in use, resets the modem so both take effect and reads the result back.
import { AmiError } from '../ami/client.js';
import { showDevices } from '../devices/state.js';
import { OperationError } from '../ops/runner.js';
import { DEFAULTS, DEFAULT_TIMEOUT_S, DEFINITE, errorText, modemDriver, requireAmi, transact } from './client.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('./client.js').Transaction} Transaction */
/** @typedef {'default' | 'on' | 'off'} Mode */
/**
 * @typedef {object} Profile  one entry of AT+QMBNCFG="List"
 * @property {string} name
 * @property {boolean} selected  used after the next restart
 * @property {boolean} active    in use now
 */
/**
 * @typedef {object} Volte  what the modem answered, the way the Modem page shows it
 * @property {Mode | null} mode       null: an answer outside the documented values
 * @property {boolean | null} ready   the modem reports VoLTE ready (registered for voice over LTE)
 * @property {string | null} profile  the operator profile in use, null when none is
 * @property {string | null} selected the profile the modem uses after a restart
 * @property {number} observed_at
 */
/**
 * @typedef {object} Timing
 * @property {number} graceMs
 * @property {number} actionTimeoutMs
 * @property {number} timeoutS
 * @property {number} goneTimeoutMs   how long the modem may take to drop off after the reset (30 s)
 * @property {number} backTimeoutMs   how long it may take to connect again (120 s), so a page that follows the operation sees its end
 * @property {number} pollMs          ShowDevices poll period while waiting (2 s)
 * @property {number} readyPollMs     between the reads that wait for VoLTE to become ready (5 s)
 * @property {number} readyReads      how many reads that wait makes at most (6)
 */
/**
 * @typedef {object} Options
 * @property {() => Registry | null} registry
 * @property {Logger} [log]
 * @property {() => number} [now]
 * @property {Partial<Timing>} [timing]
 */

export const KIND = 'volte';
export const QUERY_KIND = 'volte-query';
export const MODES = Object.freeze(/** @type {const} */ (['default', 'on', 'off']));
/** The `<VoLTE_mode>` of AT+QCFG="ims": 0 the operator profile decides, 1 on, 2 off. */
const CODES = Object.freeze(/** @type {Readonly<Record<Mode, number>>} */ ({ default: 0, on: 1, off: 2 }));
export const QUERY = 'AT+QCFG="ims"';
export const LIST_PROFILES = 'AT+QMBNCFG="List"';
/** The profile Quectel ships for networks without one of their own. */
export const GENERIC_PROFILE = 'ROW_Generic_3GPP';
/** The driver states in which the modem is connected and in no call, so a reset loses nothing. */
const IDLE = new Set(['Free', 'GSM not registered']);
/** The driver states of a modem that is not connected (yet). */
const AWAY = new Set(['Stopped', 'Not connected', 'Not initialized']);
export const DEFAULT_TIMING = Object.freeze({ goneTimeoutMs: 30_000, backTimeoutMs: 120_000, pollMs: 2_000, readyPollMs: 5_000, readyReads: 6 });
const LATEST = `SELECT json_extract(result_json, '$.volte') AS volte FROM operations
  WHERE kind IN ('${KIND}', '${QUERY_KIND}') AND modem_id = ? AND json_extract(result_json, '$.volte') IS NOT NULL ORDER BY id DESC LIMIT 1`;

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {Mode} mode */
export const setCommand = (mode) => `AT+QCFG="ims",${CODES[mode]}`;
/** @param {string} name */
export const selectCommand = (name) => `AT+QMBNCFG="Select","${name}"`;

/**
 * The mode and readiness of an AT+QCFG="ims" answer (`+QCFG: "ims",1,1`), or null when it holds none.
 * @param {readonly string[]} lines
 * @returns {{ mode: Mode | null, ready: boolean | null } | null}
 */
export function imsOf(lines) {
  for (const line of lines) {
    const match = /^\+QCFG:\s*"ims",(\d+)(?:,(\d+))?/i.exec(line.trim());
    if (!match) continue;
    const mode = /** @type {Mode | undefined} */ (MODES.find((name) => CODES[name] === Number(match[1])));
    return { mode: mode ?? null, ready: match[2] === undefined ? null : match[2] === '1' };
  }
  return null;
}

/**
 * The profiles of an AT+QMBNCFG="List" answer (`+QMBNCFG: "List",0,1,1,"ROW_Generic_3GPP",0x0501081F,201901141`).
 * @param {readonly string[]} lines
 * @returns {Profile[]}
 */
export function profilesOf(lines) {
  /** @type {Profile[]} */
  const profiles = [];
  for (const line of lines) {
    const match = /^\+QMBNCFG:\s*"List",\d+,(\d),(\d),"([^"]*)"/i.exec(line.trim());
    if (match) profiles.push({ name: match[3] ?? '', selected: match[1] === '1', active: match[2] === '1' });
  }
  return profiles;
}

/**
 * The newest verdict a VoLTE operation stored for a modem, or null.
 * @param {DatabaseSync} db
 * @param {string} modemId
 * @returns {Volte | null}
 */
export function latest(db, modemId) {
  const row = /** @type {{ volte: string | null } | undefined} */ (db.prepare(LATEST).get(modemId));
  if (!row?.volte) return null;
  try {
    return JSON.parse(String(row.volte));
  } catch {
    return null;
  }
}

/**
 * @param {Options} options
 */
export function createVolteOps({ registry, log = SILENT, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, timeoutS: DEFAULT_TIMEOUT_S, ...DEFAULT_TIMING, ...timing };

  /**
   * @param {Context} ctx
   */
  async function handler(ctx) {
    const modemId = ctx.op.modemId;
    if (modemId === null) throw new OperationError(`${ctx.op.kind} needs the modem id`);
    const params = ctx.op.params ?? {};
    const change = ctx.op.kind === KIND;
    const mode = /** @type {Mode} */ (params.mode);
    if (change && !MODES.includes(mode)) throw new OperationError(`mode must be one of ${MODES.join(', ')}, not ${JSON.stringify(params.mode)}`);
    const driver = modemDriver(registry, modemId, params);
    if (driver !== 'quectel') throw new OperationError(`VoLTE is a setting of Quectel modems; ${modemId} uses chan_${driver}`);
    const ami = requireAmi(ctx, change ? 'VoLTE was not changed' : 'nothing was read');
    /** @type {{ modem_id: string, mode: Mode | null, changed: string[], reset: boolean, volte: Volte | null, transactions: Transaction[] }} */
    const result = { modem_id: modemId, mode: change ? mode : null, changed: [], reset: false, volte: null, transactions: [] };
    const common = { driver, device: modemId, timeoutS: t.timeoutS, graceMs: t.graceMs, actionTimeoutMs: t.actionTimeoutMs, log: ctx.log, now };
    /** @param {string} command */
    const step = async (command) => {
      ctx.progress(`QuectelAtCommand ${command}`);
      const tx = await transact(ami, { ...common, command, actionId: `at-${ctx.op.id}.${result.transactions.length + 1}` });
      result.transactions.push(tx);
      return tx;
    };
    const done = () => ({ ...result, observed_at: now() });
    const readMode = async () => {
      const ims = await step(QUERY);
      return { ims, parsed: ims.outcome === 'OK' ? imsOf(ims.lines) : null };
    };
    /** A firmware without operator profiles answers ERROR, which leaves them unknown. */
    const readProfiles = async () => {
      const list = await step(LIST_PROFILES);
      return list.outcome === 'OK' ? profilesOf(list.lines) : null;
    };
    /** @param {{ mode: Mode | null, ready: boolean | null }} parsed @param {Profile[] | null} profiles @returns {Volte} */
    const verdict = (parsed, profiles) => ({ ...parsed, profile: profiles?.find((entry) => entry.active)?.name ?? null,
      selected: profiles?.find((entry) => entry.selected)?.name ?? null, observed_at: now() });
    /** A step that stopped the operation: failed when the driver gave a verdict and nothing had changed yet, else uncertain.
     * @param {Transaction} tx @param {string} what @param {boolean} [changing] */
    const stopped = (tx, what, changing = false) => {
      const why = tx.outcome === 'OK' ? 'the answer holds no "ims" line' : tx.error;
      const definite = /** @type {readonly string[]} */ (DEFINITE).includes(tx.outcome) && !changing;
      return new OperationError(`${tx.command}: ${why}; ${what}`, { status: definite ? 'failed' : 'uncertain', result: done() });
    };

    if (change) {
      const entry = (await showDevices(ami, driver, { device: modemId, timeout: t.actionTimeoutMs }))[0] ?? null;
      if (!entry || !IDLE.has(entry.state)) {
        throw new OperationError(`${modemId} is ${entry ? `"${entry.state}"` : 'not listed by the driver'}; VoLTE is changed only while the modem is connected and in no call`, { result: done() });
      }
    }
    const before = await readMode();
    if (!before.parsed) throw stopped(before.ims, change ? 'VoLTE was not changed' : 'the VoLTE state is unknown');
    const profiles = await readProfiles();
    result.volte = verdict(before.parsed, profiles);
    if (!change) {
      log.info('VoLTE read', { modem: modemId, mode: result.volte.mode, ready: result.volte.ready, profile: result.volte.profile });
      return done();
    }

    // Without an operator profile the modem has no IMS settings, so turning VoLTE on alone does not make it ready.
    if (mode === 'on' && profiles && !profiles.some((entry) => entry.active || entry.selected) && profiles.some((entry) => entry.name === GENERIC_PROFILE)) {
      const select = await step(selectCommand(GENERIC_PROFILE));
      if (select.outcome !== 'OK') throw stopped(select, 'VoLTE was not changed');
      result.changed.push('profile');
    }
    if (before.parsed.mode !== mode) {
      const set = await step(setCommand(mode));
      if (set.outcome !== 'OK') throw stopped(set, result.changed.length > 0 ? `the profile ${GENERIC_PROFILE} is selected for the next restart, VoLTE is not changed` : 'VoLTE was not changed', result.changed.length > 0);
      result.changed.push('mode');
    }
    if (result.changed.length === 0) {
      log.info('VoLTE already set', { modem: modemId, mode, ready: result.volte.ready });
      return done();
    }

    // Both settings are kept by the modem and take effect only after it restarts.
    await reset(ctx, ami, modemId, result, done);
    // VoLTE comes up only once the modem has registered with the network again, which may take a little longer.
    let after = await readMode();
    for (let reads = 1; mode === 'on' && after.parsed?.ready === false && reads < t.readyReads; reads += 1) {
      await sleep(t.readyPollMs);
      after = await readMode();
    }
    if (!after.parsed) throw stopped(after.ims, 'the modem keeps the new setting, but it could not be read back', true);
    result.volte = verdict(after.parsed, await readProfiles());
    log.info('VoLTE changed', { modem: modemId, mode, changed: result.changed, ready: result.volte.ready, profile: result.volte.profile });
    return done();
  }

  /**
   * Resets the modem through the driver and waits until it is connected again.
   * @param {Context} ctx @param {import('../ami/client.js').AmiClient} ami @param {string} modemId
   * @param {{ reset: boolean }} result @param {() => Record<string, unknown>} done
   */
  async function reset(ctx, ami, modemId, result, done) {
    let gone = false;
    /** @param {import('../ami/parser.js').Packet} packet */
    const onStatus = (packet) => {
      const device = packet.get('Device');
      const status = packet.get('Status');
      if ((Array.isArray(device) ? device[0] : device) === modemId && (Array.isArray(status) ? status[0] : status) === 'Disconnect') gone = true;
    };
    ami.on('event:QuectelStatus', onStatus);
    try {
      ctx.progress('QuectelReset');
      try {
        await ami.action('QuectelReset', { Device: modemId }, { timeout: t.actionTimeoutMs });
      } catch (err) {
        const why = `QuectelReset ${modemId}: ${errorText(err)}; the modem keeps the new setting and uses it after its next restart`;
        throw new OperationError(why, { status: err instanceof AmiError ? 'failed' : 'uncertain', result: done() });
      }
      result.reset = true;
      ctx.progress('waiting for the modem to restart');
      const goneBy = now() + t.goneTimeoutMs;
      const backBy = now() + t.backTimeoutMs;
      for (;;) {
        /** @type {string | null} */
        let state = null;
        try {
          state = (await showDevices(ami, 'quectel', { device: modemId, timeout: t.actionTimeoutMs }))[0]?.state ?? null;
        } catch (err) {
          ctx.log.debug('ShowDevices failed while the modem restarts', { modem: modemId, err: errorText(err) });
        }
        if (state !== null && AWAY.has(state)) gone = true;
        if (gone && state !== null && !AWAY.has(state)) return;
        if (!gone && now() >= goneBy) {
          throw new OperationError(`the driver accepted QuectelReset, but ${modemId} did not restart within ${Math.round(t.goneTimeoutMs / 1000)} s; the new setting applies after its next restart`, { status: 'uncertain', result: done() });
        }
        if (now() >= backBy) {
          throw new OperationError(`${modemId} restarted but was not connected again within ${Math.round(t.backTimeoutMs / 1000)} s (${state ?? 'not listed'}); it keeps the new setting`, { status: 'uncertain', result: done() });
        }
        await sleep(t.pollMs);
      }
    } finally {
      ami.off('event:QuectelStatus', onStatus);
    }
  }

  return {
    handler,
    /** Registers both kinds on the modem's queue (an interrupted one is uncertain at the next start). @param {Runner} runner */
    register(runner) {
      runner.register(KIND, handler);
      runner.register(QUERY_KIND, handler);
    },
  };
}
