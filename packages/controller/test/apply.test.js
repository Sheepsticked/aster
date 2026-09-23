// @ts-check
// Tests for src/config/{atomic,prev,apply}.js and src/logs/rotate.js on a copy of docker/asterisk/test-config with
// test-registry.yaml as the registry and a scripted AMI.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AmiDisconnected, AmiError } from '../src/ami/client.js';
import { fileHash, readFile, sha256, writeAtomic } from '../src/config/atomic.js';
import { audioChanged, createConfigOps, deviceSections, HAND_FILES, KINDS, parseLogLine, relevantLogLines, sectionNames } from '../src/config/apply.js';
import { GENERATED_FILES, generateAll } from '../src/config/generators.js';
import { prevPath, readPrev, savePrev, stagedPath, swapPrev } from '../src/config/prev.js';
import { load, parse, stringify } from '../src/config/registry.js';
import { checkLog, pruneRotated, rotatedFiles, startLogRotation } from '../src/logs/rotate.js';
import { createBus } from '../src/bus.js';
import { createRunner, GLOBAL_KINDS } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';

/** @typedef {import('../src/ops/runner.js').Context} Context */
/** @typedef {import('../src/ami/client.js').AmiClient} AmiClient */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_CONFIG = join(REPO, 'docker/asterisk/test-config');
const TEST_REGISTRY = join(REPO, 'docker/asterisk/test-registry.yaml');
const tmp = mkdtempSync(join(tmpdir(), 'aster-apply-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const TIMING = { settleMs: 0, actionTimeoutMs: 1_000, deviceTimeoutMs: 200, devicePollMs: 10, restartTimeoutMs: 2_000 };
let counter = 0;

/**
 * An ASTER_HOME-like tree: config/asterisk = a copy of test-config, config/aster.yaml = test-registry.yaml, state/prev, logs/asterisk/full.
 * @param {string} [label]
 */
function home(label = 'h') {
  const root = join(tmp, `${label}-${++counter}`);
  const configDir = join(root, 'config', 'asterisk');
  cpSync(TEST_CONFIG, configDir, { recursive: true });
  const registry = join(root, 'config', 'aster.yaml');
  writeFileSync(registry, readFileSync(TEST_REGISTRY));
  const prevDir = join(root, 'state', 'prev');
  mkdirSync(join(root, 'logs', 'asterisk'), { recursive: true });
  const asteriskLog = join(root, 'logs', 'asterisk', 'full');
  writeFileSync(asteriskLog, '[2026-09-11 06:33:08] NOTICE[1] loader.c: 73 modules will be loaded.\n');
  const paths = { configDir, registry, prevDir, asteriskLog };
  return {
    root,
    paths,
    /** @param {string} name */
    read: (name) => readFileSync(join(configDir, name), 'utf8'),
    /** @param {string} name @param {string} text */
    write: (name, text) => writeFileSync(join(configDir, name), text),
    /** @param {string} line */
    logLine: (line) => fs.appendFileSync(asteriskLog, `${line}\n`),
    /** the registry as a plain object to modify and apply @returns {any} */
    registry: () => structuredClone(parse(readFileSync(registry, 'utf8'))),
    registryHash: () => load(registry).hash,
  };
}

/** A scripted AMI: replies like Asterisk 20.21.0 and, on a reload, re-reads the files as the modules would. */
class FakeAmi extends EventEmitter {
  /** @param {{ configDir: string, connected?: boolean }} options */
  constructor({ configDir, connected = true }) {
    super();
    this.configDir = configDir;
    this.up = connected;
    /** every request, in order @type {string[]} */
    this.calls = [];
    /** @type {Set<string>} */
    this.contexts = new Set();
    /** @type {Set<string>} */
    this.endpoints = new Set();
    /** @type {{ quectel: Map<string, string>, dongle: Map<string, string> }} */
    this.devices = { quectel: new Map(), dongle: new Map() };
    /** @type {((cli: string) => Promise<string[] | undefined> | string[] | undefined) | null} */
    this.onCommand = null;
    /** @type {((name: string, headers: Record<string, unknown>) => void) | null} */
    this.onAction = null;
    this.lastError = null;
    this.reloadAll();
  }
  get connected() {
    return this.up;
  }
  get state() {
    return this.up ? 'up' : 'connecting';
  }
  /** @param {string} name */
  #sections(name) {
    try {
      return sectionNames(readFileSync(join(this.configDir, name), 'utf8'));
    } catch {
      return [];
    }
  }
  reloadDialplan() {
    this.contexts = new Set([...this.#sections('extensions.conf'), ...this.#sections('aster.d/modems.conf')].filter((n) => n !== 'general' && n !== 'globals'));
  }
  reloadPjsip() {
    this.endpoints = new Set(this.#sections('aster.d/phones.conf'));
  }
  /** @param {'quectel' | 'dongle'} driver */
  reloadDriver(driver) {
    const listed = this.devices[driver];
    this.devices[driver] = new Map(this.#sections(`aster.d/${driver}-devices.conf`).map((name) => [name, listed.get(name) ?? 'Stopped']));
  }
  reloadAll() {
    this.reloadDialplan();
    this.reloadPjsip();
    this.reloadDriver('quectel');
    this.reloadDriver('dongle');
  }
  /** @param {string} cli @param {{ timeout?: number }} [_options] */
  async command(cli, _options) {
    this.calls.push(`Command: ${cli}`);
    if (!this.up) throw new AmiDisconnected('not up');
    if (this.onCommand) {
      const scripted = await this.onCommand(cli);
      if (scripted !== undefined) return scripted;
    }
    if (cli === 'dialplan reload') {
      this.reloadDialplan();
      return ['Dialplan reloaded.'];
    }
    const reload = /^module reload (\S+)$/.exec(cli);
    if (reload) {
      if (reload[1] === 'res_pjsip.so') this.reloadPjsip();
      return [`Module '${reload[1]}' reloaded successfully.`];
    }
    const show = /^dialplan show (\S+)$/.exec(cli);
    if (show) {
      if (this.contexts.has(String(show[1]))) return [`[ Context '${show[1]}' created by 'pbx_config' ]`];
      throw new AmiError(`There is no existence of '${show[1]}' context\nCommand 'dialplan show ${show[1]}' failed.`, new Map([['Response', 'Error']]));
    }
    const endpoint = /^pjsip show endpoint (\S+)$/.exec(cli);
    if (endpoint) return this.endpoints.has(String(endpoint[1])) ? ['', ` Endpoint:  ${endpoint[1]}/${endpoint[1]}`] : [`Unable to find object ${endpoint[1]}.`, ''];
    if (cli === 'core restart gracefully') {
      this.up = false;
      setTimeout(() => {
        this.up = true;
        this.reloadAll();
        this.emit('up');
      }, 20);
      throw new AmiDisconnected('connection closed');
    }
    if (cli === 'logger rotate') return [''];
    if (cli === 'moh reload' || cli === 'logger reload') return [''];
    throw new AmiError(`No such command '${cli}'`, new Map([['Response', 'Error']]));
  }
  /** @param {string} name @param {Record<string, unknown>} [headers] @param {{ timeout?: number }} [_options] */
  async action(name, headers = {}, _options) {
    this.calls.push(headers.Device ? `${name} ${headers.Device}` : name);
    if (!this.up) throw new AmiDisconnected('not up');
    if (name === 'QuectelReload' || name === 'DongleReload') {
      this.reloadDriver(name === 'QuectelReload' ? 'quectel' : 'dongle');
      if (this.onAction) this.onAction(name, headers);
      return new Map([['Response', 'Success'], ['Message', 'reload scheduled']]);
    }
    if (this.onAction) this.onAction(name, headers);
    if (name === 'QuectelRestart' || name === 'DongleRestart') return new Map([['Response', 'Success'], ['Message', 'restart scheduled']]);
    throw new AmiError(`Invalid/unknown command: ${name}.`, new Map([['Response', 'Error']]));
  }
  /** @param {string} name @param {Record<string, unknown>} _headers @param {string} _complete @param {{ timeout?: number }} [_options] */
  async list(name, _headers, _complete, _options) {
    this.calls.push(name);
    if (!this.up) throw new AmiDisconnected('not up');
    const driver = name.startsWith('Quectel') ? 'quectel' : 'dongle';
    return [...this.devices[driver]].map(([device, state]) => new Map([['Event', `${driver}DeviceEntry`], ['Device', device], ['State', state]]));
  }
}

/**
 * The handler context of a direct call (no runner).
 * @param {{ kind: string, params: Record<string, unknown>, ami: FakeAmi | null, interruptedAt?: number | null }} options
 */
function context({ kind, params, ami, interruptedAt = null }) {
  /** @type {string[]} */
  const progress = [];
  const ctx = /** @type {Context} */ (/** @type {unknown} */ ({
    op: { id: 1, kind, modemId: null, params, actor: 'admin', createdAt: 1, interruptedAt },
    progress: (/** @type {string} */ message) => progress.push(message),
    db: null,
    ami,
    bus: createBus(),
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  }));
  return { ctx, progress };
}

/**
 * Runs a handler and returns { status, result, error } as the runner would store them.
 * @param {(ctx: Context) => unknown} handler
 * @param {Context} ctx
 * @returns {Promise<{ status: string, result: any, error: string | null }>}
 */
async function outcome(handler, ctx) {
  try {
    const result = await handler(ctx);
    return { status: 'done', result, error: null };
  } catch (err) {
    if (err instanceof Error && err.name === 'OperationError') {
      const op = /** @type {import('../src/ops/runner.js').OperationError} */ (err);
      return { status: op.status, result: op.result ?? null, error: op.message };
    }
    throw err;
  }
}

/** @param {ReturnType<typeof home>} h @param {FakeAmi | null} ami */
const ops = (h, ami, extra = {}) => ({ ops: createConfigOps({ paths: h.paths, timing: TIMING, ...extra }), ami });

describe('apply: atomic writer', () => {
  test('writeAtomic: tmp → fchmod → write → fsync → close → rename → directory fsync; keeps the mode; returns the hash', () => {
    const dir = join(tmp, 'atomic');
    mkdirSync(dir);
    const path = join(dir, 'a.conf');
    writeFileSync(path, 'old\n', { mode: 0o600 });
    /** @type {string[]} */
    const calls = [];
    for (const name of /** @type {const} */ (['openSync', 'fchmodSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'])) {
      const original = fs[name];
      mock.method(fs, name, (/** @type {unknown[]} */ ...args) => {
        const names = name === 'openSync' || name === 'renameSync' ? args.slice(0, 2).map((arg) => basename(String(arg))) : [];
        calls.push([name, ...names].join(' '));
        return /** @type {Function} */ (original).apply(fs, args);
      });
    }
    try {
      assert.deepEqual(writeAtomic(path, 'new\n'), { hash: sha256('new\n') });
    } finally {
      mock.restoreAll();
    }
    assert.deepEqual(calls, ['openSync a.conf.tmp w', 'fchmodSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync a.conf.tmp a.conf', `openSync ${basename(dir)} r`, 'fsyncSync', 'closeSync']);
    assert.equal(readFileSync(path, 'utf8'), 'new\n');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${path}.tmp`));
    assert.deepEqual(readFile(path), { bytes: Buffer.from('new\n'), text: 'new\n', hash: sha256('new\n') });
    assert.equal(fileHash(join(dir, 'none.conf')), null);
  });

  test('an injected rename failure (a crash before the rename) leaves the file intact, no .tmp behind, and names the path', () => {
    const dir = join(tmp, 'atomic-fail');
    mkdirSync(dir);
    const path = join(dir, 'b.conf');
    writeFileSync(path, 'intact\n');
    mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    try {
      assert.throws(() => writeAtomic(path, 'partial'), { message: `cannot write ${path} (nothing was replaced): EIO: i/o error, rename` });
    } finally {
      mock.restoreAll();
    }
    assert.equal(readFileSync(path, 'utf8'), 'intact\n');
    assert.ok(!existsSync(`${path}.tmp`));
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['b.conf']);
  });

  test('a new file is created with mode 0644', () => {
    const path = join(tmp, 'atomic', 'c.conf');
    writeAtomic(path, 'x');
    assert.equal(statSync(path).mode & 0o777, 0o644);
  });
});

describe('apply: previous copies', () => {
  test('savePrev/readPrev; swapPrev exchanges the two files and stages the current one in <name>.new meanwhile', () => {
    const h = home('prev');
    const { prevDir, configDir } = h.paths;
    assert.equal(readPrev(prevDir, 'rtp.conf'), null);
    savePrev(prevDir, 'rtp.conf', 'old rtp\n');
    assert.equal(readPrev(prevDir, 'rtp.conf')?.text, 'old rtp\n');
    assert.equal(prevPath(prevDir, 'rtp.conf'), join(prevDir, 'rtp.conf'));
    h.write('rtp.conf', 'current rtp\n');
    const swapped = swapPrev(prevDir, configDir, 'rtp.conf');
    assert.deepEqual(swapped, { hash: sha256('old rtp\n'), previousHash: sha256('current rtp\n') });
    assert.equal(h.read('rtp.conf'), 'old rtp\n');
    assert.equal(readPrev(prevDir, 'rtp.conf')?.text, 'current rtp\n');
    assert.ok(!existsSync(stagedPath(prevDir, 'rtp.conf')));
    assert.throws(() => swapPrev(prevDir, configDir, 'nope.conf'), /does not exist in the configuration directory/);
    assert.throws(() => swapPrev(prevDir, configDir, 'cdr.conf'), /has no previous applied version/);
    assert.throws(() => prevPath(prevDir, '../etc'), TypeError);
    assert.throws(() => prevPath(prevDir, 'aster.d/modems.conf'), TypeError);
  });

  test('swapPrev resumes an interrupted swap from the staged file: before step 2 (staged = current) and after it', () => {
    const h = home('prev-resume');
    const { prevDir, configDir } = h.paths;
    savePrev(prevDir, 'rtp.conf', 'old\n');
    h.write('rtp.conf', 'current\n');
    // interrupted after step 1: the staged copy equals the current file
    writeAtomic(stagedPath(prevDir, 'rtp.conf'), 'current\n');
    assert.deepEqual(swapPrev(prevDir, configDir, 'rtp.conf', { resume: true }), { hash: sha256('old\n'), previousHash: sha256('current\n') });
    assert.equal(h.read('rtp.conf'), 'old\n');
    assert.equal(readPrev(prevDir, 'rtp.conf')?.text, 'current\n');
    // interrupted after step 2: the current file is already the previous version, the staged copy holds the old current one
    writeAtomic(stagedPath(prevDir, 'rtp.conf'), 'staged\n');
    assert.deepEqual(swapPrev(prevDir, configDir, 'rtp.conf', { resume: true }), { hash: sha256('old\n'), previousHash: sha256('staged\n') });
    assert.equal(h.read('rtp.conf'), 'old\n');
    assert.equal(readPrev(prevDir, 'rtp.conf')?.text, 'staged\n');
    assert.ok(!existsSync(stagedPath(prevDir, 'rtp.conf')));
  });
});

describe('apply: log lines', () => {
  const lines = [
    '[2026-09-11 06:34:32] VERBOSE[86] pbx_variables.c: Setting global variable',
    "[2026-09-11 06:34:32] WARNING[86] pbx.c: Unable to register extension '100' priority 1 in 'bad-ctx', already in use",
    '[2026-09-11 06:34:32] WARNING[86] pbx_config.c: Unable to register extension at line 53 of extensions.conf',
    "[2026-09-11 06:34:32] NOTICE[86] pbx.c: Cannot find extension '101' in context 'bad-ctx'",
    '[2026-09-11 06:34:33] ERROR[91] chan_quectel.c: [gsm1] Lost connection to Quectel',
    '[2026-09-11 06:34:33] WARNING[91] chan_quectel.c: unable to open /dev/ttyUSB2: No such file or directory',
    '[2026-09-11 06:34:33] ERROR[91] chan_quectel.c: device gsm1 already exists, duplicate in config file',
    '[2026-09-11 06:34:33] WARNING[70][C-00000001] chan_pjsip.c: Something about a call',
    '[2026-09-11 06:34:33] ERROR[70] config.c: parse error: No category context for line 3 of /etc/asterisk/rtp.conf',
    '[2026-09-11 06:34:33] WARNING[70] res_pjsip/config_transport.c:123 transport_apply(): Transport already exists',
    '[2026-09-11 06:34:33] ERROR[70] Something without a source',
    'Sep 11 06:34:33 WARNING plain text without the tag format',
    '[2026-09-11 06:34:33] WARNING[70] app_stack.c: a message that names extensions.conf itself',
  ];

  test('parseLogLine reads the level, source and message of WARNING/ERROR lines only', () => {
    assert.equal(parseLogLine(String(lines[0])), null);
    assert.equal(parseLogLine(String(lines[3])), null);
    assert.deepEqual(parseLogLine(String(lines[2])), { level: 'WARNING', source: 'pbx_config.c', message: 'Unable to register extension at line 53 of extensions.conf', raw: lines[2] });
    assert.deepEqual(parseLogLine(String(lines[7]))?.source, 'chan_pjsip.c');
    assert.deepEqual(parseLogLine(String(lines[9])), { level: 'WARNING', source: 'res_pjsip/config_transport.c', message: 'Transport already exists', raw: lines[9] });
    assert.deepEqual(parseLogLine(String(lines[10])), { level: 'ERROR', source: null, message: 'Something without a source', raw: lines[10] });
    assert.equal(parseLogLine(String(lines[11])), null);
  });

  test('relevantLogLines keeps the lines of the reloaded module, lines naming the file, driver reload messages and sourceless lines', () => {
    const text = `${lines.join('\n')}\n`;
    assert.deepEqual(relevantLogLines(text, ['extensions.conf']), [lines[1], lines[2], lines[8], lines[10], lines[12]]);
    assert.deepEqual(relevantLogLines(text, ['aster.d/quectel-devices.conf']), [lines[6], lines[8], lines[10]]);
    assert.deepEqual(relevantLogLines(text, ['aster.d/phones.conf']), [lines[8], lines[9], lines[10]]);
    assert.deepEqual(relevantLogLines(text, ['rtp.conf']), [lines[8], lines[10]]);
    assert.deepEqual(relevantLogLines('', ['extensions.conf']), []);
    const many = Array.from({ length: 80 }, (_, i) => `[2026-09-11 06:34:32] WARNING[86] pbx.c: problem ${i}`).join('\n');
    assert.equal(relevantLogLines(many, ['extensions.conf']).length, 50);
    const long = `[2026-09-11 06:34:32] ERROR[86] pbx.c: ${'x'.repeat(600)}`;
    assert.equal(relevantLogLines(long, ['extensions.conf'])[0]?.length, 501);
  });

  test('deviceSections and audioChanged read the device files', () => {
    const before = '; header\n[gsm1]\ncontext = a\nquec_uac = 1\nalsadev = plughw:CARD=q_1_1_3\n\n[gsm2]\ncontext = b\n';
    const after = '; header\n[gsm1]\ncontext = a\nquec_uac = 1\nalsadev = plughw:CARD=q_1_2\n\n[gsm2]\ncontext = c\n\n[gsm3]\nquec_uac = 1\nalsadev = x\n';
    assert.deepEqual([...deviceSections(before).keys()], ['gsm1', 'gsm2']);
    assert.equal(deviceSections(before).get('gsm1')?.get('alsadev'), 'plughw:CARD=q_1_1_3');
    assert.deepEqual(audioChanged(before, after), ['gsm1']);
    assert.deepEqual(audioChanged(after, after), []);
    assert.deepEqual(sectionNames(after), ['gsm1', 'gsm2', 'gsm3']);
  });
});

describe('apply: registry-apply', () => {
  test('the hand-owned list, the kinds', () => {
    assert.deepEqual([...KINDS], ['registry-apply', 'config-apply', 'config-restore']);
    assert.ok(KINDS.every((kind) => GLOBAL_KINDS.includes(kind)));
    assert.deepEqual([...HAND_FILES], ['asterisk.conf', 'modules.conf', 'extensions.conf', 'pjsip.conf', 'quectel.conf', 'dongle.conf', 'musiconhold.conf',
      'rtp.conf', 'logger.conf', 'cdr.conf', 'cel.conf', 'features.conf', 'indications.conf', 'acl.conf', 'udptl.conf', 'pjproject.conf', 'ccss.conf', 'stasis.conf',
      'sorcery.conf']);
  });

  test('an unchanged registry writes nothing and runs no AMI action; a registry text that differs only in formatting is rewritten', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const before = h.read('aster.d/modems.conf');
    const hash = h.registryHash();
    const { ctx, progress } = context({ kind: 'registry-apply', params: { registry: h.registry(), base_hash: hash }, ami });
    const out = await outcome(o.handlers['registry-apply'], ctx);
    assert.equal(out.status, 'done', out.error ?? '');
    // test-registry.yaml has comments, so the canonical text differs: the registry is rewritten, the generated files are identical
    assert.equal(out.result.registry_hash, sha256(stringify(h.registry())));
    assert.deepEqual(out.result.files_written, []);
    assert.deepEqual(out.result.actions, []);
    assert.deepEqual(ami.calls, []);
    assert.deepEqual(progress, ['writing aster.yaml']);
    assert.equal(h.read('aster.d/modems.conf'), before);
    assert.equal(h.registryHash(), out.result.registry_hash);
    // now the file is canonical: nothing at all happens
    const again = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry: h.registry(), base_hash: h.registryHash() }, ami }).ctx);
    assert.equal(again.status, 'done');
    assert.ok(Number.isSafeInteger(again.result.observed_at));
    assert.deepEqual(ami.calls, []);
  });

  test('a recipient-only change writes the registry and produces zero AMI actions, even without an AMI connection', async () => {
    const h = home();
    const { ops: o } = ops(h, null);
    const registry = h.registry();
    registry.telegram = { ...registry.telegram, default_recipients: ['123456'] };
    registry.modems[0].recipients = ['123456'];
    const out = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash() }, ami: null }).ctx);
    assert.equal(out.status, 'done', out.error ?? '');
    assert.deepEqual(out.result.files_written, []);
    assert.deepEqual(out.result.actions, []);
    assert.deepEqual(load(h.paths.registry).registry.telegram.default_recipients, ['123456']);
    assert.deepEqual(load(h.paths.registry).registry.modems[0]?.recipients, ['123456']);
  });

  test('a new modem and phone: the changed files are written, the reloads run once each in map order, then the verification', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const registry = h.registry();
    registry.modems.push({ id: 'gsm_new', driver: 'quectel', imei: '000000000000009', enabled: true, ring: ['599'], group: 2 });
    registry.phones.push({ number: '596', secret: '596', outbound: 'gsm_new' });
    const { ctx, progress } = context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash() }, ami });
    const out = await outcome(o.handlers['registry-apply'], ctx);
    assert.equal(out.status, 'done', out.error ?? '');
    assert.deepEqual(out.result.files_written, ['aster.d/globals.conf', 'aster.d/modems.conf', 'aster.d/phones.conf', 'aster.d/quectel-devices.conf']);
    assert.deepEqual(out.result.actions, ['Command: dialplan reload', 'Command: module reload res_pjsip.so', 'QuectelReload']);
    const generated = generateAll(registry);
    for (const name of GENERATED_FILES) assert.equal(h.read(name), generated[name], name);
    assert.deepEqual(ami.calls.slice(0, 3), ['Command: dialplan reload', 'Command: module reload res_pjsip.so', 'QuectelReload']);
    const contexts = sectionNames(generated['aster.d/modems.conf'] ?? '');
    assert.ok(contexts.includes('aster-in-gsm_new'));
    assert.deepEqual(ami.calls.slice(3, 3 + contexts.length), contexts.map((c) => `Command: dialplan show ${c}`));
    assert.deepEqual(ami.calls.slice(3 + contexts.length, 3 + contexts.length + 4), ['599', '598', '597', '596'].map((n) => `Command: pjsip show endpoint ${n}`));
    assert.deepEqual(ami.calls.slice(-1), ['QuectelShowDevices']);
    assert.deepEqual(out.result.verified, { contexts, endpoints: ['599', '598', '597', '596'], devices: { quectel: ['gsm_new', 'gsm_test', 'gsm_uac', 'gsm_unmapped'] } });
    assert.deepEqual(out.result.restarted, []);
    assert.deepEqual(out.result.log, []);
    assert.equal(progress[0], 'writing aster.yaml');
    assert.ok(progress.includes('verifying'));
    assert.equal(load(h.paths.registry).registry.modems.length, 6);
  });

  test('a dongle-only change reloads chan_dongle only and verifies its device list; devices in a call are awaited up to the deadline', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const registry = h.registry();
    registry.modems[1].enabled = true; // gsm_dongle: initstate start
    let polls = 0;
    ami.onAction = (name) => {
      if (name === 'DongleReload') ami.devices.dongle.set('stale_device', 'Free');
    };
    const original = ami.list.bind(ami);
    ami.list = async (name, headers, complete, options) => {
      polls += 1;
      if (polls === 3) ami.devices.dongle.delete('stale_device'); // removed gracefully once its call ended
      return original(name, headers, complete, options);
    };
    const out = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash() }, ami }).ctx);
    assert.equal(out.status, 'done', out.error ?? '');
    assert.deepEqual(out.result.files_written, ['aster.d/dongle-devices.conf']);
    assert.deepEqual(out.result.actions, ['DongleReload']);
    assert.deepEqual(out.result.verified, { contexts: [], endpoints: [], devices: { dongle: ['gsm_dongle', 'gsm_ports'] } });
    assert.equal(polls, 3);
  });

  test('a Quectel audio change restarts the device gracefully when it runs; a stopped one is left alone', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    ami.devices.quectel.set('gsm_uac', 'Free');
    const { ops: o } = ops(h, ami);
    const registry = h.registry();
    registry.modems[2].usb_port = '1-1.4'; // gsm_uac: alsadev changes
    registry.modems[3].usb_port = '1-2'; // gsm_unmapped: was unmapped (no quec_uac/alsadev), now mapped; Stopped
    const out = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash() }, ami }).ctx);
    assert.equal(out.status, 'done', out.error ?? '');
    assert.deepEqual(out.result.files_written, ['aster.d/quectel-devices.conf']);
    assert.deepEqual(out.result.restarted, ['gsm_uac']);
    assert.deepEqual(ami.calls.filter((c) => c.startsWith('QuectelRestart')), ['QuectelRestart gsm_uac']);
  });

  test('force reloads everything even when no file changed', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const out = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry: h.registry(), base_hash: null, force: true }, ami }).ctx);
    assert.equal(out.status, 'done', out.error ?? '');
    assert.deepEqual(out.result.files_written, []);
    assert.deepEqual(out.result.actions, ['Command: dialplan reload', 'Command: module reload res_pjsip.so', 'QuectelReload', 'DongleReload']);
    assert.deepEqual(Object.keys(/** @type {any} */ (out.result.verified).devices), ['quectel', 'dongle']);
  });

  test('refusals write nothing: a stale base_hash, a missing file with a base_hash, an invalid registry, a dangling context, no AMI while a reload is needed', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const before = { registry: h.registryHash(), modems: h.read('aster.d/modems.conf') };
    const registry = h.registry();
    registry.modems[0].ring = [];
    const stale = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: sha256('other') }, ami }).ctx);
    assert.equal(stale.status, 'failed');
    assert.match(String(stale.error), /changed on disk since it was loaded/);
    assert.equal(stale.result?.current_hash, before.registry);
    const invalid = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry: { ...registry, version: 2 }, base_hash: before.registry }, ami }).ctx);
    assert.equal(invalid.status, 'failed');
    assert.match(String(invalid.error), /^the registry is invalid \(1 problem\); nothing was written$/);
    assert.deepEqual(invalid.result?.problems, [{ path: 'version', message: 'must be 1, the registry version this controller reads (got number 2)' }]);
    const dangling = h.registry();
    dangling.modems[0].incoming_context = 'not-in-extensions';
    const refs = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry: dangling, base_hash: before.registry }, ami }).ctx);
    assert.equal(refs.status, 'failed');
    assert.match(String(refs.error), /refers to what the hand-owned files do not define \(1 problem\)/);
    assert.deepEqual(refs.result?.problems, [{ path: 'modems[0].incoming_context', message: 'context "not-in-extensions" is not defined in extensions.conf' }]);
    const down = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: before.registry }, ami: null }).ctx);
    assert.equal(down.status, 'failed');
    assert.match(String(down.error), /no AMI connection/);
    ami.up = false;
    const notUp = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: before.registry }, ami }).ctx);
    assert.equal(notUp.status, 'failed');
    assert.match(String(notUp.error), /not connected over AMI \(connecting\)/);
    const noParams = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: {}, ami }).ctx);
    assert.match(String(noParams.error), /needs params\.registry/);
    const badHash = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: 'abc' }, ami }).ctx);
    assert.match(String(badHash.error), /base_hash must be the sha256/);
    assert.equal(h.registryHash(), before.registry);
    assert.equal(h.read('aster.d/modems.conf'), before.modems);
    assert.deepEqual(ami.calls, []);
    rmSync(h.paths.registry);
    const gone = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: before.registry }, ami }).ctx);
    assert.match(String(gone.error), /does not exist, but base_hash names a version/);
    assert.ok(!existsSync(h.paths.registry));
  });

  test('a registry that refers to a context of an included hand file, or to one pjsip.conf already defines, is judged with the includes', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    mkdirSync(join(h.paths.configDir, 'custom'), { recursive: true });
    h.write('custom/one.conf', '[from-include]\nexten => s,1,Hangup()\n');
    h.write('extensions.conf', `${h.read('extensions.conf')}#include custom/*.conf\n`);
    ami.reloadAll();
    const registry = h.registry();
    registry.modems[0].incoming_context = 'from-include';
    const ok = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash() }, ami }).ctx);
    assert.equal(ok.status, 'done', ok.error ?? '');
    h.write('pjsip.conf', `${h.read('pjsip.conf')}\n[596]\ntype = endpoint\n`);
    registry.phones.push({ number: '596', secret: '596', outbound: null });
    const clash = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash() }, ami }).ctx);
    assert.equal(clash.status, 'failed');
    assert.match(String(clash.result?.problems?.[0]?.message), /pjsip\.conf already defines the endpoint \[596\]/);
  });

  test('a reply problem, a relevant log line, a missing context or an incomplete device list end the operation failed after the files were written', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const registry = h.registry();
    registry.modems[0].ring = [];
    ami.onCommand = (cli) => (cli === 'dialplan reload' ? ['No such command'] : undefined);
    const reply = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash() }, ami }).ctx);
    assert.equal(reply.status, 'failed');
    assert.equal(reply.error, 'the registry and 1 generated file(s) were written, but Command: dialplan reload: No such command');
    assert.equal(h.read('aster.d/modems.conf'), generateAll(registry)['aster.d/modems.conf']);
    ami.onCommand = (cli) => {
      if (cli === 'dialplan reload') h.logLine("[2026-09-11 06:34:32] WARNING[86] pbx_config.c: Unable to register extension at line 53 of extensions.conf");
      return undefined;
    };
    const logged = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash(), force: true }, ami }).ctx);
    assert.equal(logged.status, 'failed');
    assert.match(String(logged.error), /written, but Asterisk logged 1 problem line\(s\)$/);
    assert.equal(/** @type {string[]} */ (logged.result?.log).length, 1);
    ami.onCommand = (cli) => {
      if (cli === 'dialplan reload') ami.contexts.delete('aster-hangup');
      if (cli === 'dialplan show aster-hangup') throw new AmiError("There is no existence of 'aster-hangup' context", new Map());
      return undefined;
    };
    const missing = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash(), force: true }, ami }).ctx);
    assert.equal(missing.status, 'failed');
    assert.match(String(missing.error), /does not show context aster-hangup$/);
    assert.deepEqual(missing.result?.missing, ['context aster-hangup']);
    ami.onCommand = null;
    ami.onAction = (name) => {
      if (name === 'QuectelReload') ami.devices.quectel.delete('gsm_uac');
    };
    const devices = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash(), force: true }, ami }).ctx);
    assert.equal(devices.status, 'failed');
    assert.match(String(devices.error), /does not show quectel devices \["gsm_test","gsm_uac","gsm_unmapped"\] \(listed: \["gsm_test","gsm_unmapped"\]\)/);
    ami.onAction = null;
    ami.onCommand = (cli) => {
      if (cli !== 'module reload res_pjsip.so') return undefined;
      ami.reloadPjsip();
      ami.endpoints.delete('598');
      return ["Module 'res_pjsip.so' reloaded successfully."];
    };
    const endpoint = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash(), force: true }, ami }).ctx);
    assert.equal(endpoint.status, 'failed');
    assert.deepEqual(endpoint.result?.missing, ['endpoint 598']);
    assert.deepEqual(/** @type {any} */ (endpoint.result?.verified).endpoints, ['599', '597']);
    ami.onCommand = (cli) => {
      if (cli.startsWith('pjsip show endpoint')) throw new AmiDisconnected('gone');
      return undefined;
    };
    const transport = await outcome(o.handlers['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h.registryHash(), force: true }, ami }).ctx);
    assert.equal(transport.status, 'failed');
    assert.match(String(transport.error), /verification did not complete: pjsip show endpoint 599: gone/);
  });

  test('re-evaluation after a restart: the registry at its base or target hash is accepted, every reload runs; another hash → uncertain', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const base = h.registryHash();
    const registry = h.registry();
    registry.modems[0].ring = [];
    // interrupted after the registry and the files were written, before the reloads
    writeFileSync(h.paths.registry, stringify(registry));
    h.write('aster.d/modems.conf', generateAll(registry)['aster.d/modems.conf'] ?? '');
    const resumed = await outcome(o.reevaluate['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: base }, ami, interruptedAt: 5 }).ctx);
    assert.equal(resumed.status, 'done', resumed.error ?? '');
    assert.deepEqual(resumed.result.files_written, []);
    assert.deepEqual(resumed.result.actions, ['Command: dialplan reload', 'Command: module reload res_pjsip.so', 'QuectelReload', 'DongleReload']);
    // interrupted before anything was written: the file still has the base hash
    const h2 = home();
    const ami2 = new FakeAmi({ configDir: h2.paths.configDir });
    const o2 = createConfigOps({ paths: h2.paths, timing: TIMING });
    const fresh = await outcome(o2.reevaluate['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: h2.registryHash() }, ami: ami2, interruptedAt: 5 }).ctx);
    assert.equal(fresh.status, 'done', fresh.error ?? '');
    assert.deepEqual(fresh.result.files_written, ['aster.d/modems.conf']);
    assert.equal(load(h2.paths.registry).registry.modems[0]?.ring.length, 0);
    // someone else changed the registry meanwhile
    const other = h2.registry();
    other.modems[0].recipients = ['777'];
    writeFileSync(h2.paths.registry, stringify(other));
    const foreign = await outcome(o2.reevaluate['registry-apply'], context({ kind: 'registry-apply', params: { registry, base_hash: sha256('base') }, ami: ami2, interruptedAt: 5 }).ctx);
    assert.equal(foreign.status, 'uncertain');
    assert.match(String(foreign.error), /changed while the operation was interrupted/);
    assert.deepEqual(load(h2.paths.registry).registry.modems[0]?.recipients, ['777']);
  });
});

describe('apply: config-apply', () => {
  const EXT_OK = (/** @type {ReturnType<typeof home>} */ h) => `${h.read('extensions.conf')}\n[ok-ctx]\nexten => s,1,Hangup()\n`;

  test('hand-owned names only', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    for (const [name, pattern] of [['aster.d/modems.conf', /generated from aster\.yaml/], ['manager.conf', /written by install\.sh/], ['sip.conf', /not a hand-owned configuration file \(asterisk\.conf, /],
      ['../secrets.env', /not a hand-owned/], ['', /not a hand-owned/]]) {
      const out = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name, content: '' }, ami }).ctx);
      assert.equal(out.status, 'failed');
      assert.match(String(out.error), /** @type {RegExp} */ (pattern), String(name));
    }
    const noContent = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'rtp.conf' }, ami }).ctx);
    assert.match(String(noContent.error), /content must be a string/);
    assert.deepEqual(ami.calls, []);
  });

  test('changed on disk (base_hash ≠ current, no force) and lint problems refuse without writing; a restart file needs restart: true', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const current = h.read('extensions.conf');
    const stale = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'extensions.conf', content: EXT_OK(h), base_hash: sha256('older') }, ami }).ctx);
    assert.equal(stale.status, 'failed');
    assert.match(String(stale.error), /^extensions\.conf changed on disk since it was opened/);
    assert.equal(stale.result?.current_hash, sha256(current));
    const noHash = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'extensions.conf', content: EXT_OK(h) }, ami }).ctx);
    assert.equal(noHash.status, 'failed', 'an existing file needs its base_hash (or force)');
    const lint = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'extensions.conf', content: `${current}[broken\n`, base_hash: sha256(current) }, ami }).ctx);
    assert.equal(lint.status, 'failed');
    assert.match(String(lint.error), /^extensions\.conf has 1 lint problem; nothing was written$/);
    assert.match(String(lint.result?.problems?.[0]?.message), /Asterisk rejects the whole file/);
    const dropped = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'extensions.conf', content: current.replace('\n[smoke-in]\n', '\n[smoke-out]\n'), base_hash: sha256(current) }, ami }).ctx);
    assert.equal(dropped.status, 'failed');
    assert.deepEqual(dropped.result?.problems, [{ path: 'modems[2].incoming_context', message: 'context "smoke-in" is not defined in extensions.conf' },
      { path: 'phones[2].context', message: 'context "smoke-in" is not defined in extensions.conf' }]);
    const modules = h.read('modules.conf');
    const restart = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'modules.conf', content: `${modules}; note\n`, base_hash: sha256(modules) }, ami }).ctx);
    assert.equal(restart.status, 'failed');
    assert.match(String(restart.error), /confirm with restart: true$/);
    assert.equal(h.read('extensions.conf'), current);
    assert.equal(h.read('modules.conf'), modules);
    assert.deepEqual(ami.calls, []);
    assert.ok(!existsSync(h.paths.prevDir));
  });

  test('a good change: the current file goes to state/prev, the new one is written atomically, the mapped reload runs, the log is clean', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const current = h.read('extensions.conf');
    const content = EXT_OK(h);
    const { ctx, progress } = context({ kind: 'config-apply', params: { name: 'extensions.conf', content, base_hash: sha256(current) }, ami });
    const out = await outcome(o.handlers['config-apply'], ctx);
    assert.equal(out.status, 'done', out.error ?? '');
    assert.deepEqual(out.result, { name: 'extensions.conf', hash: sha256(content), previous_hash: sha256(current), actions: ['Command: dialplan reload'], restart: false, log: [], observed_at: out.result.observed_at });
    assert.equal(h.read('extensions.conf'), content);
    assert.equal(readPrev(h.paths.prevDir, 'extensions.conf')?.text, current);
    assert.deepEqual(ami.calls, ['Command: dialplan reload']);
    assert.deepEqual(progress, ['writing extensions.conf', 'Command: dialplan reload']);
    assert.ok(ami.contexts.has('ok-ctx'));
    // force skips the base_hash check
    const forced = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'extensions.conf', content: current, force: true }, ami }).ctx);
    assert.equal(forced.status, 'done', forced.error ?? '');
    assert.equal(readPrev(h.paths.prevDir, 'extensions.conf')?.text, content);
  });

  test('a relevant log line after the reload: the previous version comes back, the reload runs again, the operation fails with the lines', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const current = h.read('extensions.conf');
    const broken = `${current}\n[bad-ctx]\nexten => 100,1,NoOp()\nexten => 100,1,NoOp()\n`;
    const warning = "[2026-09-11 06:34:32] WARNING[86] pbx.c: Unable to register extension '100' priority 1 in 'bad-ctx', already in use";
    ami.onCommand = (cli) => {
      if (cli === 'dialplan reload' && h.read('extensions.conf') === broken) {
        h.logLine('[2026-09-11 06:34:33] ERROR[91] chan_quectel.c: [gsm1] Lost connection to Quectel');
        h.logLine(warning);
      }
      return undefined;
    };
    const out = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'extensions.conf', content: broken, base_hash: sha256(current) }, ami }).ctx);
    assert.equal(out.status, 'failed');
    assert.equal(out.error, 'extensions.conf was not applied: Asterisk logged 1 problem line(s); the previous version is back');
    assert.deepEqual(out.result?.log, [warning]);
    assert.equal(out.result?.restored, true);
    assert.equal(out.result?.hash, sha256(current));
    assert.deepEqual(out.result?.restore_log, []);
    assert.equal(h.read('extensions.conf'), current);
    assert.equal(readPrev(h.paths.prevDir, 'extensions.conf')?.text, current);
    assert.deepEqual(ami.calls, ['Command: dialplan reload', 'Command: dialplan reload']);
    assert.ok(!ami.contexts.has('bad-ctx'));
  });

  test('a reply problem (Response: Error, No such …) restores as well; a second failure is reported too', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const current = h.read('rtp.conf');
    let count = 0;
    ami.onCommand = (cli) => {
      if (cli !== 'module reload res_rtp_asterisk.so') return undefined;
      count += 1;
      if (count === 1) throw new AmiError("No such command 'module reload res_rtp_asterisk.so'", new Map());
      return ['Error: still broken'];
    };
    const out = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'rtp.conf', content: `${current}; more\n`, base_hash: sha256(current) }, ami }).ctx);
    assert.equal(out.status, 'failed');
    assert.equal(out.error, "rtp.conf was not applied: Command: module reload res_rtp_asterisk.so: No such command 'module reload res_rtp_asterisk.so'; the previous version is back, but Command: module reload res_rtp_asterisk.so: Error: still broken");
    assert.equal(h.read('rtp.conf'), current);
  });

  test('a file that did not exist is created without a previous copy and removed again on failure', async () => {
    const h = home();
    rmSync(join(h.paths.configDir, 'ccss.conf'));
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const noRestart = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'ccss.conf', content: '[general]\n' }, ami }).ctx);
    assert.match(String(noRestart.error), /confirm with restart: true/);
    ami.onCommand = (cli) => {
      if (cli === 'core restart gracefully') h.logLine('[2026-09-11 06:34:33] WARNING[1] ccss.c: something about ccss.conf');
      return undefined;
    };
    const out = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'ccss.conf', content: '[general]\n', restart: true }, ami }).ctx);
    assert.equal(out.status, 'failed');
    assert.match(String(out.error), /^ccss\.conf was not applied: Asterisk logged 1 problem line\(s\); the previous version is back/);
    assert.ok(!existsSync(join(h.paths.configDir, 'ccss.conf')));
    assert.equal(out.result?.hash, null);
    assert.equal(out.result?.restart, true);
    ami.onCommand = null;
    const ok = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'ccss.conf', content: '[general]\n', restart: true }, ami }).ctx);
    assert.equal(ok.status, 'done', ok.error ?? '');
    assert.deepEqual(ok.result.actions, ['Command: core restart gracefully']);
    assert.equal(ok.result.previous_hash, null);
    assert.ok(ami.connected);
  });

  test('a restart that does not come back within the deadline, an unreadable log, or a missing AMI connection', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami, { timing: { ...TIMING, restartTimeoutMs: 50 } });
    const modules = h.read('modules.conf');
    ami.onCommand = (cli) => {
      if (cli === 'core restart gracefully') {
        ami.up = false;
        throw new AmiDisconnected('closed');
      }
      return undefined;
    };
    const late = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'modules.conf', content: `${modules}; x\n`, base_hash: sha256(modules), restart: true }, ami }).ctx);
    assert.equal(late.status, 'failed');
    assert.match(String(late.error), /did not come back over AMI within 0 s of core restart gracefully; the previous version is back, but Asterisk did not come back over AMI within 0 s/);
    assert.equal(h.read('modules.conf'), modules);
    ami.up = true;
    ami.onCommand = null;
    rmSync(h.paths.asteriskLog);
    const current = h.read('rtp.conf');
    const noLog = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'rtp.conf', content: `${current}; x\n`, base_hash: sha256(current) }, ami }).ctx);
    assert.equal(noLog.status, 'uncertain');
    assert.match(String(noLog.error), /cannot be read, so the reload was not verified/);
    assert.equal(h.read('rtp.conf'), `${current}; x\n`, 'the file stays: the reload ran, only its verification is missing');
    const down = await outcome(o.handlers['config-apply'], context({ kind: 'config-apply', params: { name: 'rtp.conf', content: current, force: true }, ami: null }).ctx);
    assert.equal(down.status, 'failed');
    assert.match(String(down.error), /no AMI connection/);
    assert.equal(h.read('rtp.conf'), `${current}; x\n`);
  });

  test('re-evaluation: already written → reload and check only; still at the base → the whole apply; neither → uncertain', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const current = h.read('extensions.conf');
    const content = EXT_OK(h);
    const params = { name: 'extensions.conf', content, base_hash: sha256(current) };
    savePrev(h.paths.prevDir, 'extensions.conf', current);
    h.write('extensions.conf', content);
    const written = await outcome(o.reevaluate['config-apply'], context({ kind: 'config-apply', params, ami, interruptedAt: 5 }).ctx);
    assert.equal(written.status, 'done', written.error ?? '');
    assert.equal(written.result.previous_hash, sha256(current));
    assert.deepEqual(ami.calls, ['Command: dialplan reload']);
    h.write('extensions.conf', current);
    const fresh = await outcome(o.reevaluate['config-apply'], context({ kind: 'config-apply', params, ami, interruptedAt: 5 }).ctx);
    assert.equal(fresh.status, 'done', fresh.error ?? '');
    assert.equal(h.read('extensions.conf'), content);
    h.write('extensions.conf', `${current}; edited by hand\n`);
    const foreign = await outcome(o.reevaluate['config-apply'], context({ kind: 'config-apply', params, ami, interruptedAt: 5 }).ctx);
    assert.equal(foreign.status, 'uncertain');
    assert.match(String(foreign.error), /changed while the operation was interrupted/);
    assert.equal(h.read('extensions.conf'), `${current}; edited by hand\n`);
  });
});

