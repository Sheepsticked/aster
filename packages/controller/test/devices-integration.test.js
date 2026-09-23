// @ts-check
// Integration test for src/devices/ and src/reconcile.js against a real Asterisk (setup as in apply-integration.test.js; do
// not run both at once); skipped unless ASTER_AMI_TEST=1. The container has no modems, so sysfs is an empty fake tree.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AmiClient } from '../src/ami/client.js';
import { createBus } from '../src/bus.js';
import { createConfigOps } from '../src/config/apply.js';
import { GENERATED_FILES } from '../src/config/generators.js';
import { load, parse } from '../src/config/registry.js';
import { createLifecycleOps } from '../src/devices/lifecycle.js';
import { createRemapOps } from '../src/devices/remap.js';
import { createScanOps } from '../src/devices/scan.js';
import { createDeviceState, showDevices } from '../src/devices/state.js';
import { createRunner } from '../src/ops/runner.js';
import { createReconciler } from '../src/reconcile.js';
import { migrate, open } from '../src/store/db.js';
import { makeSysfs } from './sysfs-fake.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_CONFIG = join(REPO, 'docker/asterisk/test-config');
const TEST_REGISTRY = join(REPO, 'docker/asterisk/test-registry.yaml');
const enabled = process.env.ASTER_AMI_TEST === '1' && Boolean(process.env.ASTER_APPLY_HOME);
const host = process.env.ASTER_AMI_HOST ?? '127.0.0.1';
const port = Number(process.env.ASTER_AMI_PORT ?? '5038');
const CONNECT_WITHIN_MS = 30_000;
/** Real Asterisk timing; generous for arm64 under QEMU. */
const APPLY_TIMING = { settleMs: 1_500, actionTimeoutMs: 30_000, deviceTimeoutMs: 60_000, devicePollMs: 1_000, restartTimeoutMs: 300_000 };
const LIFECYCLE_TIMING = { actionTimeoutMs: 30_000, confirmTimeoutMs: 60_000, pollMs: 1_000 };

