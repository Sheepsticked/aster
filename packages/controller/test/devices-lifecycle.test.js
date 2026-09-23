// @ts-check
// Tests for src/devices/lifecycle.js: the confirmation rules and the five device operations through a real runner with a
// scripted driver AMI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { confirmed, createLifecycleOps, KINDS } from '../src/devices/lifecycle.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi } from './devices-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-devlife-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

const REGISTRY = validate({ version: 1, modems: [
  { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true },
  { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true },
], phones: [] });

/** @param {{ connected?: boolean, startState?: string }} [options] */
function harness({ connected = true, startState = 'Free' } = {}) {
  const db = open(join(tmp, `life-${++counter}.db`));
  migrate(db);
  const ami = new FakeDriverAmi({ connected, startState });
  ami.addDevice('gsm1', 'quectel', { state: 'Free', current: 'start', desired: 'start', dataTty: '/dev/ttyUSB5', imei: '490154203237518' });
  ami.addDevice('gsm2', 'dongle');
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
  createLifecycleOps({ registry: () => REGISTRY, timing: { actionTimeoutMs: 500, confirmTimeoutMs: 120, pollMs: 10 } }).register(runner);
  runner.start();
  /** @param {string} kind @param {string} modemId @param {Record<string, unknown>} [params] */
  const run = (kind, modemId, params = {}) => runner.wait(runner.enqueue({ kind, modemId, params, actor: 'admin' }));
  return { db, ami, runner, run, stop: async () => { await runner.stop(); db.close(); } };
}

/** @param {Partial<import('../src/devices/state.js').DeviceEntry>} fields */
const entry = (fields) => /** @type {import('../src/devices/state.js').DeviceEntry} */ ({ driver: 'quectel', device: 'x', state: 'Free', imei: null, imsi: null, dataTty: null, audio: null, gsmReg: '', rssi: null,
  provider: null, number: null, current: 'start', desired: 'start', imeiSetting: null, dataSetting: null, manufacturer: null, model: null, firmware: null, calls: 0, ...fields });

