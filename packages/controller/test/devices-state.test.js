// @ts-check
// Tests for src/devices/state.js: DeviceEntry parsing, the UI state derivation, and the refresher on the two-modem sysfs tree
// with a scripted AMI, a temporary database and the bus.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createDeviceState, DEFAULTS, DRIVER_STATES, parseDeviceEntry, showAllDevices, UI_STATES, uiState } from '../src/devices/state.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi, packetsOf, until } from './devices-fake.js';
import { loadSpec, makeSysfs } from './sysfs-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-devstate-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

const TWO_MODEMS = loadSpec('two-modems.json');
const REGISTRY = {
  version: 1,
  modems: [
    { id: 'e173', driver: 'dongle', imei: '356938031234560', enabled: true, usb_port: '1-1' },
    { id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true, uac: true, usb_port: '1-2' },
    { id: 'gsm_off', driver: 'quectel', imei: '000000000000009', enabled: false },
  ],
  phones: [],
};

/** @param {Record<string, unknown>} [registry] */
function harness(registry = REGISTRY) {
  const dir = join(tmp, `h-${++counter}`);
  const root = makeSysfs(join(dir, 'sys'), TWO_MODEMS);
  const db = open(join(dir, 'state.db'));
  migrate(db);
  const bus = createBus();
  /** @type {any[]} */
  const events = [];
  bus.subscribe((event) => {
    if (event.type === 'modem.state') events.push(event.payload);
  });
  const ami = new FakeDriverAmi();
  ami.addDevice('e173', 'dongle', { state: 'Free', current: 'start', desired: 'start', dataTty: '/dev/ttyUSB2', audio: '/dev/ttyUSB1', imei: '356938031234560', imsi: '257020000000001', gsmReg: 'Registered, home network', rssi: 18, provider: 'MTS', number: '+1234567890' });
  ami.addDevice('ec25', 'quectel', { state: 'Free', current: 'start', desired: 'start', dataTty: '/dev/ttyUSB5', audio: 'plughw:CARD=q_1_2', imei: '490154203237518', rssi: 22, provider: 'A1' });
  let clock = 1_000_000;
  const now = () => clock;
  /** @type {Array<{ modem: string, reason: string }>} */
  const remaps = [];
  /** @type {any[]} */
  const usbChanges = [];
  /** @type {any[]} */
  const logged = [];
  /** @type {any} */
  const log = { debug() {}, info: (/** @type {string} */ msg, /** @type {unknown} */ f) => logged.push({ level: 'info', msg, f }), warn: (/** @type {string} */ msg, /** @type {unknown} */ f) => logged.push({ level: 'warn', msg, f }), error: (/** @type {string} */ msg, /** @type {unknown} */ f) => logged.push({ level: 'error', msg, f }), child: () => log };
  let reg = /** @type {import('../src/config/registry.js').Registry | null} */ (validate(registry));
  const devices = createDeviceState({
    db, ami: /** @type {any} */ (ami), bus, log, registry: () => reg, sysfsRoot: root, now,
    timing: { refreshMs: 40, sysfsPollMs: 25, debounceMs: 5, staleMs: 100, flapWindowMs: 1_000, flapDisconnects: 3 },
    onUsbChange: (change) => usbChanges.push(change),
    onRemapNeeded: (modem, reason) => remaps.push({ modem, reason }),
  });
  return {
    dir, root, db, bus, events, ami, devices, remaps, usbChanges, logged, log,
    /** @param {number} ms */
    tick: (ms) => { clock += ms; },
    /** @param {Record<string, unknown> | null} next */
    setRegistry: (next) => { reg = next ? validate(next) : null; },
    /** The last observation of a modem (kept in memory), with detail as JSON.
     * @param {string} id */
    row: (id) => {
      const state = /** @type {any} */ (devices.states().get(id));
      return state ? { ...state, detail_json: JSON.stringify(state.detail) } : undefined;
    },
    seen: () => /** @type {any[]} */ (db.prepare('SELECT * FROM devices_seen ORDER BY usb_port').all()),
    /** unplug a port in the fake sysfs: the device entry and the ttys under it disappear, as they do when a modem is pulled @param {string} port */
    unplug: (port) => {
      unlinkSync(join(root, 'bus', 'usb', 'devices', port));
      for (const [tty, path] of Object.entries(TWO_MODEMS.ttys ?? {})) if (String(path).startsWith(`usb1/${port}/`)) unlinkSync(join(root, 'class', 'tty', tty));
    },
    /** plug it back @param {string} port */
    replug: (port) => {
      symlinkSync(join(root, 'devices', String(TWO_MODEMS.usb), `usb1/${port}`), join(root, 'bus', 'usb', 'devices', port));
      for (const [tty, path] of Object.entries(TWO_MODEMS.ttys ?? {})) if (String(path).startsWith(`usb1/${port}/`)) symlinkSync(join(root, 'devices', String(TWO_MODEMS.usb), String(path), 'tty', tty), join(root, 'class', 'tty', tty));
    },
  };
}

