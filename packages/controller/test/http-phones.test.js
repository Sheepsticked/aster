// @ts-check
// Contract tests for the phone and scan routes: CRUD through registry-apply, the conflicts refused before enqueueing, and
// the scan (POST answers 202, GET the last result without claimed devices).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { harness, MODEM, REGISTRY, snapshot } from './http-harness.js';

const NEW = { number: '597', label: 'Kitchen', secret: 'another-secret' };
const DEVICE = { found_by: ['quectel'], data_tty: '/dev/ttyUSB6', audio_tty: '/dev/ttyUSB5', imei: '356938031234560', imsi: null,
  usb_port: '1-2', vendor: '12d1', product: '1436', suggested_driver: 'dongle', registered: null };

describe('http phone routes', () => {
  test('GET lists the phones with the modems that ring them, and one by number', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const before = snapshot(h.db);
      const body = (await h.app.inject({ method: 'GET', url: '/api/phones', headers: { cookie } })).json();
      assert.deepEqual(body.phones, [{ number: '596', label: 'Desk', secret: 'sip-secret', outbound: null, context: null,
        direct_media: false, rings_for: ['gsm1'] }]);
      assert.equal(body.registry.hash, h.onDisk().hash);

      const one = await h.app.inject({ method: 'GET', url: '/api/phones/596', headers: { cookie } });
      assert.deepEqual([one.statusCode, one.json().phone.label], [200, 'Desk']);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/phones/599', headers: { cookie } })).statusCode, 404);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/phones/12', headers: { cookie } })).statusCode, 400, 'a number is 3 to 6 digits');
      assert.equal(snapshot(h.db), before, 'a GET writes nothing');
    } finally {
      await h.stop();
    }
  });

  test('POST adds a phone through one registry-apply; a number that exists is 409 and an invalid body 400', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const base = h.onDisk().hash;
      const response = await h.app.inject({ method: 'POST', url: '/api/phones', headers: { cookie }, payload: NEW });
      assert.equal(response.statusCode, 201);
      assert.deepEqual([response.json().ok, response.json().phone.number, response.json().phone.rings_for], [true, '597', []]);
      assert.deepEqual([/** @type {any} */ (h.applies[0]).base_hash, /** @type {any} */ (h.applies[0]).registry.phones.length], [base, 2]);
      assert.equal(h.onDisk().registry.phones[1]?.secret, 'another-secret');

      const twice = await h.app.inject({ method: 'POST', url: '/api/phones', headers: { cookie }, payload: NEW });
      assert.deepEqual([twice.statusCode, twice.json().error], [409, 'phone 597 already exists']);
      for (const payload of [{ number: '598' }, { ...NEW, number: '5' }, { ...NEW, secret: 'has space' }, { ...NEW, nonsense: 1 },
        { ...NEW, number: '598', outbound: 'nosuch' }]) {
        const bad = await h.app.inject({ method: 'POST', url: '/api/phones', headers: { cookie }, payload });
        assert.equal(bad.statusCode, 400, JSON.stringify(payload));
      }
      assert.equal(h.applies.length, 1, 'only the one that was accepted');
    } finally {
      await h.stop();
    }
  });

  test('PUT changes fields, DELETE removes; a phone a modem rings cannot be deleted', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const changed = await h.app.inject({ method: 'PUT', url: '/api/phones/596', headers: { cookie }, payload: { label: 'Front desk', direct_media: true } });
      assert.equal(changed.statusCode, 200);
      const phone = /** @type {any} */ (h.applies[0]).registry.phones[0];
      assert.deepEqual([phone.label, phone.direct_media, phone.secret], ['Front desk', true, 'sip-secret']);
      assert.equal((await h.app.inject({ method: 'PUT', url: '/api/phones/596', headers: { cookie }, payload: { number: '598' } })).statusCode, 400);
      assert.equal((await h.app.inject({ method: 'PUT', url: '/api/phones/599', headers: { cookie }, payload: { label: 'x' } })).statusCode, 404);

      const ringing = await h.app.inject({ method: 'DELETE', url: '/api/phones/596', headers: { cookie } });
      assert.equal(ringing.statusCode, 409);
      assert.match(ringing.json().error, /modem gsm1 rings phone 596/);

      await h.app.inject({ method: 'PUT', url: '/api/modems/gsm1', headers: { cookie }, payload: { ring: [] } });
      const removed = await h.app.inject({ method: 'DELETE', url: '/api/phones/596', headers: { cookie } });
      assert.deepEqual([removed.statusCode, removed.json().phone], [200, null]);
      assert.equal(h.onDisk().registry.phones.length, 0);
      assert.equal((await h.app.inject({ method: 'DELETE', url: '/api/phones/596', headers: { cookie } })).statusCode, 404);
    } finally {
      await h.stop();
    }
  });

  test('rings_for on POST and PUT puts the phone into exactly those ring lists, in the same registry-apply', async () => {
    const GSM2 = { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true, usb_port: '1-2', ring: [] };
    const h = await harness({ registry: { ...REGISTRY, modems: [MODEM, GSM2] } });
    try {
      const { cookie } = await h.login();
      const rings = () => h.onDisk().registry.modems.map((modem) => [modem.id, [...modem.ring]]);

      const added = await h.app.inject({ method: 'POST', url: '/api/phones', headers: { cookie }, payload: { ...NEW, rings_for: ['gsm1', 'gsm2'] } });
      assert.deepEqual([added.statusCode, added.json().phone.rings_for], [201, ['gsm1', 'gsm2']]);
      assert.equal(h.applies.length, 1, 'the phone and both ring lists are one registry-apply');
      assert.deepEqual(rings(), [['gsm1', ['596', '597']], ['gsm2', ['597']]]);

      // 596 moves from gsm1 to gsm2: taken out of one list, appended to the other, the other members keep their order.
      const moved = await h.app.inject({ method: 'PUT', url: '/api/phones/596', headers: { cookie }, payload: { rings_for: ['gsm2'] } });
      assert.deepEqual([moved.statusCode, moved.json().phone.rings_for, moved.json().phone.label], [200, ['gsm2'], 'Desk']);
      assert.deepEqual(rings(), [['gsm1', ['597']], ['gsm2', ['597', '596']]]);

      // A PUT without rings_for leaves the ring lists alone.
      await h.app.inject({ method: 'PUT', url: '/api/phones/596', headers: { cookie }, payload: { label: 'Front desk' } });
      assert.deepEqual(rings(), [['gsm1', ['597']], ['gsm2', ['597', '596']]]);

      // The phone's own dialog is enough to free it for a delete.
      await h.app.inject({ method: 'PUT', url: '/api/phones/596', headers: { cookie }, payload: { rings_for: [] } });
      assert.deepEqual(rings(), [['gsm1', ['597']], ['gsm2', ['597']]]);
      assert.equal((await h.app.inject({ method: 'DELETE', url: '/api/phones/596', headers: { cookie } })).statusCode, 200);

      const applies = h.applies.length;
      const unknown = await h.app.inject({ method: 'POST', url: '/api/phones', headers: { cookie }, payload: { ...NEW, number: '598', rings_for: ['gsm1', 'nosuch'] } });
      assert.deepEqual([unknown.statusCode, unknown.json().error], [400, 'modem nosuch is not in modems']);
      const unknownPut = await h.app.inject({ method: 'PUT', url: '/api/phones/597', headers: { cookie }, payload: { rings_for: ['gsm9'] } });
      assert.deepEqual([unknownPut.statusCode, unknownPut.json().error], [400, 'modem gsm9 is not in modems']);
      for (const rings_for of [['gsm1', 'gsm1'], 'gsm1', ['GSM1'], [1]]) {
        const bad = await h.app.inject({ method: 'PUT', url: '/api/phones/597', headers: { cookie }, payload: { rings_for } });
        assert.equal(bad.statusCode, 400, JSON.stringify(rings_for));
      }
      assert.equal(h.applies.length, applies, 'a refused rings_for enqueues nothing');
    } finally {
      await h.stop();
    }
  });

  test('a registry that does not parse is 409 with its problems on every phone route', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const { writeFileSync } = await import('node:fs');
      writeFileSync(h.paths.registry, 'version: 1\nmodems: []\nphones:\n  - number: 596\n');
      for (const [method, url] of /** @type {const} */ ([['GET', '/api/phones'], ['GET', '/api/phones/596'], ['POST', '/api/phones'],
        ['PUT', '/api/phones/596'], ['DELETE', '/api/phones/596'], ['GET', '/api/modems'], ['GET', '/api/modems/gsm1']])) {
        const payload = method === 'POST' ? NEW : method === 'PUT' ? { label: 'x' } : undefined;
        const response = await h.app.inject({ method, url, headers: { cookie }, payload });
        assert.equal(response.statusCode, 409, `${method} ${url}`);
        assert.match(response.json().error, /config\/aster\.yaml is invalid/);
        assert.ok(response.json().problems.length > 0);
      }
      assert.equal(h.applies.length, 0);
    } finally {
      await h.stop();
    }
  });
});