describe('devices lifecycle', () => {
  test('confirmed(): start needs desired start and a state other than Stopped, stop needs Stopped, restart needs desired back to start, remove needs the device gone, reset a Disconnect or Not connected', () => {
    assert.equal(confirmed('start', entry({ state: 'Not connected', current: 'stop', desired: 'start' }), false), true, 'a modem without a SIM never reaches current start');
    assert.equal(confirmed('start', entry({ state: 'Stopped', current: 'stop', desired: 'stop' }), false), false);
    assert.equal(confirmed('start', entry({ state: 'Stopped', current: 'stop', desired: 'start' }), false), false, 'scheduled but not yet acted on');
    assert.equal(confirmed('start', null, false), false);
    assert.equal(confirmed('stop', entry({ state: 'Stopped', current: 'stop', desired: 'stop' }), false), true);
    assert.equal(confirmed('stop', entry({ state: 'Free', desired: 'stop' }), false), false, 'a graceful stop still waiting');
    assert.equal(confirmed('restart', entry({ desired: 'restart' }), false), false);
    assert.equal(confirmed('restart', entry({ desired: 'start' }), false), true);
    assert.equal(confirmed('remove', null, false), true);
    assert.equal(confirmed('remove', entry({}), false), false);
    assert.equal(confirmed('reset', entry({ state: 'Free' }), true), true);
    assert.equal(confirmed('reset', entry({ state: 'Not connected' }), false), true);
    assert.equal(confirmed('reset', entry({ state: 'Free' }), false), false);
    assert.equal(confirmed(/** @type {any} */ ('other'), entry({}), true), false);
    assert.deepEqual(KINDS, ['modem-start', 'modem-stop', 'modem-restart', 'modem-reset', 'modem-remove']);
  });

  test('modem-stop and modem-start: the driver actions with When gracefully, confirmed through ShowDevices, the results carry the reply and the state', async () => {
    const h = harness();
    try {
      let op = await h.run('modem-stop', 'gsm1');
      assert.equal(op.status, 'done', op.error ?? '');
      let result = /** @type {any} */ (op.result);
      assert.deepEqual([result.modem_id, result.driver, result.action, result.when, result.reply, result.confirmed, result.state, result.current, result.desired, result.events],
        ['gsm1', 'quectel', 'QuectelStop', 'gracefully', '[gsm1] Stop scheduled', true, 'Stopped', 'stop', 'stop', ['Disconnect']]);
      assert.equal(typeof result.observed_at, 'number');
      assert.deepEqual(h.ami.calls, ['QuectelStop gsm1 gracefully', 'QuectelShowDevices gsm1']);
      op = await h.run('modem-start', 'gsm1', { when: 'now' });
      assert.equal(op.status, 'done', op.error ?? '');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.reply, result.state, result.current, result.desired, result.events], ['[gsm1] Start scheduled', 'Free', 'start', 'start', ['Connect', 'Free']]);
      assert.equal(h.ami.calls.at(-2), 'QuectelStart gsm1 now');
      // the dongle kinds use the Dongle prefix
      op = await h.run('modem-start', 'gsm2');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(/** @type {any} */ (op.result).action, 'DongleStart');
    } finally {
      await h.stop();
    }
  });

  test('modem-start of a modem without a SIM is confirmed by DesiredDeviceState start although it never connects', async () => {
    const h = harness({ startState: 'Not connected' });
    try {
      await h.run('modem-stop', 'gsm1');
      const op = await h.run('modem-start', 'gsm1');
      assert.equal(op.status, 'done', op.error ?? '');
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.state, result.current, result.desired, result.confirmed], ['Not connected', 'stop', 'start', true]);
    } finally {
      await h.stop();
    }
  });

  test('modem-restart: a Disconnect and desired back to start; refused for a stopped device without sending anything', async () => {
    const h = harness();
    try {
      let op = await h.run('modem-restart', 'gsm1');
      assert.equal(op.status, 'done', op.error ?? '');
      let result = /** @type {any} */ (op.result);
      assert.deepEqual([result.reply, result.events, result.desired, result.state], ['[gsm1] Restart scheduled', ['Disconnect', 'Connect', 'Free'], 'start', 'Free']);
      assert.deepEqual(h.ami.calls.slice(0, 2), ['QuectelShowDevices gsm1', 'QuectelRestart gsm1 gracefully']);
      const before = h.ami.calls.length;
      op = await h.run('modem-restart', 'gsm2');
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /gsm2 is stopped; a Restart would start it — use start instead/);
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.state, result.desired, result.reply], ['Stopped', 'stop', null]);
      assert.deepEqual(h.ami.calls.slice(before), ['DongleShowDevices gsm2']);
    } finally {
      await h.stop();
    }
  });

  test('modem-reset: a connected device drops (Status Disconnect); a stopped one is refused by the driver', async () => {
    const h = harness();
    try {
      let op = await h.run('modem-reset', 'gsm1');
      assert.equal(op.status, 'done', op.error ?? '');
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.action, result.when, result.reply, result.events, result.state, result.current], ['QuectelReset', null, '[gsm1] Reset command queued for execute', ['Disconnect'], 'Not connected', 'stop']);
      assert.equal(h.ami.calls[0], 'QuectelReset gsm1');
      op = await h.run('modem-reset', 'gsm2');
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /DongleReset gsm2: \[gsm2\] Device disconnected/);
    } finally {
      await h.stop();
    }
  });

  test('modem-remove: the device disappears from the list', async () => {
    const h = harness();
    try {
      const op = await h.run('modem-remove', 'gsm1');
      assert.equal(op.status, 'done', op.error ?? '');
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.reply, result.state, result.confirmed, result.events], ['[gsm1] Removal scheduled', null, true, ['Disconnect']]);
      assert.equal(h.ami.devices.has('gsm1'), false);
    } finally {
      await h.stop();
    }
  });

  test('a graceful stop of a busy device ends uncertain with what the driver showed; run again after the call ended it completes', async () => {
    const h = harness();
    try {
      /** @type {any} */ (h.ami.devices.get('gsm1')).calls = 1;
      let op = await h.run('modem-stop', 'gsm1');
      assert.equal(op.status, 'uncertain');
      assert.match(op.error ?? '', /accepted QuectelStop for gsm1 \(\[gsm1\] Stop scheduled\), but it was not stopped within 0 s: state Free, current start, desired stop \(a graceful action waits for calls to end\)/);
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.confirmed, result.state, result.desired], [false, 'Free', 'stop']);
      assert.ok(h.ami.calls.filter((c) => c === 'QuectelShowDevices gsm1').length >= 2, 'polled more than once');
      h.ami.settle('gsm1');
      op = await h.run('modem-stop', 'gsm1');
      assert.equal(op.status, 'done', op.error ?? '');
      // with When now the driver acts at once even during a call
      /** @type {any} */ (h.ami.devices.get('gsm1')).calls = 1;
      await h.run('modem-start', 'gsm1');
      /** @type {any} */ (h.ami.devices.get('gsm1')).calls = 1;
      op = await h.run('modem-stop', 'gsm1', { when: 'now' });
      assert.equal(op.status, 'done', op.error ?? '');
    } finally {
      await h.stop();
    }
  });

  test('refusals: a device the driver does not know, a modem outside the registry (unless the driver is given), a wrong When, no modem id, AMI down; a dropped connection is uncertain', async () => {
    const h = harness();
    try {
      let op = await h.run('modem-stop', 'gsm1', { driver: 'dongle' });
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /DongleStop gsm1: \[gsm1\] Device not found/);
      op = await h.run('modem-stop', 'ghost');
      assert.match(op.error ?? '', /modem ghost is not in the registry \(pass params.driver/);
      h.ami.addDevice('ghost', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
      op = await h.run('modem-stop', 'ghost', { driver: 'dongle' });
      assert.equal(op.status, 'done', op.error ?? '');
      op = await h.run('modem-stop', 'gsm1', { driver: 'huawei' });
      assert.match(op.error ?? '', /driver must be quectel or dongle, not "huawei"/);
      op = await h.run('modem-stop', 'gsm1', { when: 'bogus' });
      assert.match(op.error ?? '', /when must be one of now, gracefully, when convenient, not "bogus"/);
      op = await h.runner.wait(h.runner.enqueue({ kind: 'modem-stop', modemId: null, params: {}, actor: 'admin' }));
      assert.match(op.error ?? '', /modem-stop needs the modem id/);
      h.ami.up = false;
      op = await h.run('modem-stop', 'gsm1');
      assert.match(op.error ?? '', /not connected over AMI \(connecting\); the modem was not stopped/);
      h.ami.up = true;
      h.ami.onAction = () => {
        h.ami.up = false;
        return undefined;
      };
      op = await h.run('modem-stop', 'gsm1');
      assert.equal(op.status, 'uncertain');
      assert.match(op.error ?? '', /QuectelStop gsm1: not up; whether the driver acted is unknown/);
    } finally {
      await h.stop();
    }
  });

  test('an operation interrupted by a controller restart runs again at the next start (reevaluate rerun)', async () => {
    const db = open(join(tmp, `life-${++counter}.db`));
    migrate(db);
    const at = Date.now();
    db.prepare("INSERT INTO operations (kind, modem_id, status, params_json, actor, created_at, started_at) VALUES ('modem-stop', 'gsm1', 'running', '{}', 'admin', ?, ?)").run(at, at);
    const ami = new FakeDriverAmi();
    ami.addDevice('gsm1', 'quectel', { state: 'Free', current: 'start', desired: 'start' });
    const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
    createLifecycleOps({ registry: () => REGISTRY, timing: { actionTimeoutMs: 500, confirmTimeoutMs: 120, pollMs: 10 } }).register(runner);
    runner.start();
    try {
      const op = await runner.wait(1);
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(/** @type {any} */ (op.result).state, 'Stopped');
      assert.equal(typeof /** @type {any} */ (op.result).interrupted_at, 'number');
    } finally {
      await runner.stop();
      db.close();
    }
  });
});
