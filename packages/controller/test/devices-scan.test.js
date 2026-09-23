// @ts-check
// Tests for src/devices/scan.js: parseDiscovery() on the fixtures of test/fixtures/discovery, the scan operation on the
// two-modem sysfs tree with a scripted AMI, and the auto-scan after a USB change.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createScanOps, parseDiscovery, SETTING } from '../src/devices/scan.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi, until } from './devices-fake.js';
import { loadSpec, makeSysfs } from './sysfs-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-devscan-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;
const FIXTURES = new URL('./fixtures/discovery/', import.meta.url);
/** @param {string} name */
const lines = (name) => readFileSync(new URL(name, FIXTURES), 'utf8').split('\n');

const TWO_MODEMS = loadSpec('two-modems.json');

/** @param {Record<string, unknown>} registry @param {{ connected?: boolean }} [options] */
function harness(registry, { connected = true } = {}) {
  const dir = join(tmp, `h-${++counter}`);
  const root = makeSysfs(join(dir, 'sys'), TWO_MODEMS);
  const db = open(join(dir, 'scan.db'));
  migrate(db);
  const ami = new FakeDriverAmi({ connected });
  ami.discovery.quectel = lines('quectel-free-ports.txt');
  ami.discovery.dongle = lines('dongle-free-ports.txt');
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
  /** @type {any[]} */
  const logged = [];
  /** @type {any} */
  const log = { debug() {}, info: (/** @type {string} */ msg, /** @type {unknown} */ f) => logged.push({ msg, f }), warn: (/** @type {string} */ msg, /** @type {unknown} */ f) => logged.push({ msg, f }), error() {}, child: () => log };
  const ops = createScanOps({ db, registry: () => validate(registry), log, sysfsRoot: root, now: () => 1_234, ami: /** @type {any} */ (ami), timing: { autoScanDelayMs: 30 } });
  ops.register(runner);
  runner.start();
  /** @param {Record<string, unknown>} [params] */
  const scan = (params = {}) => runner.wait(runner.enqueue({ kind: 'scan', modemId: null, params, actor: 'admin' }));
  return { dir, db, ami, runner, ops, scan, logged, stop: async () => { ops.stop(); await runner.stop(); db.close(); } };
}

