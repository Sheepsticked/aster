// @ts-check
// Contract tests for GET /api/connections: the phones' registrations and calls from Asterisk, and an answer that says so when
// Asterisk cannot be asked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { harness, snapshot } from './http-harness.js';
import { packetsOf } from './devices-fake.js';

/** @param {string} name */
const fixture = (name) => packetsOf(readFileSync(new URL(`./fixtures/ami/${name}`, import.meta.url), 'utf8'))
  .filter((packet) => packet.get('ActionID') === 'ami-2' && packet.has('Event') && !String(packet.get('Event')).endsWith('Complete'));
/** Before the captured registration expires. */
const NOW = 1_790_011_900_000;

describe('http connection routes', () => {
  test('GET answers each phone with its registrations and calls; it needs a session and writes nothing', async () => {
    const h = await harness({ now: () => NOW });
    try {
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/connections' })).statusCode, 401);
      const { cookie } = await h.login();
      const ami = /** @type {import('./devices-fake.js').FakeDriverAmi} */ (h.ami);
      ami.onList = (name) => (name === 'PJSIPShowContacts' ? fixture('pjsip-contacts.txt') : name === 'CoreShowChannels' ? fixture('core-show-channels.txt') : undefined);
      const before = snapshot(h.db);
      const response = await h.app.inject({ method: 'GET', url: '/api/connections', headers: { cookie } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        available: true,
        error: null,
        phones: [{
          number: '599',
          contacts: [{ address: '172.17.0.1', port: 47603, user_agent: 'aster-sorcery-test', expires_at: 1_790_011_952_000, reachable: null, rtt_ms: null }],
          calls: [{ state: 'ringing', number: '+375290000001', name: 'Mobile', since: NOW - 1000 }],
        }],
      });
      assert.equal(snapshot(h.db), before, 'a GET writes nothing');
    } finally {
      await h.stop();
    }
  });

  test('available: false with the reason when AMI is not up, not configured, or the list fails', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const ami = /** @type {import('./devices-fake.js').FakeDriverAmi} */ (h.ami);
      ami.onList = () => {
        throw new Error('AMI PJSIPShowContacts (ami-9) got no response within 5000 ms');
      };
      const get = async () => (await h.app.inject({ method: 'GET', url: '/api/connections', headers: { cookie } })).json();
      assert.deepEqual(await get(), { available: false, error: 'AMI PJSIPShowContacts (ami-9) got no response within 5000 ms', phones: [] });
      ami.up = false;
      assert.deepEqual(await get(), { available: false, error: 'Asterisk is not answering (AMI connecting)', phones: [] });
    } finally {
      await h.stop();
    }

    const without = await harness({ ami: false });
    try {
      const { cookie } = await without.login();
      const body = (await without.app.inject({ method: 'GET', url: '/api/connections', headers: { cookie } })).json();
      assert.deepEqual(body, { available: false, error: 'AMI is not configured', phones: [] });
    } finally {
      await without.stop();
    }
  });
});