describe('apply: config-restore', () => {
  test('swaps the previous version in, keeps the current one as the new previous, reloads and checks', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const current = h.read('rtp.conf');
    const older = `${current}; older\n`;
    savePrev(h.paths.prevDir, 'rtp.conf', older);
    const none = await outcome(o.handlers['config-restore'], context({ kind: 'config-restore', params: { name: 'cdr.conf' }, ami }).ctx);
    assert.match(String(none.error), /has no previous applied version/);
    const stale = await outcome(o.handlers['config-restore'], context({ kind: 'config-restore', params: { name: 'rtp.conf', base_hash: sha256('x') }, ami }).ctx);
    assert.match(String(stale.error), /changed on disk since it was opened/);
    const out = await outcome(o.handlers['config-restore'], context({ kind: 'config-restore', params: { name: 'rtp.conf', base_hash: sha256(current) }, ami }).ctx);
    assert.equal(out.status, 'done', out.error ?? '');
    assert.deepEqual(out.result, { name: 'rtp.conf', hash: sha256(older), previous_hash: sha256(current), actions: ['Command: module reload res_rtp_asterisk.so'], restart: false, log: [], observed_at: out.result.observed_at });
    assert.equal(h.read('rtp.conf'), older);
    assert.equal(readPrev(h.paths.prevDir, 'rtp.conf')?.text, current);
    assert.deepEqual(ami.calls, ['Command: module reload res_rtp_asterisk.so']);
    const missing = await outcome(o.handlers['config-restore'], context({ kind: 'config-restore', params: { name: 'stasis.conf' }, ami }).ctx);
    assert.match(String(missing.error), /stasis\.conf does not exist on disk|has no previous/);
  });

  test('a previous version that no longer lints, or a failing reload after the swap (no second swap)', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const current = h.read('extensions.conf');
    savePrev(h.paths.prevDir, 'extensions.conf', `${current}[oops\n`);
    const lint = await outcome(o.handlers['config-restore'], context({ kind: 'config-restore', params: { name: 'extensions.conf' }, ami }).ctx);
    assert.equal(lint.status, 'failed');
    assert.match(String(lint.error), /the previous extensions\.conf has 1 lint problem now; it was not restored/);
    assert.equal(h.read('extensions.conf'), current);
    const older = `${current}\n[older]\nexten => s,1,Hangup()\n`;
    savePrev(h.paths.prevDir, 'extensions.conf', older);
    ami.onCommand = (cli) => {
      if (cli === 'dialplan reload') h.logLine('[2026-09-11 06:34:32] WARNING[86] pbx_config.c: Unable to register extension at line 99 of extensions.conf');
      return undefined;
    };
    const out = await outcome(o.handlers['config-restore'], context({ kind: 'config-restore', params: { name: 'extensions.conf' }, ami }).ctx);
    assert.equal(out.status, 'failed');
    assert.match(String(out.error), /^the previous extensions\.conf is back on disk, but Asterisk logged 1 problem line\(s\)$/);
    assert.equal(h.read('extensions.conf'), older);
    assert.equal(readPrev(h.paths.prevDir, 'extensions.conf')?.text, current);
    assert.deepEqual(ami.calls, ['Command: dialplan reload']);
  });

  test('re-evaluation: a staged file finishes the swap; the swapped state (prev = base_hash) only reloads; otherwise uncertain', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const { ops: o } = ops(h, ami);
    const current = h.read('rtp.conf');
    const older = `${current}; older\n`;
    savePrev(h.paths.prevDir, 'rtp.conf', older);
    writeAtomic(stagedPath(h.paths.prevDir, 'rtp.conf'), current); // interrupted after step 1
    const staged = await outcome(o.reevaluate['config-restore'], context({ kind: 'config-restore', params: { name: 'rtp.conf', base_hash: sha256(current) }, ami, interruptedAt: 5 }).ctx);
    assert.equal(staged.status, 'done', staged.error ?? '');
    assert.equal(h.read('rtp.conf'), older);
    assert.equal(readPrev(h.paths.prevDir, 'rtp.conf')?.text, current);
    assert.deepEqual(ami.calls, ['Command: module reload res_rtp_asterisk.so']);
    ami.calls.length = 0;
    const swapped = await outcome(o.reevaluate['config-restore'], context({ kind: 'config-restore', params: { name: 'rtp.conf', base_hash: sha256(current) }, ami, interruptedAt: 5 }).ctx);
    assert.equal(swapped.status, 'done', swapped.error ?? '');
    assert.equal(h.read('rtp.conf'), older, 'not swapped back');
    assert.deepEqual(ami.calls, ['Command: module reload res_rtp_asterisk.so']);
    const unknown = await outcome(o.reevaluate['config-restore'], context({ kind: 'config-restore', params: { name: 'rtp.conf', base_hash: sha256('elsewhere') }, ami, interruptedAt: 5 }).ctx);
    assert.equal(unknown.status, 'uncertain');
    const noHash = await outcome(o.reevaluate['config-restore'], context({ kind: 'config-restore', params: { name: 'rtp.conf' }, ami, interruptedAt: 5 }).ctx);
    assert.equal(noHash.status, 'uncertain');
    assert.equal(h.read('rtp.conf'), older);
  });
});

