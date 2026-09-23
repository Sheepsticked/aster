// @ts-check
// Tests for src/devices/remap.js: remapReason() and the remap operation on the two-modem sysfs tree, with a scripted driver
// AMI and a recording stand-in for registry-apply.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { stringify, validate } from '../src/config/registry.js';
import { createRemapOps, remapReason } from '../src/devices/remap.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi } from './devices-fake.js';
import { loadSpec, makeSysfs } from './sysfs-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-devremap-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;
const TWO_MODEMS = loadSpec('two-modems.json');
const FREE_PORTS = readFileSync(new URL('./fixtures/discovery/quectel-free-ports.txt', import.meta.url), 'utf8').split('\n');

/** @param {Partial<import('../src/config/registry.js').Modem>} fields */
const modem = (fields) => /** @type {import('../src/config/registry.js').Modem} */ ({ id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true, uac: true, usb_port: '1-2', ring: [], ring_timeout: 120,
  incoming_context: null, group: null, recipients: null, ports: null, ...fields });
const quectelAt = (/** @type {string} */ port) => ({ port, vendor: '2c7c', product: '0125', driver: /** @type {'quectel'} */ ('quectel') });
const dongleAt = (/** @type {string} */ port) => ({ port, vendor: '12d1', product: '1436', driver: /** @type {'dongle'} */ ('dongle') });

/** The two-modem tree plus a second Quectel modem on port 1-3 (data tty ttyUSB9). */
const TWO_QUECTEL = { ...TWO_MODEMS, devices: [...TWO_MODEMS.devices, { port: '1-3', path: 'usb1/1-3', idVendor: '2c7c', idProduct: '0125', product: 'EC25-EUX' }],
  interfaces: [...(TWO_MODEMS.interfaces ?? []), 'usb1/1-3/1-3:1.2'], ttys: { ...TWO_MODEMS.ttys, ttyUSB9: 'usb1/1-3/1-3:1.2/ttyUSB9' } };

/**
 * @param {Record<string, unknown>[]} modems
 * @param {{ connected?: boolean, spec?: import('./sysfs-fake.js').SysfsSpec }} [options]
 */
function harness(modems, { connected = true, spec = TWO_MODEMS } = {}) {
  const dir = join(tmp, `h-${++counter}`);
  const root = makeSysfs(join(dir, 'sys'), spec);
  const registryPath = join(dir, 'aster.yaml');
  writeFileSync(registryPath, stringify({ version: 1, modems, phones: [] }));
  const db = open(join(dir, 'remap.db'));
  migrate(db);
  const ami = new FakeDriverAmi({ connected });
  /** @type {any[]} */
  const applied = [];
  /** @type {any[]} */
  const logged = [];
  /** @type {any} */
  const log = { debug() {}, info() {}, warn: (/** @type {string} */ msg, /** @type {unknown} */ f) => logged.push({ msg, f }), error() {}, child: () => log };
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
  /** @type {{ registered: any }} */
  const seen = { registered: null };
  const ops = createRemapOps({
    paths: { registry: registryPath }, log, sysfsRoot: root,
    timing: { actionTimeoutMs: 500, discoveryTimeoutMs: 500, confirmTimeoutMs: 100, pollMs: 10 },
    apply: async (_ctx, params) => {
      applied.push(params);
      return { registry_hash: 'h1', files_written: ['aster.d/quectel-devices.conf'], actions: ['QuectelReload'], restarted: [] };
    },
  });
  ops.register(/** @type {any} */ ({ register: (/** @type {string} */ kind, /** @type {any} */ handler, /** @type {any} */ options) => { seen.registered = { kind, options }; runner.register(kind, handler, options); } }));
  runner.start();
  const run = (/** @type {string} */ modemId, /** @type {Record<string, unknown>} */ params = {}) => runner.wait(runner.enqueue({ kind: 'remap', modemId, params, actor: 'system' }));
  return { root, db, ami, runner, run, applied, logged, seen, stop: async () => { await runner.stop(); db.close(); } };
}

