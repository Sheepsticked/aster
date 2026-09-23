// @ts-check
// Apply: the registry-apply, config-apply and config-restore operations. Each writes files atomically, runs the
// mapped reloads, checks the Asterisk log (and for the registry, what Asterisk shows), and can resume after a restart.
// Usage: const ops = createConfigOps({ paths, log }); ops.register(runner); runner.enqueue({ kind: 'registry-apply', params: { registry, base_hash }, actor: 'admin' })
import fs from 'node:fs';
import { join, posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AmiDisconnected, AmiError } from '../ami/client.js';
import { OperationError } from '../ops/runner.js';
import { fileHash, readFile, sha256, writeAtomic } from './atomic.js';
import { GENERATED_FILES, generateAll } from './generators.js';
import { lintFile, lintRegistryRefs } from './lint.js';
import { readPrev, savePrev, stagedPath, swapPrev } from './prev.js';
import { actionKey, RELOAD, RESTART, reloadActions, reloadFor } from './reloadmap.js';
import { load as loadRegistry, RegistryError, stringify, validate, write as writeRegistry } from './registry.js';
import { scan } from './scan.js';

/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../ops/runner.js').Context} Context */
/** @typedef {import('../ops/runner.js').Runner} Runner */
/** @typedef {import('./registry.js').Registry} Registry */
/** @typedef {import('./reloadmap.js').ReloadAction} ReloadAction */
/**
 * @typedef {object} ApplyPaths
 * @property {string} configDir    config/asterisk (the container's /etc/asterisk)
 * @property {string} registry     config/aster.yaml
 * @property {string} prevDir      state/prev
 * @property {string} asteriskLog  logs/asterisk/full
 */
/**
 * @typedef {object} Timing
 * @property {number} settleMs          wait after the reloads before the log is read (driver reloads finish in their own threads)
 * @property {number} actionTimeoutMs   each reload action and verification command
 * @property {number} deviceTimeoutMs   the drivers must list the generated devices within this
 * @property {number} devicePollMs      ShowDevices poll period
 * @property {number} restartTimeoutMs  Asterisk must be up again after `core restart gracefully` within this
 */
/**
 * @typedef {object} LogLine  a WARNING/ERROR line of the Asterisk log
 * @property {'WARNING' | 'ERROR'} level
 * @property {string | null} source   the source file Asterisk names (`pbx_config.c`), null when the line has none
 * @property {string} message
 * @property {string} raw
 */
/** @typedef {{ ok: true, log: string[] } | { ok: false, problem: string, log: string[] }} Check */

export const KINDS = Object.freeze(/** @type {const} */ (['registry-apply', 'config-apply', 'config-restore']));
/** The files config-apply accepts: the hand-owned files of the reload map (manager.conf is install.sh's, aster.d/* is generated). */
export const HAND_FILES = Object.freeze(Object.keys(RELOAD).filter((name) => !name.startsWith('aster.d/') && RELOAD[name] !== null));
/** @type {Readonly<Timing>} */
export const DEFAULTS = Object.freeze({ settleMs: 1_000, actionTimeoutMs: 30_000, deviceTimeoutMs: 60_000, devicePollMs: 2_000, restartTimeoutMs: 600_000 });
/** Largest hand-owned file accepted (Asterisk reads lines of up to 8190 bytes; a dialplan is a few hundred KiB at most). */
export const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
/** Log lines kept in a result. */
const MAX_LOG_LINES = 50;
const MAX_LOG_LINE_CHARS = 500;
const DRIVERS = /** @type {const} */ ({ quectel: 'aster.d/quectel-devices.conf', dongle: 'aster.d/dongle-devices.conf' });
/** Keys of a Quectel device section the driver applies only when the device (re)starts: the audio path. */
const AUDIO_KEYS = ['quec_uac', 'alsadev'];
/** A CLI reply that means the reload did not happen. */
const REPLY_PROBLEM = /No such|\bError\b|does not support reload/;