describe('apply: log rotation', () => {
  test('checkLog rotates above the limit over AMI and prunes the rotated files beyond `keep` by modification time', async () => {
    const dir = join(tmp, 'rotate');
    mkdirSync(dir);
    const path = join(dir, 'full');
    writeFileSync(path, 'x'.repeat(100));
    const ami = new FakeAmi({ configDir: dir });
    ami.onCommand = (cli) => {
      if (cli !== 'logger rotate') return undefined;
      const n = fs.readdirSync(dir).filter((f) => f.startsWith('full.')).length;
      fs.renameSync(path, join(dir, `full.${n}`));
      writeFileSync(path, '');
      return [''];
    };
    assert.deepEqual(await checkLog({ ami: /** @type {AmiClient} */ (/** @type {unknown} */ (ami)), path, maxBytes: 100, keep: 2 }), { size: 100, rotated: false, removed: [], skipped: null });
    writeFileSync(path, 'x'.repeat(101));
    assert.deepEqual(await checkLog({ ami: /** @type {AmiClient} */ (/** @type {unknown} */ (ami)), path, maxBytes: 100, keep: 2 }), { size: 101, rotated: true, removed: [], skipped: null });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['full', 'full.0']);
    // older rotated files with a lower mtime than a reused low number: pruning goes by mtime, not by number
    for (const [name, age] of [['full.7', 3000], ['full.8', 2000], ['full.9', 1000]]) {
      writeFileSync(join(dir, String(name)), 'old');
      const t = Date.now() / 1000 - Number(age);
      utimesSync(join(dir, String(name)), t, t);
    }
    writeFileSync(join(dir, 'queue_log.0'), 'not ours');
    assert.deepEqual(rotatedFiles(path).map((f) => f.name), ['full.0', 'full.9', 'full.8', 'full.7']);
    assert.deepEqual(pruneRotated(path, 2), ['full.8', 'full.7']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['full', 'full.0', 'full.9', 'queue_log.0']);
    ami.up = false;
    writeFileSync(path, 'x'.repeat(101));
    const skipped = await checkLog({ ami: /** @type {AmiClient} */ (/** @type {unknown} */ (ami)), path, maxBytes: 100, keep: 2 });
    assert.equal(skipped.rotated, false);
    assert.match(String(skipped.skipped), /not connected over AMI/);
    const missing = await checkLog({ ami: null, path: join(dir, 'nope'), maxBytes: 100, keep: 2 });
    assert.match(String(missing.skipped), /^cannot stat /);
  });

  test('startLogRotation checks on its timer and logs a skipped reason once', async () => {
    const dir = join(tmp, 'rotate-timer');
    mkdirSync(dir);
    /** @type {Array<[string, string, Record<string, unknown> | undefined]>} */
    const logged = [];
    /** @type {import('../src/log.js').Logger} */
    const log = { debug() {}, info: (m, f) => void logged.push(['info', m, f]), warn: (m, f) => void logged.push(['warn', m, f]), error: (m, f) => void logged.push(['error', m, f]), child() { return log; } };
    const rotation = startLogRotation({ ami: null, path: join(dir, 'full'), log, intervalMs: 15, maxBytes: 10, keep: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    rotation.stop();
    assert.equal(logged.filter(([level]) => level === 'warn').length, 1, JSON.stringify(logged));
    assert.match(String(logged[0]?.[2]?.reason), /cannot stat/);
    const direct = await rotation.check();
    assert.match(String(direct.skipped), /cannot stat/);
  });
});

describe('apply: through the operations runner', () => {
  test('the three kinds run under the global lock; an operation interrupted by a restart is re-evaluated by its reevaluate function', async () => {
    const h = home();
    const ami = new FakeAmi({ configDir: h.paths.configDir });
    const dbPath = join(h.root, 'aster.db');
    const db = open(dbPath);
    migrate(db);
    const bus = createBus();
    /** @type {string[]} */
    const statuses = [];
    bus.subscribe((event) => {
      if (event.type === 'op.progress' && event.payload.message === null) statuses.push(`${event.payload.kind}:${event.payload.status}`);
    });
    const runner = createRunner({ db, ami: /** @type {AmiClient} */ (/** @type {unknown} */ (ami)), bus });
    const o = createConfigOps({ paths: h.paths, timing: TIMING });
    o.register(runner);
    runner.start();
    const current = h.read('rtp.conf');
    const apply = runner.enqueue({ kind: 'config-apply', modemId: null, params: { name: 'rtp.conf', content: `${current}; v2\n`, base_hash: sha256(current) }, actor: 'admin' });
    const restore = runner.enqueue({ kind: 'config-restore', modemId: null, params: { name: 'rtp.conf', base_hash: sha256(`${current}; v2\n`) }, actor: 'admin' });
    const registry = runner.enqueue({ kind: 'registry-apply', modemId: null, params: { registry: h.registry(), base_hash: h.registryHash() }, actor: 'admin' });
    const [a, r, g] = await Promise.all([runner.wait(apply), runner.wait(restore), runner.wait(registry)]);
    assert.equal(a.status, 'done', a.error ?? '');
    assert.equal(r.status, 'done', r.error ?? '');
    assert.equal(g.status, 'done', g.error ?? '');
    assert.equal(h.read('rtp.conf'), current);
    assert.equal(readPrev(h.paths.prevDir, 'rtp.conf')?.text, `${current}; v2\n`);
    assert.deepEqual(statuses, ['config-apply:queued', 'config-restore:queued', 'registry-apply:queued', 'config-apply:running', 'config-apply:done',
      'config-restore:running', 'config-restore:done', 'registry-apply:running', 'registry-apply:done']);
    await runner.stop();
    // a restart mid-apply: the row is still running when the next controller starts
    db.prepare("INSERT INTO operations (kind, modem_id, status, params_json, actor, created_at, started_at) VALUES ('config-apply', NULL, 'running', ?, 'admin', 1, 2)")
      .run(JSON.stringify({ name: 'rtp.conf', content: `${current}; v3\n`, base_hash: sha256(current) }));
    h.write('rtp.conf', `${current}; v3\n`); // written before the crash
    savePrev(h.paths.prevDir, 'rtp.conf', current);
    db.close();
    const db2 = open(dbPath);
    const runner2 = createRunner({ db: db2, ami: /** @type {AmiClient} */ (/** @type {unknown} */ (ami)), bus });
    createConfigOps({ paths: h.paths, timing: TIMING }).register(runner2);
    ami.calls.length = 0;
    const summary = runner2.start();
    assert.deepEqual(summary, { interrupted: 1, reevaluating: 1, uncertain: 0, queued: 0, unknownKind: 0 });
    const row = db2.prepare("SELECT id FROM operations WHERE status = 'running' OR status = 'interrupted' ORDER BY id DESC").get();
    const re = await runner2.wait(Number(row?.id));
    assert.equal(re.status, 'done', re.error ?? '');
    assert.ok(Number.isSafeInteger(re.result?.interrupted_at));
    assert.deepEqual(ami.calls, ['Command: module reload res_rtp_asterisk.so']);
    assert.equal(h.read('rtp.conf'), `${current}; v3\n`);
    await runner2.stop();
    db2.close();
  });
});