describe('devices integration', { skip: !enabled && 'set ASTER_AMI_TEST=1 and ASTER_APPLY_HOME with the writable test-config container running (see the file header)' }, () => {
  const home = String(process.env.ASTER_APPLY_HOME);
  const configDir = join(home, 'config', 'asterisk');
  const paths = { configDir, registry: join(home, 'config', 'aster.yaml'), prevDir: join(home, 'state', 'prev'), asteriskLog: join(home, 'logs', 'asterisk', 'full') };
  const tmp = mkdtempSync(join(tmpdir(), 'aster-devint-'));
  const sysfsRoot = makeSysfs(join(tmp, 'sys'), { devices: [] });
  /** @type {AmiClient} */
  let client;
  /** the names of every action sent, in order @type {string[]} */
  const sent = [];
  /** @type {import('node:sqlite').DatabaseSync} */
  let db;
  /** @type {import('../src/ops/runner.js').Runner} */
  let runner;
  /** @type {ReturnType<typeof createDeviceState>} */
  let devices;
  /** @type {any[]} */
  const events = [];
  /** @param {string} name */
  const read = (name) => readFileSync(join(configDir, name), 'utf8');
  /** @param {string} name */
  const original = (name) => readFileSync(join(TEST_CONFIG, name), 'utf8');
  /**
   * @param {string} kind
   * @param {string | null} modemId
   * @param {Record<string, unknown>} params
   */
  const run = (kind, modemId, params = {}) => runner.wait(runner.enqueue({ kind, modemId, params, actor: 'admin' }));
  const registryFile = () => /** @type {any} */ (structuredClone(load(paths.registry).registry));
  /** @param {string} device */
  const entryOf = async (device) => (await showDevices(client, 'quectel', { device }))[0] ?? null;

  before(async () => {
    assert.ok(existsSync(join(configDir, 'extensions.conf')), `${configDir} must hold the container's configuration`);
    for (const name of GENERATED_FILES) assert.equal(read(name), original(name), `${name} must start as in test-config`);
    client = new AmiClient({ backoffMinMs: 200, backoffMaxMs: 2_000 });
    const action = client.action.bind(client);
    client.action = (name, headers, options) => {
      sent.push(name === 'Command' ? `Command: ${String(headers?.Command)}` : name);
      return action(name, headers, options);
    };
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no AMI login at ${host}:${port} within ${CONNECT_WITHIN_MS} ms: ${client.lastError?.message ?? 'no answer'}`)), CONNECT_WITHIN_MS);
    });
    try {
      await Promise.race([client.connect({ host, port, username: 'aster', secret: 'test' }), deadline]);
    } finally {
      clearTimeout(timer);
    }
    mkdirSync(join(home, 'state'), { recursive: true });
    rmSync(paths.prevDir, { recursive: true, force: true });
    writeFileSync(paths.registry, readFileSync(TEST_REGISTRY));
    db = open(join(home, 'state', 'devices-integration.db'));
    migrate(db);
    const bus = createBus();
    bus.subscribe((event) => {
      if (event.type === 'modem.state') events.push(event.payload);
    });
    runner = createRunner({ db, ami: client, bus });
    const registry = () => load(paths.registry).registry;
    const configOps = createConfigOps({ paths, timing: APPLY_TIMING, hooks: { applied: createReconciler({ timing: { actionTimeoutMs: 30_000, deviceTimeoutMs: 60_000, devicePollMs: 1_000 } }).afterRegistryApply } });
    configOps.register(runner);
    createLifecycleOps({ registry, timing: LIFECYCLE_TIMING }).register(runner);
    createScanOps({ db, registry, sysfsRoot, ami: client }).register(runner);
    createRemapOps({ paths: { registry: paths.registry }, apply: configOps.apply, sysfsRoot, timing: { actionTimeoutMs: 30_000, discoveryTimeoutMs: 120_000, confirmTimeoutMs: 60_000, pollMs: 1_000 } }).register(runner);
    devices = createDeviceState({ db, ami: client, bus, registry, sysfsRoot, timing: { actionTimeoutMs: 30_000 } });
    runner.start();
  });

  after(async () => {
    try {
      for (const name of GENERATED_FILES) writeFileSync(join(configDir, name), original(name));
      if (client.connected) {
        await client.action('QuectelReload', { When: 'gracefully' });
        await client.action('DongleReload', { When: 'gracefully' });
      }
    } finally {
      await runner?.stop();
      db?.close();
      await client?.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('registry enabled toggle: one QuectelReload, ShowDevices shows RadioSetting on, the reconciler confirms it', { timeout: 180_000 }, async () => {
    const registry = registryFile();
    registry.modems.find((/** @type {any} */ m) => m.id === 'gsm_test').enabled = true;
    const before = sent.length;
    const op = await run('registry-apply', null, { registry, base_hash: load(paths.registry).hash });
    assert.equal(op.status, 'done', op.error ?? '');
    const result = /** @type {Record<string, any>} */ (op.result);
    assert.deepEqual(result.files_written, ['aster.d/quectel-devices.conf']);
    assert.deepEqual(result.actions, ['QuectelReload']);
    assert.deepEqual(result.reconcile, { removed: [], desired: { gsm_test: 'start' }, radio: { gsm_test: 'on' } });
    assert.equal(sent.slice(before).filter((name) => name === 'QuectelReload').length, 1, 'exactly one Reload');
    const entry = await entryOf('gsm_test');
    assert.ok(entry);
    assert.equal(entry.desired, 'start');
    assert.equal(entry.radio, 'on');
    assert.equal(entry.state, 'Not connected', 'a device with only an IMEI and no port never connects in the container');
    assert.equal(entry.current, 'stop');
  });

  test('state refresh on the real lists: rows and states for every registry modem, no USB device to place, one bus event each', { timeout: 60_000 }, async () => {
    devices.pollSysfs();
    const result = await devices.refresh();
    assert.equal(result.skipped, null);
    assert.deepEqual(result.errors, { quectel: null, dongle: null });
    assert.equal(result.modems, 5);
    assert.equal(result.listed, 5);
    const rows = [...devices.states().values()].map(({ modem_id, state, driver_state, usb_port, data_tty }) => ({ modem_id, state, driver_state, usb_port, data_tty }))
      .sort((a, b) => a.modem_id.localeCompare(b.modem_id));
    assert.deepEqual(rows, [
      { modem_id: 'gsm_dongle', state: 'disabled', driver_state: 'Not connected', usb_port: null, data_tty: null },
      { modem_id: 'gsm_ports', state: 'disabled', driver_state: 'Not connected', usb_port: null, data_tty: '/dev/ttyUSB9' },
      { modem_id: 'gsm_test', state: 'connecting', driver_state: 'Not connected', usb_port: null, data_tty: null },
      { modem_id: 'gsm_uac', state: 'disabled', driver_state: 'Not connected', usb_port: null, data_tty: null },
      { modem_id: 'gsm_unmapped', state: 'unmapped', driver_state: 'Stopped', usb_port: null, data_tty: null },
    ]);
    assert.equal(devices.states().get('gsm_test')?.detail.desired, 'start');
    assert.deepEqual(devices.seen(), [], 'no tty could be placed');
    assert.deepEqual(events.map((e) => e.modem_id).sort(), ['gsm_dongle', 'gsm_ports', 'gsm_test', 'gsm_uac', 'gsm_unmapped']);
    assert.deepEqual((await devices.refresh()).published, [], 'nothing changed');
  });

  test('registry enabled toggle back: RadioSetting off, the device stays started (no port to connect to), the row disabled', { timeout: 180_000 }, async () => {
    const registry = registryFile();
    registry.modems.find((/** @type {any} */ m) => m.id === 'gsm_test').enabled = false;
    const op = await run('registry-apply', null, { registry, base_hash: load(paths.registry).hash });
    assert.equal(op.status, 'done', op.error ?? '');
    assert.deepEqual(/** @type {any} */ (op.result).reconcile, { removed: [], desired: { gsm_test: 'start' }, radio: { gsm_test: 'off' } });
    const entry = await entryOf('gsm_test');
    assert.deepEqual([entry?.state, entry?.desired, entry?.radio], ['Not connected', 'start', 'off']);
    await devices.refresh();
    assert.equal(devices.states().get('gsm_test')?.state, 'disabled');
    assert.equal(read('aster.d/quectel-devices.conf'), original('aster.d/quectel-devices.conf'));
  });

  test('scan: both discovery commands answer from the container and parse to an empty list; the result is stored', { timeout: 180_000 }, async () => {
    const before = sent.length;
    const op = await run('scan', null, {});
    assert.equal(op.status, 'done', op.error ?? '');
    const result = /** @type {Record<string, any>} */ (op.result);
    assert.deepEqual(sent.slice(before), ['Command: quectel discovery', 'Command: dongle discovery']);
    assert.deepEqual([result.devices, result.unassigned, result.errors, result.trigger], [[], [], { quectel: null, dongle: null }, 'manual']);
    assert.equal(typeof result.observed_at, 'number');
    const stored = JSON.parse(/** @type {any} */ (db.prepare("SELECT value FROM settings WHERE key = 'scan_latest'").get()).value);
    assert.deepEqual(stored.devices, []);
    // what the CLI printed, as the parser saw it
    const lines = await client.command('quectel discovery');
    assert.deepEqual(lines, [''], 'no modem: the command prints nothing');
  });

  test('lifecycle on the test device (started with its radio off, no port to connect to): start, restart, reset refused, stop, restart refused when stopped, remove and reload', { timeout: 300_000 }, async () => {
    let op = await run('modem-start', 'gsm_test', {});
    assert.equal(op.status, 'done', op.error ?? '');
    let result = /** @type {Record<string, any>} */ (op.result);
    assert.deepEqual([result.reply, result.state, result.current, result.desired, result.confirmed], ['[gsm_test] Start scheduled', 'Not connected', 'stop', 'start', true]);
    op = await run('modem-restart', 'gsm_test', {});
    assert.equal(op.status, 'done', op.error ?? '');
    result = /** @type {Record<string, any>} */ (op.result);
    assert.deepEqual([result.reply, result.desired, result.state], ['[gsm_test] Restart scheduled', 'start', 'Not connected']);
    op = await run('modem-reset', 'gsm_test', {});
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /QuectelReset gsm_test: \[gsm_test\] Device disconnected/);
    op = await run('modem-stop', 'gsm_test', { when: 'gracefully' });
    assert.equal(op.status, 'done', op.error ?? '');
    result = /** @type {Record<string, any>} */ (op.result);
    assert.deepEqual([result.reply, result.state, result.current, result.desired], ['[gsm_test] Stop scheduled', 'Stopped', 'stop', 'stop']);
    op = await run('modem-restart', 'gsm_test', {});
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /gsm_test is stopped; a Restart would start it — use start instead/);
    op = await run('modem-stop', 'nosuch', { driver: 'quectel' });
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /QuectelStop nosuch: \[nosuch\] Device not found/);
    op = await run('modem-remove', 'gsm_test', {});
    assert.equal(op.status, 'done', op.error ?? '');
    assert.equal(await entryOf('gsm_test'), null);
    // the device file still lists it: a reload brings it back, started with its radio off (no port here, so Not connected)
    await client.action('QuectelReload', { When: 'gracefully' });
    const deadline = Date.now() + 60_000;
    while ((await entryOf('gsm_test')) === null) {
      assert.ok(Date.now() < deadline, 'gsm_test listed again after the reload');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.deepEqual([(await entryOf('gsm_test'))?.state, (await entryOf('gsm_test'))?.radio], ['Not connected', 'off']);
  });

  test('remap of a modem no driver can find: discovery runs and the operation fails with the modem absent', { timeout: 300_000 }, async () => {
    const before = sent.length;
    const hashBefore = load(paths.registry).hash;
    const op = await run('remap', 'gsm_test', { reason: 'test' });
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /gsm_test \(IMEI 000000000000000\) was not found on any USB port and no free 2c7c device answered quectel discovery; the modem is absent/);
    const result = /** @type {Record<string, any>} */ (op.result);
    // the disabled gsm_test is started (radio off): remap stops it for discovery and starts it again although the modem is absent
    assert.deepEqual([result.found, result.stopped, result.restarted, result.candidates, result.apply], [false, true, true, [], null]);
    assert.deepEqual(sent.slice(before), ['QuectelStop', 'Command: quectel discovery', 'QuectelStart'], 'the ShowDevices list action is not an action() call');
    assert.equal(load(paths.registry).hash, hashBefore, 'the registry is untouched');
  });

  test('the end: every generated file is back to test-config', () => {
    for (const name of GENERATED_FILES) assert.equal(read(name), original(name), name);
    assert.deepEqual(parse(readFileSync(paths.registry, 'utf8')).modems.map((m) => m.id), ['gsm_test', 'gsm_dongle', 'gsm_uac', 'gsm_unmapped', 'gsm_ports']);
  });
});