describe('devices remap', () => {
  test('remapReason: moved, auto-fill, consistent, unplugged with a free device of the vendor, IMEI seen elsewhere, fixed ports and disabled never', () => {
    const registered = new Map([['1-2', 'ec25'], ['1-1', 'e173']]);
    const base = { usbPresent: [dongleAt('1-1'), quectelAt('1-2')], seen: [], registeredPorts: registered };
    assert.equal(remapReason(modem({}), { ...base, observedPort: '1-2' }), null);
    assert.equal(remapReason(modem({}), { ...base, observedPort: '1-3' }), 'the quectel driver has the device on USB port 1-3; the registry says 1-2');
    assert.equal(remapReason(modem({ usb_port: null, uac: false }), { ...base, observedPort: '1-3' }), 'the quectel driver has the device on USB port 1-3; the registry has no usb_port yet');
    assert.equal(remapReason(modem({}), { ...base, observedPort: null }), null, 'not observed, port present');
    assert.equal(remapReason(modem({}), { ...base, observedPort: null, usbPresent: [dongleAt('1-1'), quectelAt('1-3')] }), 'USB port 1-2 is not plugged in while an unregistered 2c7c device is present on 1-3');
    assert.equal(remapReason(modem({}), { ...base, observedPort: null, usbPresent: [dongleAt('1-1'), dongleAt('1-3')] }), null, 'only another vendor is free');
    assert.equal(remapReason(modem({}), { ...base, observedPort: null, usbPresent: [dongleAt('1-1'), quectelAt('1-4')], registeredPorts: new Map([['1-4', 'other']]) }), null, 'the free device belongs to another modem');
    assert.equal(remapReason(modem({}), { ...base, observedPort: null, usbPresent: null }), null, 'presence unknown');
    assert.equal(remapReason(modem({}), { ...base, observedPort: null, seen: [{ usb_port: '1-3', imei: '490154203237518', present: 1 }] }), 'IMEI 490154203237518 was seen on USB port 1-3, not on 1-2');
    assert.equal(remapReason(modem({ usb_port: null, uac: false }), { ...base, observedPort: null, seen: [{ usb_port: '1-3', imei: '490154203237518', present: 1 }] }), 'IMEI 490154203237518 was seen on USB port 1-3');
    assert.equal(remapReason(modem({}), { ...base, observedPort: null, seen: [{ usb_port: '1-3', imei: '490154203237518', present: 0 }] }), null, 'an unplugged port does not count');
    assert.equal(remapReason(modem({ ports: { data: '/dev/ttyUSB5', audio: '/dev/ttyUSB4' } }), { ...base, observedPort: '1-3' }), null);
    assert.equal(remapReason(modem({ enabled: false }), { ...base, observedPort: '1-3' }), null);
  });

  test('the port from the driver: the device talks on a tty of another port → the registry is applied with the new usb_port, nothing stopped', async () => {
    const h = harness([{ id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true, uac: true, usb_port: '1-1.3' }]);
    h.ami.addDevice('ec25', 'quectel', { state: 'Free', current: 'start', desired: 'start', dataTty: '/dev/ttyUSB5' });
    try {
      const op = await h.run('ec25', { reason: 'moved' });
      assert.equal(op.status, 'done', op.error ?? '');
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.modem_id, result.previous_port, result.port, result.found, result.by, result.changed, result.stopped, result.restarted, result.cleared, typeof result.observed_at],
        ['ec25', '1-1.3', '1-2', true, 'driver', true, false, false, [], 'number']);
      assert.deepEqual(result.apply, { registry_hash: 'h1', files_written: ['aster.d/quectel-devices.conf'], actions: ['QuectelReload'], restarted: [] });
      assert.equal(h.applied.length, 1);
      assert.equal(h.applied[0].registry.modems[0].usb_port, '1-2');
      assert.equal(typeof h.applied[0].base_hash, 'string');
      assert.deepEqual(h.ami.calls, ['QuectelShowDevices ec25']);
      assert.deepEqual(h.seen.registered, { kind: 'remap', options: { lock: 'global', reevaluate: 'rerun' } });
    } finally {
      await h.stop();
    }
  });

  test('the port from discovery by IMEI: a started device without a tty is stopped gracefully first and started again after the apply', async () => {
    const h = harness([{ id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true, uac: true, usb_port: '1-1.3' }, { id: 'e173', driver: 'dongle', imei: '356938031234560', enabled: true, usb_port: '1-1' }]);
    h.ami.addDevice('ec25', 'quectel', { state: 'Not connected', current: 'stop', desired: 'start' });
    h.ami.discovery.quectel = FREE_PORTS;
    try {
      const op = await h.run('ec25');
      assert.equal(op.status, 'done', op.error ?? '');
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.port, result.by, result.changed, result.stopped, result.restarted], ['1-2', 'discovery', true, true, true]);
      assert.deepEqual(h.ami.calls, ['QuectelShowDevices ec25', 'QuectelStop ec25 gracefully', 'QuectelShowDevices ec25', 'Command: quectel discovery', 'QuectelStart ec25 now']);
      assert.equal(h.applied[0].registry.modems[0].usb_port, '1-2');
      assert.equal(h.applied[0].registry.modems[1].usb_port, '1-1', 'the other modem keeps its port');
      // a stopped device is not stopped again and not started afterwards
      h.ami.calls.length = 0;
      h.applied.length = 0;
      writeFileSync(join(h.root, '..', 'aster.yaml'), stringify({ version: 1, modems: [{ id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true, uac: true, usb_port: '1-1.3' }], phones: [] }));
      /** @type {any} */ (h.ami.devices.get('ec25')).state = 'Stopped';
      const again = await h.run('ec25');
      assert.equal(again.status, 'done', again.error ?? '');
      assert.deepEqual([/** @type {any} */ (again.result).stopped, /** @type {any} */ (again.result).restarted], [false, false]);
      assert.deepEqual(h.ami.calls, ['QuectelShowDevices ec25', 'Command: quectel discovery']);
    } finally {
      await h.stop();
    }
  });

  test('presence only: discovery probed the port but reported no usable IMEI, one unregistered device of the vendor → taken with a warning; two → ambiguous; only another vendor probed → absent', async () => {
    const h = harness([{ id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true, uac: true, usb_port: '1-4' }], { spec: TWO_QUECTEL });
    h.ami.addDevice('ec25', 'quectel');
    h.ami.discovery.quectel = ['; discovered device', '[dc__](defaults)', ';audio=/dev/ttyUSB4', ';data=/dev/ttyUSB5', 'imei=;', 'imsi=AT+GSN;', ''];
    try {
      let op = await h.run('ec25');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual([/** @type {any} */ (op.result).port, /** @type {any} */ (op.result).by, /** @type {any} */ (op.result).candidates], ['1-2', 'sysfs', ['1-2']]);
      assert.ok(h.logged.some((l) => l.msg === 'remap by presence only: the device on the port did not report its IMEI'));
      // the second Quectel device on 1-3 answered too, without an IMEI, and is unregistered: two candidates
      h.ami.discovery.quectel = [...h.ami.discovery.quectel, '[dc__](defaults)', ';data=/dev/ttyUSB9', 'imei=', 'imsi=', ''];
      op = await h.run('ec25');
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /answered no discovery with IMEI 490154203237518, and 2 unregistered 2c7c devices are plugged in \(1-2, 1-3\); assign the port by hand/);
      // the E173's port (a 12d1 device) is never a candidate for a quectel modem
      h.ami.discovery.quectel = ['[dc__](defaults)', ';data=/dev/ttyUSB2', 'imei=', 'imsi=', ''];
      op = await h.run('ec25');
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /ec25 \(IMEI 490154203237518\) was not found on any USB port: 1-4 is not plugged in and no free 2c7c device answered quectel discovery; the modem is absent/);
      assert.deepEqual([/** @type {any} */ (op.result).found, /** @type {any} */ (op.result).candidates], [false, []]);
      assert.equal(h.applied.length, 1, 'only the first run applied');
    } finally {
      await h.stop();
    }
  });

  test('a device found nowhere after a stop is started again; the same port changes nothing; another modem holding the port is cleared', async () => {
    const h = harness([{ id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true, uac: true, usb_port: '1-2' }, { id: 'gsm_x', driver: 'quectel', imei: '000000000000001', enabled: true, uac: true, usb_port: '1-1' }]);
    h.ami.addDevice('ec25', 'quectel', { state: 'Not connected', current: 'stop', desired: 'start' });
    try {
      let op = await h.run('ec25');
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /was not found on any USB port/);
      assert.deepEqual(h.ami.calls, ['QuectelShowDevices ec25', 'QuectelStop ec25 gracefully', 'QuectelShowDevices ec25', 'Command: quectel discovery', 'QuectelStart ec25 now']);
      assert.equal(/** @type {any} */ (op.result).restarted, true);
      // the same port: found by the driver, nothing applied
      h.ami.calls.length = 0;
      /** @type {any} */ (h.ami.devices.get('ec25')).dataTty = '/dev/ttyUSB5';
      op = await h.run('ec25');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual([/** @type {any} */ (op.result).port, /** @type {any} */ (op.result).changed, h.applied.length], ['1-2', false, 0]);
      // the device moved onto the port another modem holds: that modem's usb_port is cleared in the applied registry
      /** @type {any} */ (h.ami.devices.get('ec25')).dataTty = '/dev/ttyUSB2';
      op = await h.run('ec25');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual([/** @type {any} */ (op.result).port, /** @type {any} */ (op.result).cleared], ['1-1', ['gsm_x']]);
      assert.deepEqual(h.applied[0].registry.modems.map((/** @type {any} */ m) => [m.id, m.usb_port]), [['ec25', '1-1'], ['gsm_x', null]]);
    } finally {
      await h.stop();
    }
  });

  test('refusals: fixed ports, a modem outside the registry, no modem id, AMI down, a stop the driver refuses; a graceful stop that never completes is uncertain', async () => {
    const h = harness([{ id: 'fixed', driver: 'dongle', imei: '000000000000001', enabled: true, ports: { data: '/dev/ttyUSB2', audio: '/dev/ttyUSB1' } }, { id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true, uac: true, usb_port: '1-3' }]);
    try {
      let op = await h.run('fixed');
      assert.match(op.error ?? '', /modem fixed uses fixed ports \(\/dev\/ttyUSB2\); there is nothing to remap/);
      op = await h.run('ghost');
      assert.match(op.error ?? '', /modem ghost is not in the registry/);
      op = await h.runner.wait(h.runner.enqueue({ kind: 'remap', modemId: null, params: {}, actor: 'system' }));
      assert.match(op.error ?? '', /remap needs the modem id/);
      h.ami.up = false;
      op = await h.run('ec25');
      assert.match(op.error ?? '', /not connected over AMI \(connecting\); the modem was not remapped/);
      h.ami.up = true;
      h.ami.addDevice('ec25', 'quectel', { state: 'Free', current: 'start', desired: 'start', calls: 1 });
      op = await h.run('ec25');
      assert.equal(op.status, 'uncertain');
      assert.match(op.error ?? '', /ec25 did not stop within 0 s \(state Free; a graceful stop waits for calls to end\), so its port could not be probed/);
      assert.equal(/** @type {any} */ (op.result).stopped, true);
    } finally {
      await h.stop();
    }
  });
});
