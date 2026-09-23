// @ts-check
// Tests for GET /api/overview: the modems with their UI state derived per request, the health strip, and the unassigned
// devices of the last scan.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validate } from '../src/config/registry.js';
import { uiState } from '../src/devices/state.js';
import { unassigned } from '../src/http/routes/overview.js';
import { harness, REGISTRY, snapshot } from './http-harness.js';

/** A state row as devices/state.js holds it in memory. */
const row = (/** @type {Partial<any>} */ fields = {}) => ({
  modem_id: 'gsm1', state: 'ready', driver_state: 'Free', gsm_reg: 'Registered', rssi: 21, provider: 'A1', number: '+375290000001',
  data_tty: '/dev/ttyUSB2', usb_port: '1-1', observed_at: Date.now(),
  detail: { listed: true, current: 'start', desired: 'start', flapping: false, imsi: '257010000000001', model: 'EC25', firmware: 'x',
    calls: 0, disconnects: 0, reason: null, forwarding: { verified: true, outcome: 'ok', enabled: true, number: '+375290000002' } },
  ...fields,
});

const DEVICE = { found_by: ['quectel'], data_tty: '/dev/ttyUSB6', audio_tty: '/dev/ttyUSB5', imei: '356938031234560', imsi: null,
  usb_port: '1-2', vendor: '12d1', product: '1436', suggested_driver: 'dongle', registered: null };

/** @param {Map<string, any>} rows @param {any[]} [seen] */
function deviceState(rows, seen = []) {
  return { states: () => rows, stateOf: (/** @type {any} */ modem) => uiState(modem, rows.get(modem.id) ?? null, seen, { now: Date.now() }) };
}

describe('http overview routes', () => {
  test('modems carry the registry entry and the state derived now; a stale observation is unverified', async () => {
    const rows = new Map([['gsm1', row()]]);
    const h = await harness({ devices: deviceState(rows, [{ usb_port: '1-1', imei: '490154203237518', present: 1 }]) });
    try {
      const { cookie } = await h.login();
      const before = snapshot(h.db);
      let body = (await h.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).json();
      assert.equal(body.modems.length, 1);
      const modem = body.modems[0];
      assert.deepEqual([modem.id, modem.driver, modem.imei, modem.enabled, modem.usb_port], ['gsm1', 'quectel', '490154203237518', true, '1-1']);
      assert.deepEqual([modem.state, modem.driver_state, modem.rssi, modem.provider, modem.number], ['ready', 'Free', 21, 'A1', '+375290000001']);
      assert.deepEqual(modem.forwarding, { verified: true, outcome: 'ok', enabled: true, number: '+375290000002' });
      assert.deepEqual([modem.detail.imsi, modem.detail.listed, modem.detail.flapping], ['257010000000001', true, false]);
      assert.deepEqual([body.registry, body.unassigned, body.scan], [{ valid: true, problems: [] }, [], null]);
      assert.deepEqual([body.health.status, body.health.reasons], ['ok', []]);

      rows.set('gsm1', row({ observed_at: Date.now() - 45_000 }));
      body = (await h.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).json();
      assert.equal(body.modems[0].state, 'unverified', 'the row still says ready; 45 s without an observation does not');
      assert.equal(snapshot(h.db), before, 'a GET writes nothing');
    } finally {
      await h.stop();
    }
  });

  test('the unassigned panel holds the scanned devices no modem owns', async () => {
    const scan = { at: 1_700_000_000_000, trigger: 'manual', devices: [DEVICE, { ...DEVICE, imei: '490154203237518', usb_port: '1-1' }],
      unassigned: [DEVICE], errors: { quectel: null, dongle: null } };
    const h = await harness({ devices: deviceState(new Map()), scan: { latest: () => scan } });
    try {
      const { cookie } = await h.login();
      const body = (await h.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).json();
      assert.deepEqual(body.unassigned, [DEVICE]);
      assert.deepEqual(body.scan, { at: scan.at, trigger: 'manual', devices: 2, errors: { quectel: null, dongle: null } });
      assert.equal(body.modems[0].state, 'unverified', 'no observation at all is unverified too');

      // The rule the panel filters by: a device is unassigned until a modem claims its IMEI, its fixed data port or its USB port.
      const registry = validate(REGISTRY); // the route always holds a validated registry (ports defaulted to null)
      assert.equal(unassigned(/** @type {any} */ (DEVICE), registry), true);
      assert.equal(unassigned(/** @type {any} */ ({ ...DEVICE, imei: '490154203237518' }), registry), false);
      assert.equal(unassigned(/** @type {any} */ ({ ...DEVICE, usb_port: '1-1' }), registry), false);
      assert.equal(unassigned(/** @type {any} */ ({ ...DEVICE, imei: null, usb_port: null }), registry), true);
    } finally {
      await h.stop();
    }
  });

  test('without a registry the overview is empty but still answers the health strip', async () => {
    const h = await harness({ registry: null });
    try {
      const { cookie } = await h.login();
      const body = (await h.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).json();
      assert.deepEqual([body.modems, body.unassigned, body.registry.valid], [[], [], true]);
      assert.equal(body.health.status, 'ok');
    } finally {
      await h.stop();
    }
  });
});
