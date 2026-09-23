// @ts-check
// Tests for src/reconcile.js: the desired-state rule, afterRegistryApply with a scripted driver AMI, and the whole path
// through registry-apply on a copy of docker/asterisk/test-config.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { createConfigOps } from '../src/config/apply.js';
import { load, parse, validate } from '../src/config/registry.js';
import { createRunner } from '../src/ops/runner.js';
import { createReconciler, desiredRadio, desiredState, modemsToVerify } from '../src/reconcile.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi } from './devices-fake.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_CONFIG = join(REPO, 'docker/asterisk/test-config');
const TEST_REGISTRY = join(REPO, 'docker/asterisk/test-registry.yaml');
const tmp = mkdtempSync(join(tmpdir(), 'aster-reconcile-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

/** @param {Record<string, unknown>[]} modems */
const registry = (modems) => validate({ version: 1, modems, phones: [] });
const ctx = /** @type {any} */ ({ progress() {}, op: { id: 1, kind: 'registry-apply', modemId: null, params: null, actor: 'admin', createdAt: 0, interruptedAt: null } });
const TIMING = { actionTimeoutMs: 500, deviceTimeoutMs: 60, devicePollMs: 5 };

describe('devices reconcile', () => {
  test('desiredState and desiredRadio follow the generated initstate and radio; modemsToVerify picks added modems and changed enabled/uac/usb_port mappings', () => {
    const on = registry([{ id: 'a', driver: 'quectel', imei: '000000000000001', enabled: true }]);
    assert.equal(desiredState(/** @type {any} */ (on.modems[0])), 'start');
    const off = registry([{ id: 'a', driver: 'quectel', imei: '000000000000001', enabled: false }]);
    assert.equal(desiredState(/** @type {any} */ (off.modems[0])), 'start', 'a disabled modem is started with its radio off');
    assert.equal(desiredRadio(/** @type {any} */ (off.modems[0])), 'off');
    assert.equal(desiredRadio(/** @type {any} */ (on.modems[0])), 'on');
    assert.equal(desiredState(/** @type {any} */ (registry([{ id: 'a', driver: 'quectel', imei: '000000000000001', enabled: false, uac: true }]).modems[0])), 'start', 'disabled and unmapped');
    assert.equal(desiredState(/** @type {any} */ (registry([{ id: 'a', driver: 'quectel', imei: '000000000000001', enabled: true, uac: true }]).modems[0])), 'stop', 'unmapped');
    const before = registry([{ id: 'a', driver: 'quectel', imei: '000000000000001', enabled: true }, { id: 'b', driver: 'dongle', imei: '000000000000002', enabled: true }, { id: 'c', driver: 'quectel', imei: '000000000000003', enabled: true, uac: true }]);
    const after = registry([
      { id: 'a', driver: 'quectel', imei: '000000000000001', enabled: true, recipients: ['123456'] },
      { id: 'b', driver: 'dongle', imei: '000000000000002', enabled: false },
      { id: 'c', driver: 'quectel', imei: '000000000000003', enabled: true, uac: true, usb_port: '1-2' },
      { id: 'd', driver: 'dongle', imei: '000000000000004', enabled: true },
    ]);
    assert.deepEqual(modemsToVerify(before, after).map((m) => m.id), ['b', 'c', 'd']);
    assert.deepEqual(modemsToVerify(null, after).map((m) => m.id), ['a', 'b', 'c', 'd']);
  });

  test('a removed modem the driver still lists gets Remove and must disappear; one already gone needs nothing; a busy one is an error after the deadline', async () => {
    const ami = new FakeDriverAmi();
    ami.addDevice('old', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
    ami.addDevice('keep', 'quectel', { state: 'Free', current: 'start', desired: 'start' });
    const reconciler = createReconciler({ timing: TIMING });
    const before = registry([{ id: 'old', driver: 'dongle', imei: '000000000000001', enabled: true }, { id: 'gone', driver: 'quectel', imei: '000000000000002', enabled: true }, { id: 'keep', driver: 'quectel', imei: '000000000000003', enabled: true }]);
    const after = registry([{ id: 'keep', driver: 'quectel', imei: '000000000000003', enabled: true }]);
    const result = await reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before, after });
    assert.deepEqual(result, { removed: [{ id: 'old', driver: 'dongle', action: 'Remove' }, { id: 'gone', driver: 'quectel', action: null }], desired: {}, radio: {} });
    assert.deepEqual(ami.calls, ['DongleShowDevices old', 'DongleRemove old gracefully', 'DongleShowDevices old', 'QuectelShowDevices gone']);
    assert.equal(ami.devices.has('old'), false);
    ami.addDevice('busy', 'dongle', { state: 'Active', current: 'start', desired: 'start', calls: 1 });
    await assert.rejects(reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before: registry([{ id: 'busy', driver: 'dongle', imei: '000000000000009', enabled: true }]), after }),
      /chan_dongle still lists the removed modem busy 0 s after DongleRemove \(a graceful removal waits for calls to end\)/);
    assert.equal(/** @type {any} */ (ami.devices.get('busy')).desired, 'remove');
  });

  test('desired states and radio settings: confirmed for checked modems; a mismatch of either, an unreported radio, an unlisted modem and a failing driver list are errors naming the device', async () => {
    const ami = new FakeDriverAmi();
    ami.addDevice('a', 'quectel', { desired: 'start', state: 'Not connected', radio: 'on' });
    ami.addDevice('b', 'dongle', { desired: 'start', current: 'start', state: 'Radio off', radio: 'off' });
    const reconciler = createReconciler({ timing: TIMING });
    const before = registry([{ id: 'a', driver: 'quectel', imei: '000000000000001', enabled: false }, { id: 'b', driver: 'dongle', imei: '000000000000002', enabled: true }]);
    const after = registry([{ id: 'a', driver: 'quectel', imei: '000000000000001', enabled: true }, { id: 'b', driver: 'dongle', imei: '000000000000002', enabled: false }]);
    assert.deepEqual(await reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before, after }), { removed: [], desired: { a: 'start', b: 'start' }, radio: { a: 'on', b: 'off' } });
    const b = /** @type {any} */ (ami.devices.get('b'));
    b.desired = 'stop';
    await assert.rejects(reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before, after }), /desired state of the registry after 0 s: b: desired stop, expected start/);
    b.desired = 'start';
    b.radio = 'on';
    await assert.rejects(reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before, after }), /desired state of the registry after 0 s: b: radio on, expected off/);
    b.radio = null;
    await assert.rejects(reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before, after }), /b: radio not reported \(Asterisk without the radio patches\), expected off/);
    b.radio = 'off';
    const withNew = registry([...after.modems.map((m) => ({ ...m })), { id: 'c', driver: 'quectel', imei: '000000000000003', enabled: true }]);
    await assert.rejects(reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before, after: withNew }), /c: desired unlisted, expected start/);
    const { AmiError } = await import('../src/ami/client.js');
    ami.onList = (name) => {
      if (name === 'QuectelShowDevices') throw new AmiError('Invalid/unknown command', new Map([['Response', 'Error']]));
      return undefined;
    };
    await assert.rejects(reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before, after }), /a: desired unknown \(Invalid\/unknown command\), expected start/);
    // nothing to check when nothing relevant changed
    ami.calls.length = 0;
    assert.deepEqual(await reconciler.afterRegistryApply(ctx, { ami: /** @type {any} */ (ami), before: after, after }), { removed: [], desired: {}, radio: {} });
    assert.deepEqual(ami.calls, []);
  });

  test('through registry-apply on test-config: toggling enabled reloads the driver once and the result carries the reconciled desired state and radio; a driver without the radio patches fails the apply', async () => {
    const root = join(tmp, `apply-${++counter}`);
    const configDir = join(root, 'config', 'asterisk');
    cpSync(TEST_CONFIG, configDir, { recursive: true });
    const registryPath = join(root, 'config', 'aster.yaml');
    writeFileSync(registryPath, readFileSync(TEST_REGISTRY));
    mkdirSync(join(root, 'logs', 'asterisk'), { recursive: true });
    const asteriskLog = join(root, 'logs', 'asterisk', 'full');
    writeFileSync(asteriskLog, '[2026-09-11 08:00:00] NOTICE[1] loader.c: 73 modules will be loaded.\n');
    const paths = { configDir, registry: registryPath, prevDir: join(root, 'state', 'prev'), asteriskLog };
    const ami = new FakeDriverAmi({ configDir });
    const db = open(join(root, 'apply.db'));
    migrate(db);
    const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
    const reconciler = createReconciler({ timing: TIMING });
    createConfigOps({ paths, timing: { settleMs: 0, actionTimeoutMs: 500, deviceTimeoutMs: 200, devicePollMs: 10, restartTimeoutMs: 500 }, hooks: { applied: reconciler.afterRegistryApply } }).register(runner);
    runner.start();
    try {
      const gsmTest = () => /** @type {any} */ (ami.devices.get('gsm_test'));
      assert.deepEqual([gsmTest().desired, gsmTest().radio, gsmTest().state], ['start', 'off', 'Radio off'], 'a disabled modem is started with its radio off');
      const reg = /** @type {any} */ (structuredClone(parse(readFileSync(TEST_REGISTRY, 'utf8'))));
      reg.modems[0].enabled = true;
      ami.calls.length = 0;
      let op = await runner.wait(runner.enqueue({ kind: 'registry-apply', modemId: null, params: { registry: reg, base_hash: load(registryPath).hash }, actor: 'admin' }));
      assert.equal(op.status, 'done', op.error ?? '');
      const result = /** @type {any} */ (op.result);
      assert.deepEqual(result.files_written, ['aster.d/quectel-devices.conf']);
      assert.deepEqual(result.actions, ['QuectelReload']);
      assert.equal(ami.calls.filter((c) => c.startsWith('QuectelReload')).length, 1);
      assert.deepEqual(result.reconcile, { removed: [], desired: { gsm_test: 'start' }, radio: { gsm_test: 'on' } });
      assert.deepEqual([gsmTest().desired, gsmTest().radio, gsmTest().state], ['start', 'on', 'Free'], 'the radio change restarted it');
      // a driver without the radio patches ignores the change: the apply fails after the files were written
      ami.ignoreRadio = true;
      reg.modems[0].enabled = false;
      op = await runner.wait(runner.enqueue({ kind: 'registry-apply', modemId: null, params: { registry: reg, base_hash: load(registryPath).hash }, actor: 'admin' }));
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /the files were written and reloaded, but the drivers do not show the desired state of the registry after 0 s: gsm_test: radio on, expected off/);
      assert.match(readFileSync(join(configDir, 'aster.d/quectel-devices.conf'), 'utf8'), /\[gsm_test\][^[]*initstate = start\nradio = off/);
      // removing a modem: the reload drops it, so nothing is sent
      ami.ignoreRadio = false;
      reg.modems = reg.modems.filter((/** @type {any} */ m) => m.id !== 'gsm_dongle');
      ami.calls.length = 0;
      op = await runner.wait(runner.enqueue({ kind: 'registry-apply', modemId: null, params: { registry: reg, base_hash: load(registryPath).hash }, actor: 'admin' }));
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(/** @type {any} */ (op.result).reconcile, { removed: [{ id: 'gsm_dongle', driver: 'dongle', action: null }], desired: {}, radio: {} });
      assert.ok(!ami.calls.some((c) => c.startsWith('DongleRemove')));
    } finally {
      await runner.stop();
      db.close();
    }
  });
});