/**
 * Log sources (file name prefixes) of the modules that read each file; config.c is the parser of every file. Driver files
 * count only the parser, since driver monitor threads log unrelated reconnect errors.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const LOG_SOURCES = Object.freeze({
  'extensions.conf': ['pbx', 'config.c'],
  'aster.d/globals.conf': ['pbx', 'config.c'],
  'aster.d/modems.conf': ['pbx', 'config.c'],
  'pjsip.conf': ['res_pjsip', 'pjsip', 'config', 'location.c', 'sorcery.c', 'res_sorcery'],
  'aster.d/phones.conf': ['res_pjsip', 'pjsip', 'config', 'location.c', 'sorcery.c', 'res_sorcery'],
  'quectel.conf': ['config.c'],
  'aster.d/quectel-devices.conf': ['config.c'],
  'dongle.conf': ['config.c'],
  'aster.d/dongle-devices.conf': ['config.c'],
  'musiconhold.conf': ['res_musiconhold.c', 'config.c'],
  'rtp.conf': ['res_rtp_asterisk.c', 'rtp_engine.c', 'config.c'],
  'logger.conf': ['logger.c', 'config.c'],
  'cdr.conf': ['cdr.c', 'config.c'],
  'cel.conf': ['cel.c', 'config.c'],
  'features.conf': ['features', 'bridge', 'config.c'],
  'indications.conf': ['indications.c', 'config.c'],
  'acl.conf': ['acl.c', 'named_acl.c', 'config.c'],
  'udptl.conf': ['udptl.c', 'config.c'],
  'pjproject.conf': ['res_pjproject.c', 'config.c'],
  'asterisk.conf': ['asterisk.c', 'loader.c', 'config.c'],
  'modules.conf': ['loader.c', 'asterisk.c', 'config.c'],
  'ccss.conf': ['ccss.c', 'loader.c', 'config.c'],
  'stasis.conf': ['stasis', 'loader.c', 'config.c'],
  'sorcery.conf': ['sorcery.c', 'res_sorcery', 'res_pjsip', 'config.c'],
});
/** Driver messages of the reload path itself (chan_quectel.c / chan_dongle.c reload_config). */
const DRIVER_RELOAD_MESSAGES = ['duplicate in config file', 'Errors reading config file', 'Skipping device'];

/** `[date] LEVEL[tid][callid] source.c: message` — the file log's default format; `[C-…]` call ids and a `:line func()` suffix are tolerated. */
const TAGGED = /^\[[^\]]*\] (WARNING|ERROR)\[[^\]]*\](?:\[[^\]]*\])*:? ?(.*)$/;
const SOURCE = /^([A-Za-z0-9_./-]+\.c)\b:?(?:\d+)?(?: [A-Za-z0-9_]+\(\):?)? ?(.*)$/;

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message || err.name : String(err));

/** A reload, restart or verification step that did not succeed; the handlers decide what it means. */
class ReloadProblem extends Error {
  /** @param {string} message @param {string[]} [log] */
  constructor(message, log = []) {
    super(message);
    this.name = 'ReloadProblem';
    this.log = log;
  }
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [result]
 */
const failed = (message, result) => new OperationError(message, { status: 'failed', result });
/**
 * @param {string} message
 * @param {Record<string, unknown>} [result]
 */
const uncertain = (message, result) => new OperationError(message, { status: 'uncertain', result });

/**
 * Parses one line of the Asterisk log; null unless it is a WARNING or ERROR line.
 * @param {string} line
 * @returns {LogLine | null}
 */
export function parseLogLine(line) {
  const tagged = TAGGED.exec(line);
  if (!tagged) return null;
  const level = /** @type {'WARNING' | 'ERROR'} */ (tagged[1]);
  const rest = tagged[2] ?? '';
  const source = SOURCE.exec(rest);
  return { level, source: source ? String(source[1]) : null, message: source ? String(source[2]) : rest, raw: line };
}

/**
 * The WARNING/ERROR lines of `text` (the log written during a reload) that concern `files` (names relative to config/asterisk):
 * lines naming one of the files, lines from the sources of the modules that read them (LOG_SOURCES), driver reload messages for
 * driver files, and lines without a recognizable source. Everything else is other activity.
 * @param {string} text
 * @param {readonly string[]} files
 * @returns {string[]} the raw lines, at most MAX_LOG_LINES
 */
export function relevantLogLines(text, files) {
  const names = files.map((file) => posix.basename(file));
  const prefixes = [...new Set(files.flatMap((file) => LOG_SOURCES[file] ?? ['config.c']))];
  const driver = files.some((file) => /(^|\/)(quectel|dongle)[-a-z]*\.conf$/.test(file));
  /** @type {string[]} */
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = parseLogLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (!line) continue;
    const relevant = names.some((name) => line.message.includes(name))
      || line.source === null
      || prefixes.some((prefix) => /** @type {string} */ (line.source).startsWith(prefix))
      || (driver && /^chan_(quectel|dongle)\.c$/.test(line.source) && DRIVER_RELOAD_MESSAGES.some((message) => line.message.includes(message)));
    if (relevant) {
      lines.push(line.raw.length > MAX_LOG_LINE_CHARS ? `${line.raw.slice(0, MAX_LOG_LINE_CHARS)}…` : line.raw);
      if (lines.length === MAX_LOG_LINES) break;
    }
  }
  return lines;
}