describe('devices scan', () => {
  test('parseDiscovery: the hardware captures (free ports: each driver its modem, from the CLI and through AMI; locked ports: an IMSI equal to the IMEI dropped; empty)', () => {
    assert.deepEqual(parseDiscovery(lines('quectel-free-ports.txt'), 'quectel'), [
      { driver: 'quectel', section: 'dc_5160_', data_tty: '/dev/ttyUSB5', audio_tty: '/dev/ttyUSB4', imei: '490154203237518', imsi: null },
    ]);
    const e173 = [{ driver: 'dongle', section: 'dc_3121_', data_tty: '/dev/ttyUSB2', audio_tty: '/dev/ttyUSB1', imei: '356938031234560', imsi: null }];
    assert.deepEqual(parseDiscovery(lines('dongle-free-ports.txt'), 'dongle'), e173);
    assert.deepEqual(parseDiscovery(lines('dongle-ami.txt'), 'dongle'), e173);
    assert.deepEqual(parseDiscovery(lines('quectel-locked-ports.txt'), 'quectel'), [{ driver: 'quectel', section: 'dc_3121_3121', data_tty: '/dev/ttyUSB2', audio_tty: '/dev/ttyUSB1', imei: '356938031234560', imsi: null }]);
    assert.deepEqual(parseDiscovery(lines('dongle-empty.txt'), 'dongle'), []);
    assert.deepEqual(parseDiscovery([''], 'dongle'), [], 'the AMI answer of a command that prints nothing');
  });

  test('parseDiscovery: a SIM gives an IMSI; CRLF lines, garbage values, uncommented keys, blocks without data and fields before a section', () => {
    assert.deepEqual(parseDiscovery(lines('synthesized-with-sim.txt'), 'quectel'), [
      { driver: 'quectel', section: 'dc_5160_4321', data_tty: '/dev/ttyUSB2', audio_tty: '/dev/ttyUSB1', imei: '490154203237518', imsi: '257020123454321' },
      { driver: 'quectel', section: 'dc__', data_tty: '/dev/ttyUSB5', audio_tty: '/dev/ttyUSB4', imei: null, imsi: null },
    ]);
    assert.deepEqual(parseDiscovery(['[gsm1](defaults)', 'audio=/dev/ttyUSB1', 'data=/dev/ttyUSB2', 'imei=123456789012345', 'imsi=12345'], 'dongle'),
      [{ driver: 'dongle', section: 'gsm1', data_tty: '/dev/ttyUSB2', audio_tty: '/dev/ttyUSB1', imei: '123456789012345', imsi: null }], 'a 5-digit IMSI is not one');
    assert.deepEqual(parseDiscovery(['[x]', ';audio=/dev/ttyUSB1', 'imei=123456789012345', '', '[y]', ';data=/dev/ttyUSB3'], 'dongle'),
      [{ driver: 'dongle', section: 'y', data_tty: '/dev/ttyUSB3', audio_tty: null, imei: null, imsi: null }], 'a block without a data tty is not a device');
    assert.deepEqual(parseDiscovery([';data=/dev/ttyUSB7', 'imei=123456789012345'], 'quectel'), [{ driver: 'quectel', section: null, data_tty: '/dev/ttyUSB7', audio_tty: null, imei: '123456789012345', imsi: null }]);
    assert.deepEqual(parseDiscovery(['imei = 12345678901234x', ' ; data = /dev/ttyUSB1 ', 'imsi=25702012345678a'], 'quectel'), [{ driver: 'quectel', section: null, data_tty: '/dev/ttyUSB1', audio_tty: null, imei: null, imsi: null }]);
  });

  test('scan: both discoveries, placed on their USB ports, classified against the registry, stored in devices_seen and settings.scan_latest', async () => {
    const h = harness({ version: 1, modems: [{ id: 'e173', driver: 'dongle', imei: '356938031234560', enabled: true, usb_port: '1-1' }], phones: [] });
    try {
      const op = await h.scan({ trigger: 'manual' });
      assert.equal(op.status, 'done', op.error ?? '');
      const result = /** @type {any} */ (op.result);
      assert.deepEqual(h.ami.calls, ['Command: quectel discovery', 'Command: dongle discovery']);
      assert.equal(result.at, 1_234);
      assert.equal(result.trigger, 'manual');
      assert.deepEqual(result.errors, { quectel: null, dongle: null });
      assert.deepEqual(result.devices, [
        { found_by: ['quectel'], data_tty: '/dev/ttyUSB5', audio_tty: '/dev/ttyUSB4', imei: '490154203237518', imsi: null, usb_port: '1-2', vendor: '2c7c', product: '0125', suggested_driver: 'quectel', registered: null },
        { found_by: ['dongle'], data_tty: '/dev/ttyUSB2', audio_tty: '/dev/ttyUSB1', imei: '356938031234560', imsi: null, usb_port: '1-1', vendor: '12d1', product: '1436', suggested_driver: 'dongle', registered: 'e173' },
      ]);
      assert.deepEqual(result.unassigned.map((/** @type {any} */ d) => d.usb_port), ['1-2']);
      assert.equal(result.observed_at, 1_234);
      const seen = /** @type {any[]} */ (h.db.prepare('SELECT usb_port, vendor, imei, data_tty, present FROM devices_seen ORDER BY usb_port').all()).map((row) => ({ ...row }));
      assert.deepEqual(seen, [{ usb_port: '1-1', vendor: '12d1', imei: '356938031234560', data_tty: '/dev/ttyUSB2', present: 1 }, { usb_port: '1-2', vendor: '2c7c', imei: '490154203237518', data_tty: '/dev/ttyUSB5', present: 1 }]);
      const stored = JSON.parse(/** @type {any} */ (h.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING)).value);
      const { observed_at: _at, ...expected } = result;
      assert.deepEqual(stored, expected);
      assert.deepEqual(h.ops.latest(), expected);
    } finally {
      await h.stop();
    }
  });

  test('scan: a modem registered by its fixed data port or by usb_port owns the device even without an IMEI; both drivers finding one tty merge; a device placed nowhere keeps the finder as driver', async () => {
    const h = harness({ version: 1, modems: [
      { id: 'fixed', driver: 'dongle', imei: '000000000000001', enabled: true, ports: { data: '/dev/ttyUSB2', audio: '/dev/ttyUSB1' } },
      { id: 'byport', driver: 'quectel', imei: '000000000000002', enabled: true, uac: true, usb_port: '1-2' },
    ], phones: [] });
    h.ami.discovery.quectel = lines('synthesized-with-sim.txt').concat(['[dc_9999_](defaults)', ';data=/dev/ttyUSB9', 'imei=999999999999999', '']);
    h.ami.discovery.dongle = lines('dongle-free-ports.txt');
    try {
      const op = await h.scan();
      assert.equal(op.status, 'done', op.error ?? '');
      const devices = /** @type {any} */ (op.result).devices;
      assert.deepEqual(devices.map((/** @type {any} */ d) => [d.data_tty, d.usb_port, d.suggested_driver, d.registered, d.found_by, d.imsi]), [
        ['/dev/ttyUSB2', '1-1', 'dongle', 'fixed', ['quectel', 'dongle'], '257020123454321'],
        ['/dev/ttyUSB5', '1-2', 'quectel', 'byport', ['quectel'], null],
        ['/dev/ttyUSB9', null, 'quectel', null, ['quectel'], null],
      ]);
      assert.equal(/** @type {any} */ (op.result).trigger, 'manual');
      assert.equal(/** @type {any[]} */ (h.db.prepare('SELECT * FROM devices_seen').all()).length, 2, 'a device without a port is not a devices_seen row');
    } finally {
      await h.stop();
    }
  });

  test('scan: one failing discovery is recorded and the other used; both failing, AMI down or a dropped connection fail the operation', async () => {
    const h = harness({ version: 1, modems: [], phones: [] });
    try {
      h.ami.discoveryError.dongle = "No such command 'dongle discovery' (type 'core show help dongle discovery' for other possible commands)";
      let op = await h.scan();
      assert.equal(op.status, 'done', op.error ?? '');
      assert.match(/** @type {any} */ (op.result).errors.dongle, /No such command/);
      assert.deepEqual(/** @type {any} */ (op.result).devices.map((/** @type {any} */ d) => d.usb_port), ['1-2'], 'the quectel result alone');
      h.ami.discoveryError.quectel = 'No such command';
      op = await h.scan();
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /both discovery commands failed: quectel: No such command; dongle: No such command/);
      h.ami.discoveryError = { quectel: null, dongle: null };
      h.ami.up = false;
      op = await h.scan();
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /not connected over AMI \(connecting\); nothing was scanned/);
      h.ami.up = true;
      h.ami.onCommand = () => {
        h.ami.up = false;
        return undefined;
      };
      op = await h.scan();
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /not up/);
    } finally {
      await h.stop();
    }
  });

  test('auto-scan: a plugged modem queues one scan after the delay (restarted by a further plug), not while one is pending or AMI is down; stop() cancels', async () => {
    const h = harness({ version: 1, modems: [], phones: [] });
    try {
      const device = { port: '1-2', vendor: '2c7c', product: '0125', driver: /** @type {'quectel'} */ ('quectel') };
      h.ops.onUsbChange({ added: [] });
      h.ops.onUsbChange({ added: [device] });
      await new Promise((resolve) => setTimeout(resolve, 15));
      h.ops.onUsbChange({ added: [{ ...device, port: '1-1' }] });
      await until(() => /** @type {any[]} */ (h.db.prepare("SELECT * FROM operations WHERE kind = 'scan'").all()).length >= 1, 1_000, 'the auto scan');
      await new Promise((resolve) => setTimeout(resolve, 60));
      const ops = /** @type {any[]} */ (h.db.prepare("SELECT * FROM operations WHERE kind = 'scan' ORDER BY id").all());
      assert.equal(ops.length, 1, 'one scan for both plugs');
      assert.deepEqual(JSON.parse(ops[0].params_json), { trigger: 'hotplug', ports: ['1-2', '1-1'] });
      assert.equal(ops[0].actor, 'system');
      await h.runner.wait(ops[0].id);
      assert.equal(h.ops.latest()?.trigger, 'hotplug');
      // a scan already queued: skipped
      h.ami.onCommand = () => new Promise(() => {});
      const blocked = h.runner.enqueue({ kind: 'scan', modemId: null, params: {}, actor: 'admin' });
      await until(() => h.ami.calls.filter((c) => c === 'Command: quectel discovery').length >= 2, 1_000, 'the blocked scan to start');
      h.ops.onUsbChange({ added: [device] });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(/** @type {any[]} */ (h.db.prepare("SELECT * FROM operations WHERE kind = 'scan'").all()).length, 2);
      assert.ok(h.logged.some((l) => l.msg === 'auto-scan skipped: a scan is already queued or running'));
      // AMI down: skipped; stop(): cancelled
      h.ami.up = false;
      h.ops.onUsbChange({ added: [device] });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(h.logged.some((l) => l.msg === 'auto-scan skipped: AMI is not connected'));
      h.ami.up = true;
      h.ops.onUsbChange({ added: [device] });
      h.ops.stop();
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(/** @type {any[]} */ (h.db.prepare("SELECT * FROM operations WHERE kind = 'scan'").all()).length, 2);
      h.runner.get(blocked);
    } finally {
      h.ops.stop();
      h.db.close();
    }
  });
});
