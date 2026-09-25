// @ts-check
// Contract tests for the modem routes: the list, changes sent to registry-apply with the file's hash, refusals before
// anything is enqueued, and device actions answered with 202 and their operation.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, test } from 'node:test';
import { uiState } from '../src/devices/state.js';
import { harness, MODEM, REGISTRY, snapshot } from './http-harness.js';

/** A state row as devices/state.js holds it in memory, with the device state the routes ask for. */
const row = (/** @type {Partial<any>} */ fields = {}) => ({
  modem_id: 'gsm1', state: 'ready', driver_state: 'Free', gsm_reg: 'Registered', rssi: 21, provider: 'A1', number: '+375290000001',
  data_tty: '/dev/ttyUSB2', usb_port: '1-1', observed_at: Date.now(),
  detail: { listed: true, current: 'start', desired: 'start', flapping: false, imsi: '257010000000001', model: 'EC25', firmware: 'x',
    calls: 0, disconnects: 0, reason: null, forwarding: { verified: true, outcome: 'ok', enabled: true, number: '+375290000002', observed_at: 17 } },
  ...fields,
});

/** @param {Map<string, any>} rows */
const deviceState = (rows) => {
  const seen = /** @type {const} */ ([{ usb_port: '1-1', imei: '490154203237518', present: 1 }]);
  return { states: () => rows, stateOf: (/** @type {any} */ modem) => uiState(modem, rows.get(modem.id) ?? null, seen, { now: Date.now() }) };
};

const NEW = { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true, usb_port: '1-2' };