/**
 * The section names of a configuration text, in order (the contexts of modems.conf, the devices of a device file).
 * @param {string} text
 */
export const sectionNames = (text) => scan(text).sections.map((section) => section.name);

/**
 * The device sections of a driver file: name → its keys (lower-cased) and values.
 * @param {string} text
 * @returns {Map<string, Map<string, string>>}
 */
export function deviceSections(text) {
  /** @type {Map<string, Map<string, string>>} */
  const devices = new Map();
  for (const line of scan(text).lines) {
    if (line.kind === 'section' && line.name !== undefined) devices.set(line.name, new Map());
    else if ((line.kind === 'kv' || line.kind === 'arrow') && line.section !== null && line.section !== undefined && line.key !== undefined) {
      devices.get(line.section)?.set(line.key.toLowerCase(), line.value ?? '');
    }
  }
  return devices;
}

/**
 * The Quectel devices present in both texts whose audio settings differ (quec_uac, alsadev): the driver's reload copies the new
 * values but restarts a device only for other changes, so the audio path is applied by a restart.
 * @param {string} before
 * @param {string} after
 */
export function audioChanged(before, after) {
  const old = deviceSections(before);
  return [...deviceSections(after)].filter(([name, keys]) => {
    const previous = old.get(name);
    return previous !== undefined && AUDIO_KEYS.some((key) => (previous.get(key) ?? null) !== (keys.get(key) ?? null));
  }).map(([name]) => name);
}

/**
 * @param {unknown} value
 * @param {string} what
 */
function stringParam(value, what) {
  if (typeof value !== 'string') throw failed(`${what} must be a string`);
  return value;
}
/**
 * @param {unknown} value
 * @param {string} what
 */
function optionalHash(value, what) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw failed(`${what} must be the sha256 (hex) the file was loaded with, or null`);
  return value;
}
/**
 * @param {unknown} value
 * @param {string} what
 */
function flag(value, what) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw failed(`${what} must be true or false`);
  return value;
}

/** @param {Record<string, string>} generated @param {string} configDir */
function changedGenerated(generated, configDir) {
  return GENERATED_FILES.filter((name) => fileHash(join(configDir, name)) !== sha256(generated[name] ?? ''));
}

/**
 * @typedef {object} AppliedInfo  what registry-apply hands to hooks.applied after a successful reload and verification
 * @property {AmiClient} ami
 * @property {Registry | null} before  the registry on disk before the write (null when there was none or it was invalid)
 * @property {Registry} after
 * @property {Readonly<Record<string, string>>} generated
 * @property {Record<string, unknown>} result  the operation's result so far
 */
/**
 * @typedef {object} Hooks
 * @property {(ctx: Context, info: AppliedInfo) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void} [applied]
 *   runs at the end of registry-apply; its value becomes `result.reconcile`; an error ends the operation `failed`
 */
/**
 * @param {{ paths: ApplyPaths, log?: Logger, now?: () => number, timing?: Partial<Timing>, hooks?: Hooks }} options
 */