describe('devices state', () => {
  test('parseDeviceEntry reads the captured QuectelDeviceEntry/DongleDeviceEntry packets and normalizes the placeholders', () => {
    const packets = packetsOf(readFileSync(new URL('./fixtures/ami/show-devices.txt', import.meta.url), 'latin1'));
    const entries = packets.filter((p) => String(p.get('Event') ?? '').endsWith('DeviceEntry'));
    assert.equal(entries.length, 5);
    const uac = parseDeviceEntry(/** @type {any} */ (entries.find((p) => p.get('Device') === 'gsm_uac')), 'quectel');
    assert.deepEqual(uac, { driver: 'quectel', device: 'gsm_uac', state: 'Stopped', imei: null, imsi: null, dataTty: null, audio: 'plughw:CARD=q_1_1_3', gsmReg: 'Unknown', rssi: 0,
      provider: null, number: null, current: 'stop', desired: 'stop', imeiSetting: '000000000000002', dataSetting: null, manufacturer: null, model: null, firmware: null, calls: 0, radio: null });
    const dongle = parseDeviceEntry(/** @type {any} */ (entries.find((p) => p.get('Event') === 'DongleDeviceEntry')), 'dongle');
    assert.equal(dongle.driver, 'dongle');
    assert.equal(dongle.state, 'Stopped');
    // a live entry (values as the drivers format them)
    const live = parseDeviceEntry(new Map([['Device', 'gsm1'], ['State', 'Free'], ['IMEIState', '490154203237518'], ['IMSIState', '257020000000001'], ['DataState', '/dev/ttyUSB5'], ['AudioState', '/dev/ttyUSB4'],
      ['GSMRegistrationStatus', 'Registered, home network'], ['RSSI', '18, -77 dBm'], ['ProviderName', 'MTS'], ['SubscriberNumber', '+1234567890'], ['CurrentDeviceState', 'start'], ['DesiredDeviceState', 'restart'],
      ['Manufacturer', 'Quectel'], ['Model', 'EC25'], ['Firmware', 'EC25EUXGAR08A05M1G'], ['CallsChannels', '2']]), 'quectel');
    assert.deepEqual([live.state, live.imei, live.imsi, live.dataTty, live.audio, live.rssi, live.provider, live.number, live.current, live.desired, live.model, live.calls],
      ['Free', '490154203237518', '257020000000001', '/dev/ttyUSB5', '/dev/ttyUSB4', 18, 'MTS', '+1234567890', 'start', 'restart', 'EC25', 2]);
    assert.equal(parseDeviceEntry(new Map([['RSSI', '99, Unknown']]), 'dongle').rssi, null);
    assert.equal(parseDeviceEntry(new Map([['RSSI', 'garbage']]), 'dongle').rssi, null);
    assert.equal(parseDeviceEntry(new Map([['CallsChannels', 'x']]), 'dongle').calls, 0);
    assert.equal(parseDeviceEntry(new Map([['RadioSetting', 'off']]), 'quectel').radio, 'off');
    assert.equal(parseDeviceEntry(new Map(), 'quectel').radio, null, 'a driver without the radio patches reports no RadioSetting');
  });

  test('uiState: every combination of registry entry, observation and USB presence gives one of the eleven states in precedence order', () => {
    const drivers = [...Object.keys(DRIVER_STATES), 'Strange'];
    const now = 5_000;
    let combinations = 0;
    for (const enabled of [true, false]) {
      for (const uac of [true, false]) {
        for (const usb_port of [null, '1-2']) {
          for (const observation of ['none', 'stale', 'unlisted', ...drivers]) {
            for (const flapping of [false, true]) {
              for (const presence of ['unknown', 'present', 'absent', 'duplicate']) {
                combinations += 1;
                const modem = { enabled, uac, usb_port, imei: '490154203237518' };
                const state = observation === 'none' ? null : {
                  observed_at: observation === 'stale' ? now - DEFAULTS.staleMs - 1 : now,
                  driver_state: observation === 'unlisted' ? null : observation === 'stale' ? 'Free' : observation,
                  detail: { listed: observation !== 'unlisted', flapping },
                };
                const seen = presence === 'unknown' ? null
                  : presence === 'present' ? [{ usb_port: '1-2', imei: '490154203237518', present: /** @type {1} */ (1) }]
                    : presence === 'absent' ? [{ usb_port: '1-2', imei: '490154203237518', present: /** @type {0} */ (0) }, { usb_port: '1-3', imei: '1', present: /** @type {1} */ (1) }]
                      : [{ usb_port: '1-2', imei: '490154203237518', present: /** @type {1} */ (1) }, { usb_port: '1-3', imei: '490154203237518', present: /** @type {1} */ (1) }];
                const result = uiState(modem, state, seen, { now });
                const label = JSON.stringify({ enabled, uac, usb_port, observation, flapping, presence });
                assert.ok(UI_STATES.includes(result), `${label} → ${result}`);
                let expected;
                if (!enabled) expected = 'disabled';
                else if (uac && usb_port === null) expected = 'unmapped';
                else if (observation === 'none' || observation === 'stale' || observation === 'unlisted') expected = 'unverified';
                else if (presence === 'duplicate') expected = 'duplicate-imei';
                else if (flapping) expected = 'flapping';
                else if (usb_port !== null && presence === 'absent') expected = 'absent';
                else expected = DRIVER_STATES[observation] ?? 'unverified';
                assert.equal(result, expected, label);
              }
            }
          }
        }
      }
    }
    assert.equal(combinations, 2 * 2 * 2 * 19 * 2 * 4); // 19 observations: none, stale, unlisted, the 15 driver states (Radio off included), Strange
    assert.equal(UI_STATES.length, 11);
  });

  test('refresh: rows from ShowDevices with the USB port of the data tty, devices_seen, one bus event per modem, then silence until something changes', async () => {
    const h = harness();
    h.devices.pollSysfs();
    const result = await h.devices.refresh();
    assert.deepEqual([result.skipped, result.modems, result.listed, result.errors], [null, 3, 2, { quectel: null, dongle: null }]);
    assert.deepEqual(result.published.sort(), ['e173', 'ec25', 'gsm_off']);
    const e173 = h.row('e173');
    assert.deepEqual([e173.state, e173.driver_state, e173.gsm_reg, e173.rssi, e173.provider, e173.number, e173.data_tty, e173.usb_port, e173.observed_at],
      ['ready', 'Free', 'Registered, home network', 18, 'MTS', '+1234567890', '/dev/ttyUSB2', '1-1', 1_000_000]);
    const detail = JSON.parse(e173.detail_json);
    assert.deepEqual([detail.listed, detail.current, detail.desired, detail.imei, detail.imsi, detail.flapping, detail.vendor, detail.product, detail.reason], [true, 'start', 'start', '356938031234560', '257020000000001', false, '12d1', '1436', null]);
    assert.equal(h.row('ec25').state, 'ready');
    assert.equal(h.row('ec25').usb_port, '1-2');
    assert.equal(h.row('gsm_off').state, 'disabled');
    assert.equal(JSON.parse(h.row('gsm_off').detail_json).reason, 'quectel driver does not list the device (registry not applied?)');
    const seen = h.seen();
    assert.deepEqual(seen.map((r) => [r.usb_port, r.vendor, r.product, r.imei, r.imsi, r.data_tty, r.present]), [
      ['1-1', '12d1', '1436', '356938031234560', '257020000000001', '/dev/ttyUSB2', 1],
      ['1-2', '2c7c', '0125', '490154203237518', null, '/dev/ttyUSB5', 1],
    ]);
    assert.equal(h.events.length, 3);
    const published = h.events.find((e) => e.modem_id === 'e173');
    assert.equal(published.state, 'ready');
    assert.equal(published.detail.imei, '356938031234560');
    // nothing changed: no event, the row's timestamp moves
    h.tick(10_000);
    await h.devices.refresh();
    assert.equal(h.events.length, 3);
    assert.equal(h.row('e173').observed_at, 1_010_000);
    // a signal change publishes only that modem
    /** @type {any} */ (h.ami.devices.get('ec25')).rssi = 9;
    await h.devices.refresh();
    assert.equal(h.events.length, 4);
    assert.equal(h.events[3].modem_id, 'ec25');
    assert.equal(h.events[3].rssi, 9);
    assert.equal(h.devices.states().get('ec25')?.rssi, 9);
    assert.equal(h.devices.stateOf(/** @type {any} */ (validate(REGISTRY)).modems[1]), 'ready');
  });

  test('AMI down: rows are left alone, the published state turns unverified once the observation is stale, and recovers', async () => {
    const h = harness();
    h.devices.pollSysfs();
    await h.devices.refresh();
    h.ami.up = false;
    h.tick(50);
    let result = await h.devices.refresh();
    assert.equal(result.skipped, 'AMI connecting');
    assert.equal(h.events.length, 3, 'still fresh: nothing published');
    h.tick(100);
    result = await h.devices.refresh();
    assert.deepEqual(result.published.sort(), ['e173', 'ec25'], 'gsm_off stays disabled');
    assert.equal(h.events.at(-1).state, 'unverified');
    assert.equal(h.events.at(-1).driver_state, 'Free', 'the stale observation travels with it');
    assert.equal(h.row('e173').state, 'ready', 'the stored row is not rewritten while AMI is down');
    assert.equal(h.devices.stateOf(/** @type {any} */ (validate(REGISTRY)).modems[0]), 'unverified');
    h.ami.up = true;
    await h.devices.refresh();
    assert.equal(h.events.at(-1).state, 'ready');
    assert.equal(h.row('e173').observed_at, 1_000_150);
    // without any AMI client at all
    const none = createDeviceState({ db: h.db, ami: null, bus: h.bus, registry: () => validate(REGISTRY), sysfsRoot: h.root, now: () => 1 });
    assert.equal((await none.refresh()).skipped, 'no AMI');
  });

  test('Status events: three Disconnects within the window make the modem flapping, the window expiry clears it, and each event schedules a refresh', async () => {
    const h = harness();
    h.devices.pollSysfs();
    await h.devices.refresh();
    h.devices.noteDisconnect('ec25');
    h.tick(100);
    h.devices.noteDisconnect('ec25');
    await h.devices.refresh();
    assert.equal(h.row('ec25').state, 'ready');
    assert.equal(JSON.parse(h.row('ec25').detail_json).disconnects, 2);
    h.tick(100);
    h.devices.noteDisconnect('ec25');
    await h.devices.refresh();
    assert.equal(h.row('ec25').state, 'flapping');
    assert.equal(h.events.at(-1).state, 'flapping');
    h.tick(1_000);
    await h.devices.refresh();
    assert.equal(h.row('ec25').state, 'ready');
    assert.equal(JSON.parse(h.row('ec25').detail_json).disconnects, 0);
    // a real event through the AMI listener triggers a debounced refresh once started
    h.devices.start();
    try {
      await until(() => h.ami.calls.filter((c) => c === 'QuectelShowDevices').length >= 1, 1_000, 'the first timed refresh');
      const before = h.ami.calls.length;
      h.ami.emitStatus('e173', 'Disconnect');
      h.ami.emitStatus('e173', 'Connect');
      await until(() => h.ami.calls.length > before, 1_000, 'the refresh after the Status events');
      assert.equal(JSON.parse(h.row('e173').detail_json).disconnects, 1);
    } finally {
      await h.devices.stop();
    }
  });

  test('sysfs poll: an unplugged port makes its modem absent and marks devices_seen, a replug reports the port and forgets the old identity', async () => {
    const h = harness();
    assert.deepEqual(h.devices.pollSysfs(), { added: [], removed: [], present: [{ port: '1-1', vendor: '12d1', product: '1436', driver: 'dongle' }, { port: '1-2', vendor: '2c7c', product: '0125', driver: 'quectel' }] });
    assert.equal(h.usbChanges.length, 0, 'the first poll is the baseline');
    await h.devices.refresh();
    h.unplug('1-2');
    const change = h.devices.pollSysfs();
    assert.deepEqual(change?.removed.map((d) => d.port), ['1-2']);
    assert.equal(h.usbChanges.length, 1);
    assert.deepEqual(h.usbChanges[0]?.removed.map((/** @type {any} */ d) => d.port), ['1-2']);
    assert.equal(h.seen().find((r) => r.usb_port === '1-2')?.present, 0);
    // the driver still shows the last DataState for a moment; the tty is gone, so it cannot be placed and the port stays absent
    await h.devices.refresh();
    assert.equal(h.row('ec25').state, 'absent');
    assert.equal(h.row('ec25').usb_port, null);
    assert.equal(h.events.at(-1).modem_id, 'ec25');
    assert.equal(h.events.at(-1).state, 'absent');
    assert.deepEqual(h.devices.usb()?.map((d) => d.port), ['1-1']);
    h.replug('1-2');
    assert.deepEqual(h.devices.pollSysfs()?.added.map((d) => d.port), ['1-2']);
    assert.equal(h.usbChanges.length, 2);
    const replugged = h.seen().find((r) => r.usb_port === '1-2');
    assert.deepEqual([replugged?.present, replugged?.imei, replugged?.data_tty], [1, null, null], 'a fresh plug has no identity yet');
    await h.devices.refresh();
    assert.equal(h.row('ec25').state, 'ready');
    assert.equal(h.seen().find((r) => r.usb_port === '1-2')?.imei, '490154203237518', 'the driver reported it again');
  });

  test('sysfs unavailable: presence is unknown, nothing becomes absent, warned once', async () => {
    const h = harness();
    const broken = createDeviceState({ db: h.db, ami: /** @type {any} */ (h.ami), bus: h.bus, log: h.log, registry: () => validate(REGISTRY), sysfsRoot: join(h.dir, 'no-sys'), now: () => 7 });
    assert.equal(broken.pollSysfs(), null);
    assert.equal(broken.pollSysfs(), null);
    assert.equal(h.logged.filter((l) => l.msg.startsWith('USB presence unknown')).length, 1);
    await broken.refresh();
    // its own map, not the harness's: since two instances share nothing but the database, which holds no state row
    assert.equal(broken.states().get('e173')?.state, 'ready');
    assert.equal(broken.states().get('e173')?.usb_port, null, 'ttys cannot be placed either');
    assert.equal(broken.usb(), null);
  });

  test('remap signalling: a device on another port than the registry is reported once per reason until the reason clears', async () => {
    const h = harness();
    h.devices.pollSysfs();
    await h.devices.refresh();
    assert.equal(h.remaps.length, 0);
    /** @type {any} */ (h.ami.devices.get('e173')).dataTty = '/dev/ttyUSB5';
    await h.devices.refresh();
    assert.equal(h.remaps.length, 1);
    assert.equal(h.remaps[0]?.modem, 'e173');
    assert.match(h.remaps[0]?.reason ?? '', /USB port 1-2; the registry says 1-1/);
    await h.devices.refresh();
    assert.equal(h.remaps.length, 1, 'the same reason is not repeated');
    /** @type {any} */ (h.ami.devices.get('e173')).dataTty = '/dev/ttyUSB2';
    await h.devices.refresh();
    /** @type {any} */ (h.ami.devices.get('e173')).dataTty = '/dev/ttyUSB5';
    await h.devices.refresh();
    assert.equal(h.remaps.length, 2, 'reported again after it cleared');
    // a modem without usb_port that the driver placed: auto-fill
    h.setRegistry({ ...REGISTRY, modems: [{ id: 'ec25', driver: 'quectel', imei: '490154203237518', enabled: true }] });
    await h.devices.refresh();
    assert.match(h.remaps.at(-1)?.reason ?? '', /the registry has no usb_port yet/);
  });

  test('an unlisted modem is unverified with the reason; a driver whose list fails leaves its modems unverified and the other driver working', async () => {
    const h = harness({ ...REGISTRY, modems: [...REGISTRY.modems, { id: 'gsm_new', driver: 'dongle', imei: '000000000000008', enabled: true }] });
    h.devices.pollSysfs();
    await h.devices.refresh();
    assert.equal(h.row('gsm_new').state, 'unverified');
    assert.equal(JSON.parse(h.row('gsm_new').detail_json).reason, 'dongle driver does not list the device (registry not applied?)');
    h.ami.onList = (name) => {
      if (name === 'DongleShowDevices') throw new (class extends Error {})('boom');
      return undefined;
    };
    const failed = await h.devices.refresh();
    assert.match(failed.skipped ?? '', /failed: boom/, 'an unexpected error ends the refresh without touching rows');
    assert.equal(h.row('e173').state, 'ready');
    const { AmiError } = await import('../src/ami/client.js');
    h.ami.onList = (name) => {
      if (name === 'DongleShowDevices') throw new AmiError('Invalid/unknown command', new Map([['Response', 'Error']]));
      return undefined;
    };
    const partial = await h.devices.refresh();
    assert.deepEqual(partial.errors, { quectel: null, dongle: 'Invalid/unknown command' });
    assert.equal(h.row('e173').state, 'unverified');
    assert.equal(JSON.parse(h.row('e173').detail_json).reason, 'dongle driver: Invalid/unknown command');
    assert.equal(h.row('ec25').state, 'ready');
    // an unknown State text is unverified too
    h.ami.onList = null;
    /** @type {any} */ (h.ami.devices.get('ec25')).state = 'Strange';
    await h.devices.refresh();
    assert.equal(h.row('ec25').state, 'unverified');
    assert.equal(JSON.parse(h.row('ec25').detail_json).reason, 'unknown driver state "Strange"');
  });

  test('an unloadable registry skips the refresh and keeps the rows; a modem removed from the registry loses its row', async () => {
    const h = harness();
    h.devices.pollSysfs();
    await h.devices.refresh();
    h.setRegistry(null);
    const result = await h.devices.refresh();
    assert.equal(result.skipped, 'registry');
    assert.equal(h.row('e173').state, 'ready');
    assert.equal(h.logged.filter((l) => l.msg.startsWith('modem state not refreshed')).length, 1);
    h.setRegistry({ ...REGISTRY, modems: REGISTRY.modems.filter((m) => m.id !== 'e173') });
    await h.devices.refresh();
    assert.equal(h.row('e173'), undefined);
    assert.equal(h.devices.states().has('e173'), false);
    assert.equal(h.devices.states().size, 2);
    // Nothing is loaded at construction: a new instance shows `unverified` until its first refresh.
    const again = createDeviceState({ db: h.db, ami: null, bus: h.bus, registry: () => validate(REGISTRY), sysfsRoot: h.root, now: () => 1 });
    assert.deepEqual([...again.states().keys()], []);
    const ec25 = validate(REGISTRY).modems.find((m) => m.id === 'ec25');
    assert.ok(ec25);
    assert.equal(again.stateOf(ec25), 'unverified');
  });

  // The appliance runs from an SD card, so a refresh that learns nothing must cost no write.
  // total_changes() counts the rows this connection has changed.
  describe('write budget', () => {
    /** @param {any} db */
    const changed = (db) => Number(/** @type {any} */ (db.prepare('SELECT total_changes() AS n').get()).n);

    test('refreshes that see the same devices, ports and identities write nothing at all', async () => {
      const h = harness();
      h.devices.pollSysfs();
      await h.devices.refresh();
      const before = changed(h.db);
      await h.devices.refresh();
      await h.devices.refresh();
      h.devices.pollSysfs();
      assert.equal(changed(h.db), before, 'three more refreshes and a poll wrote no row');
      assert.equal(h.row('ec25').state, 'ready', 'the state is still current, it just lives in memory');
      assert.equal(h.row('ec25').observed_at, 1_000_000, 'and it is still observed at every refresh');
    });

    test('the touch window is 15 minutes, not a comfort setting', () => {
      // Asserted as a literal: a test that reads DEFAULTS cannot notice the value changing.
      assert.equal(DEFAULTS.seenTouchMs, 900_000);
    });

    test('a port the refresh has never seen, and one the poll marked gone, are written even inside the window', async () => {
      const h = harness();
      // no pollSysfs() first: devices_seen is empty, so the refresher meets a port with no stored row at all
      const before = changed(h.db);
      await h.devices.refresh();
      assert.equal(changed(h.db) - before, 2, 'both placed ports are new to devices_seen');

      h.unplug('1-2');
      h.devices.pollSysfs();
      h.replug('1-2');
      const stale = changed(h.db);
      // sysfs has not been polled since, so the row still says present = 0 while the driver goes on listing the device
      assert.equal(h.seen().find((r) => r.usb_port === '1-2')?.present, 0);
      await h.devices.refresh();
      assert.equal(changed(h.db) - stale, 1, 'a row that is not present is written again, whatever last_seen says');
      assert.equal(h.seen().find((r) => r.usb_port === '1-2')?.present, 1);
    });

    test('each identity field the driver reports is compared, not only the timestamp', async () => {
      const h = harness();
      h.devices.pollSysfs();
      await h.devices.refresh();
      for (const [field, value] of [['imei', '490154203237519'], ['imsi', '257020000000003'], ['dataTty', '/dev/ttyUSB6']]) {
        const before = changed(h.db);
        /** @type {any} */ (h.ami.devices.get('ec25'))[String(field)] = value;
        await h.devices.refresh();
        assert.equal(changed(h.db) - before, 1, `a new ${field} is written at once`);
      }
    });

    test('a new identity, an unplug and a plug are still written at once', async () => {
      const h = harness();
      h.devices.pollSysfs();
      await h.devices.refresh();

      let before = changed(h.db);
      /** @type {any} */ (h.ami.devices.get('ec25')).imsi = '257020000000002';
      await h.devices.refresh();
      assert.equal(changed(h.db) - before, 1, 'the IMSI the driver now reports');
      assert.equal(h.seen().find((r) => r.usb_port === '1-2')?.imsi, '257020000000002');

      before = changed(h.db);
      h.unplug('1-2');
      h.devices.pollSysfs();
      assert.equal(changed(h.db) - before, 1, 'the port is no longer present');
      assert.equal(h.seen().find((r) => r.usb_port === '1-2')?.present, 0);

      before = changed(h.db);
      h.replug('1-2');
      h.devices.pollSysfs();
      assert.equal(changed(h.db) - before, 1, 'and present again, its identity forgotten until a driver reports it');
    });

    test('last_seen is touched once per seenTouchMs, not once per refresh', async () => {
      const h = harness();
      h.devices.pollSysfs();
      await h.devices.refresh();
      const before = changed(h.db);
      h.tick(DEFAULTS.seenTouchMs - 1);
      await h.devices.refresh();
      assert.equal(changed(h.db), before, 'still inside the window');
      h.tick(2);
      await h.devices.refresh();
      assert.equal(changed(h.db) - before, 2, 'one touch for each of the two placed ports');
      assert.equal(h.seen().find((r) => r.usb_port === '1-2')?.last_seen, 1_000_000 + DEFAULTS.seenTouchMs + 1);
    });
  });

  test('start(): periodic refreshes and sysfs polls, a refresh after a finished modem operation, nothing after stop()', async () => {
    const h = harness();
    h.devices.start();
    assert.throws(() => h.devices.start(), /already started/);
    try {
      await until(() => h.ami.calls.filter((c) => c === 'QuectelShowDevices').length >= 3, 2_000, 'three timed refreshes');
      const before = h.ami.calls.length;
      h.bus.publish('op.progress', { id: 1, kind: 'modem-stop', modem_id: 'ec25', actor: 'admin', status: 'done', message: null, result: {}, error: null, at: 1 });
      h.bus.publish('op.progress', { id: 2, kind: 'at', modem_id: 'ec25', actor: 'admin', status: 'done', message: null, result: {}, error: null, at: 1 });
      await until(() => h.ami.calls.length > before, 1_000, 'the refresh after the operation');
      h.unplug('1-1');
      await until(() => h.usbChanges.length === 1, 1_000, 'the poll noticing the unplug');
      await until(() => h.row('e173').state === 'absent', 1_000, 'e173 absent');
      const showDevices = () => h.ami.calls.filter((c) => c === 'QuectelShowDevices').length;
      const count = showDevices();
      assert.ok(count >= 3);
    } finally {
      await h.devices.stop();
    }
    const after = h.ami.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(h.ami.calls.length, after, 'no request after stop()');
    assert.equal((await h.devices.refresh()).skipped, null, 'a manual refresh still works but writes nothing new');
  });

  test('showAllDevices merges both lists by device name and reports a failing driver', async () => {
    const ami = new FakeDriverAmi();
    ami.addDevice('a', 'quectel');
    ami.addDevice('b', 'dongle');
    const { entries, errors } = await showAllDevices(/** @type {any} */ (ami));
    assert.deepEqual([...entries.keys()], ['a', 'b']);
    assert.deepEqual(errors, { quectel: null, dongle: null });
  });
});