describe('http scan routes', () => {
  test('POST starts the scan operation; GET answers the last result without the devices a modem now owns', async () => {
    const scan = { at: 1_700_000_000_000, trigger: 'manual', devices: [DEVICE, { ...DEVICE, imei: MODEM.imei, usb_port: '1-1' }],
      unassigned: [DEVICE, { ...DEVICE, imei: MODEM.imei, usb_port: '1-1' }], errors: { quectel: null, dongle: 'no dongle' } };
    const h = await harness({ scan: { latest: () => scan } });
    try {
      const { cookie } = await h.login();
      const started = await h.app.inject({ method: 'POST', url: '/api/scan', headers: { cookie } });
      assert.equal(started.statusCode, 202);
      assert.deepEqual([started.json().operation.kind, started.json().operation.status], ['scan', 'queued']);
      assert.deepEqual(h.opsOf('scan')[0]?.params, { trigger: 'admin' });
      assert.equal(h.opsOf('scan')[0]?.modem_id, null, 'a scan belongs to no modem; it has its own queue');

      const latest = (await h.app.inject({ method: 'GET', url: '/api/scan/latest', headers: { cookie } })).json();
      assert.deepEqual([latest.scan.at, latest.scan.trigger, latest.scan.errors.dongle], [scan.at, 'manual', 'no dongle']);
      assert.equal(latest.scan.devices.length, 2, 'every device the scan found');
      assert.deepEqual(latest.scan.unassigned, [DEVICE], 'the one whose IMEI a modem claims is gone');
    } finally {
      await h.stop();
    }
  });

  test('without a scan yet, latest is null', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/scan/latest', headers: { cookie } })).json(), { scan: null });
    } finally {
      await h.stop();
    }
  });
});