export function createConfigOps({ paths, log = SILENT, now = Date.now, timing = {}, hooks = {} }) {
  const t = { ...DEFAULTS, ...timing };
  const { configDir, prevDir } = paths;

  // ---- includes and lint ----

  /**
   * The files an #include target (as written) names: relative to the configuration directory, `/etc/asterisk/…` mapped onto it,
   * globs expanded; a target outside the directory is invisible to the controller.
   * @param {string} target
   */
  function includeTargets(target) {
    const rel = target.startsWith('/etc/asterisk/') ? target.slice('/etc/asterisk/'.length) : target;
    if (posix.isAbsolute(rel) || rel.split('/').includes('..')) return [];
    if (/[*?[]/.test(rel)) return fs.globSync(rel, { cwd: configDir }).map((match) => join(configDir, match)).sort();
    return [join(configDir, rel)];
  }
  /** @param {string} target */
  const existsInclude = (target) => includeTargets(target).some((path) => {
    try {
      return fs.statSync(path).isFile();
    } catch {
      return false;
    }
  });
  /** @param {string} target */
  const readInclude = (target) => {
    const texts = [];
    for (const path of includeTargets(target)) {
      try {
        const file = readFile(path);
        if (file) texts.push(file.text);
      } catch {
        // unreadable: treated as absent
      }
    }
    return texts.length === 0 ? null : texts.join('\n');
  };

  /** The registry on disk for reference checks; null when there is none or it is not valid (logged). */
  function currentRegistry() {
    try {
      return loadRegistry(paths.registry).registry;
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('registry not found'))) log.warn('the registry cannot be loaded; its references are not checked', { err });
      return null;
    }
  }

  /** @param {string} name */
  const handText = (name) => readFile(join(configDir, name))?.text;

  /**
   * Lint problems of a hand-owned file's text, and for extensions.conf/pjsip.conf the registry references it must keep.
   * @param {string} name
   * @param {string} text
   * @returns {{ path: string, message: string }[]}
   */
  function lintHand(name, text) {
    const problems = lintFile(name, text, { existsInclude }).map((problem) => ({ path: `${name}:${problem.line}`, message: problem.message }));
    if (problems.length === 0 && (name === 'extensions.conf' || name === 'pjsip.conf')) {
      const registry = currentRegistry();
      if (registry) {
        const extensionsText = name === 'extensions.conf' ? text : handText('extensions.conf') ?? '';
        const pjsipText = name === 'pjsip.conf' ? text : handText('pjsip.conf');
        problems.push(...lintRegistryRefs(registry, extensionsText, { readInclude, pjsipText }));
      }
    }
    return problems;
  }

  // ---- AMI ----

  /** @param {Context} ctx */
  function requireAmi(ctx) {
    if (!ctx.ami) throw failed('the controller has no AMI connection to Asterisk; the change was not applied');
    if (!ctx.ami.connected) {
      throw failed(`Asterisk is not connected over AMI (${ctx.ami.lastError ? errorText(ctx.ami.lastError) : ctx.ami.state}); the change was not applied`);
    }
    return ctx.ami;
  }

  /**
   * Runs one reload action and reads its reply.
   * @param {AmiClient} ami
   * @param {ReloadAction} action
   */
  async function runAction(ami, action) {
    const label = actionKey(action);
    /** @type {string[]} */
    let lines;
    try {
      if ('Command' in action) {
        lines = await ami.command(action.Command, { timeout: t.actionTimeoutMs });
      } else {
        const response = await ami.action(action.action, { When: action.When }, { timeout: t.actionTimeoutMs });
        const message = response.get('Message');
        lines = [Array.isArray(message) ? message.join(' ') : message ?? ''];
      }
    } catch (err) {
      throw new ReloadProblem(`${label}: ${errorText(err)}`);
    }
    const bad = lines.find((line) => REPLY_PROBLEM.test(line));
    if (bad !== undefined) throw new ReloadProblem(`${label}: ${bad}`);
  }

  /**
   * `core restart gracefully`: Asterisk never answers — the connection drops when it exits — and the client reconnects on its own.
   * @param {AmiClient} ami
   */
  async function restartAsterisk(ami) {
    const started = now();
    try {
      await ami.command('core restart gracefully', { timeout: t.restartTimeoutMs });
    } catch (err) {
      if (!(err instanceof AmiDisconnected)) throw new ReloadProblem(`core restart gracefully: ${errorText(err)} (Asterisk may still restart once its calls end)`);
    }
    const remaining = t.restartTimeoutMs - (now() - started);
    if (ami.connected) return;
    await new Promise((resolve, reject) => {
      const onUp = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
      const timer = setTimeout(() => {
        ami.off('up', onUp);
        reject(new ReloadProblem(`Asterisk did not come back over AMI within ${Math.round(t.restartTimeoutMs / 1000)} s of core restart gracefully`));
      }, Math.max(remaining, 1));
      ami.once('up', onUp);
    });
  }

  // ---- the Asterisk log ----

  /** The size of the log now; null when it cannot be read. */
  function logOffset() {
    try {
      return fs.statSync(paths.asteriskLog).size;
    } catch {
      return null;
    }
  }
  /** @param {number} offset */
  function logSince(offset) {
    const bytes = fs.readFileSync(paths.asteriskLog);
    return bytes.subarray(bytes.length < offset ? 0 : offset).toString('utf8');
  }

  /**
   * Runs `actions` in order, waits settleMs, then reads the log written meanwhile for lines that concern `files`.
   * @param {Context} ctx
   * @param {AmiClient} ami
   * @param {readonly string[]} files
   * @param {readonly ReloadAction[]} actions
   * @returns {Promise<Check>}
   */
  async function reloadAndCheck(ctx, ami, files, actions) {
    const offset = logOffset();
    for (const action of actions) {
      ctx.progress(actionKey(action));
      try {
        if (action === RESTART) await restartAsterisk(ami);
        else await runAction(ami, action);
      } catch (err) {
        if (err instanceof ReloadProblem) return { ok: false, problem: err.message, log: [] };
        throw err;
      }
    }
    if (actions.length === 0) return { ok: true, log: [] };
    if (t.settleMs > 0) await sleep(t.settleMs);
    if (offset === null) throw uncertain(`the Asterisk log ${paths.asteriskLog} cannot be read, so the reload was not verified`);
    /** @type {string} */
    let text;
    try {
      text = logSince(offset);
    } catch (err) {
      throw uncertain(`the Asterisk log ${paths.asteriskLog} cannot be read (${errorText(err)}), so the reload was not verified`);
    }
    const lines = relevantLogLines(text, files);
    return lines.length === 0 ? { ok: true, log: [] } : { ok: false, problem: `Asterisk logged ${lines.length} problem line(s)`, log: lines };
  }

  // ---- verification ----

  /** @param {AmiClient} ami @param {string} context */
  async function contextExists(ami, context) {
    try {
      await ami.command(`dialplan show ${context}`, { timeout: t.actionTimeoutMs });
      return true;
    } catch (err) {
      if (err instanceof AmiError && /There is no existence of/.test(err.message)) return false;
      throw new ReloadProblem(`dialplan show ${context}: ${errorText(err)}`);
    }
  }
  /** @param {AmiClient} ami @param {string} number */
  async function endpointExists(ami, number) {
    try {
      const lines = await ami.command(`pjsip show endpoint ${number}`, { timeout: t.actionTimeoutMs });
      return !lines.some((line) => line.startsWith('Unable to find object'));
    } catch (err) {
      throw new ReloadProblem(`pjsip show endpoint ${number}: ${errorText(err)}`);
    }
  }
  /**
   * @param {AmiClient} ami
   * @param {'quectel' | 'dongle'} driver
   * @returns {Promise<Map<string, string>>} device → State
   */
  async function listDevices(ami, driver) {
    const action = driver === 'quectel' ? 'QuectelShowDevices' : 'DongleShowDevices';
    /** @type {import('../ami/parser.js').Packet[]} */
    let entries;
    try {
      entries = await ami.list(action, {}, `${action}Complete`, { timeout: t.actionTimeoutMs });
    } catch (err) {
      throw new ReloadProblem(`${action}: ${errorText(err)}`);
    }
    return new Map(entries.map((entry) => [String(entry.get('Device') ?? ''), String(entry.get('State') ?? '')]));
  }
  /**
   * Waits until the driver lists exactly `expected`.
   * @param {AmiClient} ami
   * @param {'quectel' | 'dongle'} driver
   * @param {string[]} expected
   * @returns {Promise<{ ok: boolean, devices: Map<string, string> }>}
   */
  async function awaitDevices(ami, driver, expected) {
    const want = [...expected].sort().join('\n');
    const deadline = now() + t.deviceTimeoutMs;
    for (;;) {
      const devices = await listDevices(ami, driver);
      if ([...devices.keys()].sort().join('\n') === want) return { ok: true, devices };
      if (now() >= deadline) return { ok: false, devices };
      await sleep(t.devicePollMs);
    }
  }

  // ---- registry-apply ----

  /**
   * @param {Context} ctx
   * @param {boolean} resumed  re-evaluation after a controller restart
   */
  async function registryApply(ctx, resumed, params = ctx.op.params ?? {}) {
    if (typeof params.registry !== 'object' || params.registry === null) throw failed('registry-apply needs params.registry: the whole registry to apply');
    const baseHash = optionalHash(params.base_hash, 'base_hash');
    const force = flag(params.force, 'force');
    /** @type {Registry} */
    let reg;
    /** @type {Readonly<Record<string, string>>} */
    let generated;
    try {
      reg = validate(params.registry);
      generated = generateAll(reg);
    } catch (err) {
      if (err instanceof RegistryError) throw failed(`the registry is invalid (${err.errors.length} problem${err.errors.length === 1 ? '' : 's'}); nothing was written`, { problems: err.errors });
      throw err;
    }
    const targetHash = sha256(stringify(reg));
    const current = readFile(paths.registry);
    const currentHash = current?.hash ?? null;
    if (!resumed) {
      if (!force && currentHash !== baseHash) {
        throw failed(currentHash === null ? 'the registry file does not exist, but base_hash names a version; reload and apply again'
          : 'the registry changed on disk since it was loaded; reload it and apply again (or force)', { current_hash: currentHash });
      }
    } else if (currentHash !== baseHash && currentHash !== targetHash && !force) {
      throw uncertain('the registry changed while the operation was interrupted; it was not applied again', { current_hash: currentHash });
    }
    const problems = lintRegistryRefs(reg, handText('extensions.conf') ?? '', { readInclude, pjsipText: handText('pjsip.conf') });
    if (problems.length > 0) throw failed(`the registry refers to what the hand-owned files do not define (${problems.length} problem${problems.length === 1 ? '' : 's'}); nothing was written`, { problems });

    const beforeRegistry = hooks.applied ? currentRegistry() : null;
    /** @type {Record<string, string>} */
    const before = {};
    for (const name of GENERATED_FILES) before[name] = readFile(join(configDir, name))?.text ?? '';
    const changed = changedGenerated(generated, configDir);
    const reloadSet = resumed || force ? [...GENERATED_FILES] : changed;
    const actions = reloadActions(reloadSet);
    const ami = actions.length > 0 ? requireAmi(ctx) : null;

    if (currentHash !== targetHash) {
      ctx.progress('writing aster.yaml');
      writeRegistry(paths.registry, reg);
    }
    if (changed.length > 0) {
      ctx.progress(`writing ${changed.join(', ')}`);
      fs.mkdirSync(join(configDir, 'aster.d'), { recursive: true });
      for (const name of changed) writeAtomic(join(configDir, name), generated[name] ?? '');
    }
    /** @type {Record<string, unknown>} */
    const result = { registry_hash: targetHash, files_written: changed, actions: actions.map(actionKey), verified: { contexts: [], endpoints: [], devices: {} }, restarted: [], log: [], observed_at: now() };
    if (!ami) return result;

    const check = await reloadAndCheck(ctx, ami, reloadSet, actions);
    result.log = check.log;
    if (!check.ok) throw failed(`the registry and ${changed.length} generated file(s) were written, but ${check.problem}`, result);

    ctx.progress('verifying');
    const verified = /** @type {{ contexts: string[], endpoints: string[], devices: Record<string, string[]> }} */ (result.verified);
    /** @type {string[]} */
    const missing = [];
    try {
      if (reloadSet.includes('aster.d/modems.conf')) {
        for (const context of sectionNames(generated['aster.d/modems.conf'] ?? '')) {
          if (await contextExists(ami, context)) verified.contexts.push(context);
          else missing.push(`context ${context}`);
        }
      }
      if (reloadSet.includes('aster.d/phones.conf')) {
        for (const phone of reg.phones) {
          if (await endpointExists(ami, phone.number)) verified.endpoints.push(phone.number);
          else missing.push(`endpoint ${phone.number}`);
        }
      }
      for (const [driver, file] of Object.entries(DRIVERS)) {
        if (!reloadSet.includes(file)) continue;
        const expected = sectionNames(generated[file] ?? '');
        const { ok, devices } = await awaitDevices(ami, /** @type {'quectel' | 'dongle'} */ (driver), expected);
        verified.devices[driver] = [...devices.keys()].sort();
        if (!ok) missing.push(`${driver} devices ${JSON.stringify(expected)} (listed: ${JSON.stringify([...devices.keys()].sort())})`);
        else if (driver === 'quectel') {
          for (const device of audioChanged(before[file] ?? '', generated[file] ?? '')) {
            if (devices.get(device) === 'Stopped') continue;
            ctx.progress(`QuectelRestart ${device}`);
            await ami.action('QuectelRestart', { Device: device, When: 'gracefully' }, { timeout: t.actionTimeoutMs });
            /** @type {string[]} */ (result.restarted).push(device);
          }
        }
      }
    } catch (err) {
      if (err instanceof ReloadProblem) throw failed(`the files were written and reloaded, but the verification did not complete: ${err.message}`, result);
      throw failed(`the files were written and reloaded, but ${errorText(err)}`, result);
    }
    if (missing.length > 0) throw failed(`the files were written and reloaded, but Asterisk does not show ${missing.join('; ')}`, { ...result, missing });
    if (hooks.applied) {
      try {
        const reconcile = await hooks.applied(ctx, { ami, before: beforeRegistry, after: reg, generated, result });
        if (reconcile !== undefined) result.reconcile = reconcile;
      } catch (err) {
        if (err instanceof OperationError) throw err;
        throw failed(`the files were written and reloaded, but ${errorText(err)}`, result);
      }
    }
    return result;
  }

  // ---- config-apply ----

  /** @param {unknown} value */
  function handName(value) {
    const name = stringParam(value, 'name');
    if (HAND_FILES.includes(name)) return name;
    if (name.startsWith('aster.d/') || GENERATED_FILES.includes(name)) throw failed(`${name} is generated from aster.yaml; change the registry instead`);
    if (name === 'manager.conf') throw failed('manager.conf is written by install.sh from secrets.env; the controller never applies it');
    throw failed(`${name} is not a hand-owned configuration file (${HAND_FILES.join(', ')})`);
  }

  /**
   * @param {Context} ctx
   * @param {boolean} resumed
   */
  async function configApply(ctx, resumed) {
    const params = ctx.op.params ?? {};
    const name = handName(params.name);
    const content = stringParam(params.content, 'content');
    if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw failed(`${name}: the content is larger than ${MAX_CONTENT_BYTES} bytes`);
    const baseHash = optionalHash(params.base_hash, 'base_hash');
    const force = flag(params.force, 'force');
    const restart = flag(params.restart, 'restart');
    const path = join(configDir, name);
    const current = readFile(path);
    const currentHash = current?.hash ?? null;
    const targetHash = sha256(content);
    /** @type {'write' | 'written'} */
    let stage;
    if (!resumed) {
      if (!force && currentHash !== baseHash) {
        throw failed(currentHash === null ? `${name} does not exist on disk, but base_hash names a version; reload and apply again`
          : `${name} changed on disk since it was opened; reload it and apply again (or force)`, { name, current_hash: currentHash });
      }
      stage = 'write';
    } else if (currentHash === targetHash) {
      stage = 'written';
    } else if (force || currentHash === baseHash) {
      stage = 'write';
    } else {
      throw uncertain(`${name} changed while the operation was interrupted; it was not applied again`, { name, current_hash: currentHash });
    }
    const problems = lintHand(name, content);
    if (problems.length > 0) throw failed(`${name} has ${problems.length} lint problem${problems.length === 1 ? '' : 's'}; nothing was written`, { name, problems });
    const actions = reloadFor(name);
    const restarts = actions.includes(RESTART);
    if (restarts && !restart) throw failed(`${name} takes effect only after a graceful restart of Asterisk (calls end first); confirm with restart: true`, { name });
    const ami = requireAmi(ctx);

    const previousHash = stage === 'write' ? currentHash : readPrev(prevDir, name)?.hash ?? null;
    if (stage === 'write') {
      ctx.progress(`writing ${name}`);
      if (current) savePrev(prevDir, name, current.bytes);
      writeAtomic(path, content);
    }
    const check = await reloadAndCheck(ctx, ami, [name], actions);
    /** @type {Record<string, unknown>} */
    const result = { name, hash: targetHash, previous_hash: previousHash, actions: actions.map(actionKey), restart: restarts, log: check.log, observed_at: now() };
    if (check.ok) return result;

    ctx.progress(`restoring the previous ${name}`);
    const prev = readPrev(prevDir, name);
    if (prev) writeAtomic(path, prev.bytes);
    else fs.rmSync(path, { force: true });
    const again = await reloadAndCheck(ctx, ami, [name], actions);
    throw failed(`${name} was not applied: ${check.problem}; the previous version is back${again.ok ? '' : `, but ${again.problem}`}`,
      { ...result, hash: prev?.hash ?? null, restored: true, restore_log: again.log, observed_at: now() });
  }

  // ---- config-restore ----

  /**
   * @param {Context} ctx
   * @param {boolean} resumed
   */
  async function configRestore(ctx, resumed) {
    const params = ctx.op.params ?? {};
    const name = handName(params.name);
    const baseHash = optionalHash(params.base_hash, 'base_hash');
    const restart = flag(params.restart, 'restart');
    const path = join(configDir, name);
    const current = readFile(path);
    if (!current) throw failed(`${name} does not exist on disk; nothing to restore over`, { name });
    const prev = readPrev(prevDir, name);
    /** @type {'swap' | 'resume' | 'swapped'} */
    let stage = 'swap';
    if (!resumed) {
      if (baseHash !== null && current.hash !== baseHash) throw failed(`${name} changed on disk since it was opened; reload it and restore again`, { name, current_hash: current.hash });
    } else if (readFile(stagedPath(prevDir, name))) {
      stage = 'resume';
    } else if (baseHash !== null && prev?.hash === baseHash) {
      stage = 'swapped';
    } else if (baseHash === null || current.hash !== baseHash) {
      throw uncertain(`${name} was not restored again: the operation was interrupted and the files match neither the state before nor the one after the swap`, { name, current_hash: current.hash });
    }
    if (stage !== 'swapped') {
      const toRestore = stage === 'resume' ? readFile(join(configDir, name)) : prev;
      if (!prev && stage === 'swap') throw failed(`${name} has no previous applied version`, { name });
      const problems = stage === 'swap' && prev ? lintHand(name, prev.text) : toRestore ? lintHand(name, toRestore.text) : [];
      if (problems.length > 0) throw failed(`the previous ${name} has ${problems.length} lint problem${problems.length === 1 ? '' : 's'} now; it was not restored`, { name, problems });
    }
    const actions = reloadFor(name);
    const restarts = actions.includes(RESTART);
    if (restarts && !restart) throw failed(`${name} takes effect only after a graceful restart of Asterisk (calls end first); confirm with restart: true`, { name });
    const ami = requireAmi(ctx);

    let hash = current.hash;
    let previousHash = prev?.hash ?? null;
    if (stage !== 'swapped') {
      ctx.progress(`restoring the previous ${name}`);
      ({ hash, previousHash } = swapPrev(prevDir, configDir, name, { resume: stage === 'resume' }));
    }
    const check = await reloadAndCheck(ctx, ami, [name], actions);
    /** @type {Record<string, unknown>} */
    const result = { name, hash, previous_hash: previousHash, actions: actions.map(actionKey), restart: restarts, log: check.log, observed_at: now() };
    if (check.ok) return result;
    throw failed(`the previous ${name} is back on disk, but ${check.problem}`, result);
  }

  return {
    handlers: Object.freeze({
      'registry-apply': (/** @type {Context} */ ctx) => registryApply(ctx, false),
      'config-apply': (/** @type {Context} */ ctx) => configApply(ctx, false),
      'config-restore': (/** @type {Context} */ ctx) => configRestore(ctx, false),
    }),
    reevaluate: Object.freeze({
      'registry-apply': (/** @type {Context} */ ctx) => registryApply(ctx, true),
      'config-apply': (/** @type {Context} */ ctx) => configApply(ctx, true),
      'config-restore': (/** @type {Context} */ ctx) => configRestore(ctx, true),
    }),
    /** Registers the three kinds (global lock, re-evaluation after a restart). @param {Runner} runner */
    register(runner) {
      for (const kind of KINDS) runner.register(kind, this.handlers[kind], { reevaluate: this.reevaluate[kind] });
    },
    /**
     * The registry-apply steps for a caller that already holds the global lock: the same checks, writes, reloads,
     * verification and hooks as the operation, with these params instead of ctx.op.params.
     * @param {Context} ctx
     * @param {{ registry: unknown, base_hash: string | null, force?: boolean }} params
     */
    apply: (ctx, params) => registryApply(ctx, false, /** @type {Record<string, unknown>} */ (params)),
    lintHand,
    existsInclude,
    readInclude,
  };
}