describe('http modem routes', () => {
  test('GET lists the registry modems with the state derived now, and one by id; an unknown id is 404', async () => {
    const rows = new Map([['gsm1', row()]]);
    const h = await harness({ devices: deviceState(rows) });
    try {
      const { cookie } = await h.login();
      const before = snapshot(h.db);
      const body = (await h.app.inject({ method: 'GET', url: '/api/modems', headers: { cookie } })).json();
      assert.equal(body.modems.length, 1);
      assert.deepEqual([body.modems[0].id, body.modems[0].state, body.modems[0].ring], ['gsm1', 'ready', ['596']]);
      assert.deepEqual([body.registry.present, body.registry.hash], [true, h.onDisk().hash]);

      const one = await h.app.inject({ method: 'GET', url: '/api/modems/gsm1', headers: { cookie } });
      assert.equal(one.statusCode, 200);
      assert.deepEqual([one.json().modem.imei, one.json().modem.usb_port, one.json().modem.incoming_context], ['490154203237518', '1-1', null]);

      const missing = await h.app.inject({ method: 'GET', url: '/api/modems/nosuch', headers: { cookie } });
      assert.deepEqual([missing.statusCode, missing.json().error], [404, 'no modem nosuch in config/aster.yaml']);
      const bad = await h.app.inject({ method: 'GET', url: '/api/modems/NOT-AN-ID', headers: { cookie } });
      assert.equal(bad.statusCode, 400, 'the id pattern is checked before the registry is read');
      assert.equal(snapshot(h.db), before, 'a GET writes nothing');

      // The UI state is derived per request, not read from the row: an observation that has gone stale is `unverified`.
      rows.set('gsm1', row({ observed_at: Date.now() - 45_000 }));
      const stale = await h.app.inject({ method: 'GET', url: '/api/modems', headers: { cookie } });
      assert.equal(stale.json().modems[0].state, 'unverified', 'the row still says ready; 45 s without an observation does not');

      // A registry that cannot be read at all is a failure, not "invalid": the 409 would tell the admin to fix the wrong thing.
      chmodSync(h.paths.registry, 0o000);
      const unreadable = await h.app.inject({ method: 'GET', url: '/api/modems', headers: { cookie } });
      chmodSync(h.paths.registry, 0o644);
      assert.equal(unreadable.statusCode, 500);
      assert.match(unreadable.json().error, /^the controller failed to answer: cannot read registry /);
    } finally {
      await h.stop();
    }
  });

  test('GET /api/modems/:id/driver-error answers the newest error the driver logged for the modem, or null', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const get = async (/** @type {string} */ id) => {
        const response = await h.app.inject({ method: 'GET', url: `/api/modems/${id}/driver-error`, headers: { cookie } });
        return [response.statusCode, response.json()];
      };
      assert.deepEqual(await get('gsm1'), [200, { modem_id: 'gsm1', error: null }], 'no log yet');
      mkdirSync(dirname(h.paths.asteriskLog), { recursive: true });
      writeFileSync(h.paths.asteriskLog, '[2026-09-24 19:12:36] ERROR[1296] at_response.c: [gsm1] Getting IMSI number failed\n');
      assert.deepEqual(await get('gsm1'), [200, { modem_id: 'gsm1',
        error: { at: Date.UTC(2026, 8, 24, 19, 12, 36), level: 'ERROR', text: 'Getting IMSI number failed', count: 1 } }]);
      assert.equal((await get('gsm9'))[0], 404);
    } finally {
      await h.stop();
    }
  });

  test('before install.sh has written config/aster.yaml the list is empty and an assign creates the file', async () => {
    const h = await harness({ registry: null });
    try {
      const { cookie } = await h.login();
      const body = (await h.app.inject({ method: 'GET', url: '/api/modems', headers: { cookie } })).json();
      assert.deepEqual([body.modems, body.registry], [[], { present: false, hash: null }], 'a file that is not there yet is not an error');
      const response = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie }, payload: { ...NEW, ring: [] } });
      assert.equal(response.statusCode, 201);
      assert.equal(/** @type {any} */ (h.applies[0]).base_hash, null, 'nothing to compare against, so no base hash');
      assert.deepEqual(h.onDisk().registry.modems.map((modem) => modem.id), ['gsm2']);
    } finally {
      await h.stop();
    }
  });

  test('POST assigns a device: one registry-apply with the whole registry and the file hash, then 201 with the modem', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const base = h.onDisk().hash;
      const response = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie }, payload: NEW });
      assert.equal(response.statusCode, 201);
      assert.deepEqual([response.json().ok, response.json().operation.status], [true, 'done']);
      assert.deepEqual([response.json().modem.id, response.json().modem.driver, response.json().modem.state], ['gsm2', 'dongle', 'unverified']);
      assert.equal(h.applies.length, 1);
      const params = /** @type {any} */ (h.applies[0]);
      assert.deepEqual([params.base_hash, params.force], [base, false]);
      assert.deepEqual(params.registry.modems.map((/** @type {any} */ m) => m.id), ['gsm1', 'gsm2']);
      assert.equal(params.registry.phones.length, 1, 'the rest of the registry goes through unchanged');
      assert.deepEqual(h.onDisk().registry.modems[1]?.imei, NEW.imei);
    } finally {
      await h.stop();
    }
  });

  test('assigning gsm1 or gsm2 links its internal-only starter phones in the same apply, unless the body names a ring group', async () => {
    const phone = (/** @type {string} */ number, /** @type {string | null} */ outbound = null) => ({ number, secret: number, outbound });
    const h = await harness({
      registry: {
        version: 1,
        modems: [{ id: 'gsm3', driver: 'dongle', imei: '356938035643817', enabled: true }],
        phones: [phone('501'), phone('504'), phone('505', 'gsm3'), phone('506'), phone('507'), phone('508'), phone('511')],
      },
    });
    try {
      const { cookie } = await h.login();
      const gsm1 = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie },
        payload: { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true } });
      assert.equal(gsm1.statusCode, 201);
      assert.deepEqual(gsm1.json().modem.ring, ['504', '506', '507', '508'], 'the phone that dials out through gsm3 is not taken over');
      assert.equal(h.applies.length, 1, 'the modem and its phones are one registry-apply');
      const outbound = () => Object.fromEntries(h.onDisk().registry.phones.map((entry) => [entry.number, entry.outbound]));
      assert.deepEqual(outbound(), { 501: null, 504: 'gsm1', 505: 'gsm3', 506: 'gsm1', 507: 'gsm1', 508: 'gsm1', 511: null });

      const gsm2 = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie },
        payload: { ...NEW, ring: [] } });
      assert.equal(gsm2.statusCode, 201);
      assert.deepEqual(gsm2.json().modem.ring, [], 'a ring group in the body is the admin\'s choice');
      assert.equal(outbound()['511'], null);
    } finally {
      await h.stop();
    }
  });

  test('a duplicate id, IMEI or USB port is 409 and enqueues nothing; an invalid modem is 400 with the registry problems', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const before = { hash: h.onDisk().hash, rows: snapshot(h.db) };
      for (const [payload, message] of /** @type {const} */ ([
        [{ ...NEW, id: 'gsm1' }, /already has that id/],
        [{ ...NEW, imei: MODEM.imei }, /already has that IMEI/],
        [{ ...NEW, usb_port: '1-1' }, /already has that USB port/],
      ])) {
        const response = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie }, payload });
        assert.equal(response.statusCode, 409, JSON.stringify(payload));
        assert.match(response.json().error, message);
      }
      // The registry itself decides what is valid: UAC audio is quectel only, and a ring group names phones that exist.
      const invalid = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie }, payload: { ...NEW, uac: true } });
      assert.equal(invalid.statusCode, 400);
      assert.match(invalid.json().error, /the change would make the registry invalid: 1 problem/);
      assert.equal(invalid.json().problems[0].path, 'modems[1].uac');
      const ringing = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie }, payload: { ...NEW, ring: ['700'] } });
      assert.equal(ringing.statusCode, 400);
      assert.match(ringing.json().problems[0].message, /phone "700" is not in phones/);

      for (const payload of [{ ...NEW, id: 'GSM2' }, { ...NEW, imei: '123' }, { ...NEW, driver: 'huawei' }, { ...NEW, nonsense: 1 },
        { id: 'gsm2' }, { ...NEW, ring_timeout: 0 }, { ...NEW, ports: { data: '/dev/ttyUSB0' } }]) {
        const response = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie }, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.ok(response.json().error.startsWith('invalid request:'), response.json().error);
      }
      assert.deepEqual([h.applies.length, h.onDisk().hash, snapshot(h.db)], [0, before.hash, before.rows], 'nothing was enqueued or written');
    } finally {
      await h.stop();
    }
  });

  test('PUT changes the fields it is given and keeps the rest; the id is not one of them', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const response = await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie },
        payload: { enabled: false, group: 7, recipients: ['-100200300'] } });
      assert.equal(response.statusCode, 200);
      const modem = /** @type {any} */ (h.applies[0]).registry.modems[0];
      assert.deepEqual([modem.enabled, modem.group, modem.recipients], [false, 7, ['-100200300']]);
      assert.deepEqual([modem.imei, modem.usb_port, modem.ring], [MODEM.imei, '1-1', ['596']], 'the fields not named are untouched');
      assert.deepEqual([response.json().modem.group, response.json().modem.enabled], [7, false]);
      assert.equal(Object.hasOwn(response.json().modem, 'label'), false, 'a modem is named by its id');

      const numbered = await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie }, payload: { phone_number: '+1234567890' } });
      assert.equal(numbered.statusCode, 200);
      assert.equal(/** @type {any} */ (h.applies[1]).registry.modems[0].phone_number, '+1234567890', 'the number entered by hand');
      assert.equal(numbered.json().modem.phone_number, '+1234567890');
      for (const phone_number of ['1234567890', '+12345', 1234567890]) {
        const refused = await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie }, payload: { phone_number } });
        assert.equal(refused.statusCode, 400, JSON.stringify(phone_number));
      }
      const cleared = await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie }, payload: { phone_number: null } });
      assert.equal(cleared.statusCode, 200);
      assert.equal(/** @type {any} */ (h.applies[2]).registry.modems[0].phone_number, null);

      const renamed = await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie }, payload: { id: 'gsm9' } });
      assert.equal(renamed.statusCode, 400, 'the id names the device, the contexts and the globals: a rename is a delete and an add');
      const empty = await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie }, payload: {} });
      assert.equal(empty.statusCode, 400);
      const labelled = await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie }, payload: { label: 'x' } });
      assert.equal(labelled.statusCode, 400, 'a modem has no label');
      const missing = await h.app.inject({ method: 'PUT', url: '/api/modems/nosuch', headers: { cookie }, payload: { enabled: false } });
      assert.equal(missing.statusCode, 404);
      assert.equal(h.applies.length, 3);
    } finally {
      await h.stop();
    }
  });

  test('DELETE removes the modem; a phone that dials out through it is 409 first', async () => {
    const h = await harness({ registry: { ...REGISTRY, phones: [{ number: '596', secret: 'sip-secret', outbound: 'gsm1' }], modems: [{ ...MODEM, ring: [] }] } });
    try {
      const { cookie } = await h.login();
      const refused = await h.app.inject({ method: 'DELETE', url: '/api/modems/gsm1', headers: { cookie } });
      assert.equal(refused.statusCode, 409);
      assert.match(refused.json().error, /phone 596 dials out through modem gsm1/);
      assert.equal(h.applies.length, 0);

      await h.app.inject({ method: 'PUT', url: '/api/phones/596', headers: { cookie }, payload: { outbound: null } });
      const response = await h.app.inject({ method: 'DELETE', url: '/api/modems/gsm1', headers: { cookie } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual([response.json().ok, response.json().modem], [true, null]);
      assert.deepEqual(/** @type {any} */ (h.applies[1]).registry.modems, [], 'the apply carries the registry without it, and reconcile sends the driver Remove');
      assert.equal(h.onDisk().registry.modems.length, 0);
    } finally {
      await h.stop();
    }
  });

  test('a registry-apply that fails is 409 with the operation, and one still running is 202', async () => {
    const h = await harness({ timing: { applyWaitMs: 60 } });
    try {
      const { cookie } = await h.login();
      const before = h.onDisk().hash;
      h.applyMode('fail');
      const failed = await h.app.inject({ method: 'POST', url: '/api/modems', headers: { cookie }, payload: NEW });
      assert.equal(failed.statusCode, 409);
      assert.deepEqual([failed.json().ok, failed.json().error, failed.json().operation.status], [false, 'the reload failed', 'failed']);
      assert.equal(h.onDisk().hash, before, 'the registry is written by the operation, so a failed one changed nothing');

      h.applyMode('hang');
      const running = await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie }, payload: { group: 3 } });
      assert.equal(running.statusCode, 202);
      assert.match(running.json().error, /still being applied after 60 ms/);
      assert.equal(running.json().operation.status, 'running');
      assert.equal(h.runner.get(running.json().operation.id)?.status, 'running');
    } finally {
      h.release();
      await h.stop();
    }
  });

  test('the device actions enqueue their kind with the modem and answer 202 without waiting', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      for (const [verb, kind] of /** @type {const} */ ([['start', 'modem-start'], ['stop', 'modem-stop'], ['restart', 'modem-restart'],
        ['reset', 'modem-reset'], ['remap', 'remap']])) {
        const response = await h.app.inject({ method: 'POST', url: `/api/modems/gsm1/${verb}`, headers: { cookie }, payload: verb === 'stop' ? { when: 'now' } : {} });
        assert.equal(response.statusCode, 202, verb);
        assert.deepEqual([response.json().operation.kind, response.json().operation.status], [kind, 'queued'], verb);
        const op = h.runner.get(response.json().operation.id);
        assert.deepEqual([op?.kind, op?.modem_id, op?.actor], [kind, 'gsm1', 'admin'], verb);
      }
      assert.deepEqual(h.opsOf('modem-stop')[0]?.params, { when: 'now' });
      assert.deepEqual(h.opsOf('modem-start')[0]?.params, {}, 'without `when` the operation applies the drivers\' default');
      assert.equal(h.opsOf('remap')[0]?.params.trigger, 'admin');

      const badWhen = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/stop', headers: { cookie }, payload: { when: 'immediately' } });
      assert.equal(badWhen.statusCode, 400);
      const missing = await h.app.inject({ method: 'POST', url: '/api/modems/nosuch/start', headers: { cookie }, payload: {} });
      assert.equal(missing.statusCode, 404);
    } finally {
      await h.stop();
    }
  });

  test('forwarding, AT, USSD and the SIM number: GET is the last query, POST enqueues the operation the driver modules expect', async () => {
    const h = await harness({ devices: deviceState(new Map([['gsm1', row()]])) });
    try {
      const { cookie } = await h.login();
      const forwarding = await h.app.inject({ method: 'GET', url: '/api/modems/gsm1/forwarding', headers: { cookie } });
      assert.deepEqual(forwarding.json(), { modem_id: 'gsm1', forwarding: { verified: true, outcome: 'ok', enabled: true, number: '+375290000002', observed_at: 17 } });

      const set = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/forwarding', headers: { cookie }, payload: { action: 'set', number: '+1234567890' } });
      assert.equal(set.statusCode, 202);
      assert.deepEqual(h.opsOf('forwarding')[0]?.params, { action: 'set', number: '+1234567890' });
      const noReply = { action: 'set', reason: 'no_reply', number: '+1234567890', time: 20 };
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/forwarding', headers: { cookie }, payload: noReply })).statusCode, 202);
      assert.deepEqual(h.opsOf('forwarding')[1]?.params, noReply);
      for (const [payload, status] of /** @type {const} */ ([[{ action: 'set' }, 400], [{ action: 'query', number: '+1234567890' }, 400],
        [{ action: 'set', number: '1234567890' }, 400], [{ action: 'nonsense' }, 400], [{ action: 'query' }, 202],
        [{ action: 'query', reason: 'all' }, 202], [{ action: 'disable', reason: 'all' }, 400], [{ action: 'enable', reason: 'sometimes' }, 400],
        [{ action: 'set', reason: 'busy', number: '+1234567890', time: 20 }, 400], [{ action: 'set', reason: 'no_reply', number: '+1234567890', time: 7 }, 400],
        [{ action: 'enable', reason: 'no_reply', time: 20 }, 400], [{ action: 'set', reason: 'conditional', number: '+1234567890', time: 30 }, 202]])) {
        const response = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/forwarding', headers: { cookie }, payload });
        assert.equal(response.statusCode, status, JSON.stringify(payload));
      }

      const at = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/at', headers: { cookie }, payload: { command: 'AT+CSQ', timeout: 5 } });
      assert.equal(at.statusCode, 202);
      assert.deepEqual(h.opsOf('at')[0]?.params, { command: 'AT+CSQ', timeout: 5 });
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/at', headers: { cookie }, payload: { command: 'AT', timeout: 61 } })).statusCode, 400);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/at', headers: { cookie }, payload: { command: '' } })).statusCode, 400);

      const ussd = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/ussd', headers: { cookie }, payload: { code: '*100#' } });
      assert.equal(ussd.statusCode, 202);
      assert.deepEqual(h.opsOf('ussd')[0]?.params, { code: '*100#' });
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/ussd', headers: { cookie }, payload: { code: 'AT+CSQ' } })).statusCode, 400);
      assert.equal(h.opsOf('ussd').length, 1);

      const sim = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/sim-number', headers: { cookie }, payload: { number: '+1234567890' } });
      assert.equal(sim.statusCode, 202);
      assert.equal(sim.json().operation.kind, 'sim-number');
      assert.deepEqual(h.opsOf('sim-number')[0]?.params, { number: '+1234567890' });
      for (const payload of [{}, { number: '1234567890' }, { number: '+12345' }, { number: '+1234567890', storage: 'SM' }]) {
        const response = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/sim-number', headers: { cookie }, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/modems/gsm9/sim-number', headers: { cookie }, payload: { number: '+1234567890' } })).statusCode, 404);
      assert.equal(h.opsOf('sim-number').length, 1);

      const cancel = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/ussd/cancel', headers: { cookie }, payload: {} });
      assert.equal(cancel.statusCode, 202);
      assert.equal(cancel.json().operation.kind, 'ussd-cancel');
      assert.deepEqual(h.opsOf('ussd-cancel')[0]?.params, {});
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/ussd/cancel', headers: { cookie }, payload: { code: '1' } })).statusCode, 400);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/modems/gsm9/ussd/cancel', headers: { cookie }, payload: {} })).statusCode, 404);
      assert.equal(h.opsOf('ussd-cancel').length, 1);
    } finally {
      await h.stop();
    }
  });
});
