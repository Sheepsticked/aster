// @ts-check
// Tests for src/at/network.js: the answer parsers and the reader, with a scripted modem, a hand-set clock and device states
// the test changes between passes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DONGLE_QUERY, QUECTEL_QUERY, createNetworkReader, dongleNetwork, generationOf, quectelNetwork } from '../src/at/network.js';
import { validate } from '../src/config/registry.js';
import { FakeDriverAmi } from './devices-fake.js';

const REGISTRY = validate({ version: 1, modems: [
  { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true },
  { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true },
  { id: 'gsm3', driver: 'quectel', imei: '000000000000009', enabled: false },
], phones: [] });
const LTE = '+QNWINFO: "FDD LTE","00101","LTE BAND 3",1300';
const HSPA = '+QNWINFO: "HSPA+","00101","WCDMA 2100",10700';

/** @param {{ answers?: Record<string, { lines?: string[], result?: 'OK' | 'ERROR' | 'TIMEOUT' }> }} [options] */
function harness({ answers = {} } = {}) {
  const ami = new FakeDriverAmi();
  for (const modem of REGISTRY.modems) ami.addDevice(modem.id, modem.driver, { state: 'Free', current: 'start', desired: 'start' });
  /** what each modem answers, changed by the tests @type {Record<string, { lines?: string[], result?: 'OK' | 'ERROR' | 'TIMEOUT' }>} */
  const script = { gsm1: { lines: [LTE] }, gsm2: { lines: ['^SYSINFO:2,3,0,5,1,,9'] }, ...answers };
  ami.at = (device) => script[device];
  let clock = 1_000_000;
  /** the device state rows the reader looks at @type {Map<string, any>} */
  const rows = new Map(REGISTRY.modems.map((modem) => [modem.id, { driver_state: modem.enabled ? 'Free' : 'Radio off', gsm_reg: 'Registered, home network',
    detail: { listed: true, restarting: false, cell: '0001/0000001' } }]));
  /** @type {string[]} */
  const changes = [];
  const reader = createNetworkReader({ ami: /** @type {any} */ (ami), registry: () => REGISTRY, states: () => rows, now: () => clock,
    onChange: (id) => changes.push(id), timing: { graceMs: 50, actionTimeoutMs: 500, timeoutS: 1 } });
  return {
    ami, script, rows, changes, reader,
    /** @param {number} ms */
    tick: (ms) => { clock += ms; },
    /** @param {string} id @param {Record<string, unknown>} fields */
    set: (id, fields) => { rows.set(id, { ...rows.get(id), ...fields }); },
    sent: () => ami.atCommands.map((entry) => `${entry.device} ${entry.command}`),
  };
}

describe('network parsers', () => {
  test('AT+QNWINFO: technology, generation and band; no service; an answer without the line', () => {
    assert.deepEqual(quectelNetwork([LTE], 5), { service: true, generation: '4G', tech: 'FDD LTE', band: 'LTE band 3', observed_at: 5 });
    assert.deepEqual(quectelNetwork([HSPA], 5), { service: true, generation: '3G', tech: 'HSPA+', band: 'WCDMA 2100', observed_at: 5 });
    assert.deepEqual(quectelNetwork(['+QNWINFO: "EDGE","00101","GSM 900",62'], 5), { service: true, generation: '2G', tech: 'EDGE', band: 'GSM 900', observed_at: 5 });
    assert.deepEqual(quectelNetwork(['+QNWINFO: No Service'], 5), { service: false, generation: null, tech: null, band: null, observed_at: 5 });
    assert.equal(quectelNetwork(['OK'], 5), null);
  });

  test('AT^SYSINFO: the submode names the technology, the mode when there is none; no service', () => {
    assert.deepEqual(dongleNetwork(['^SYSINFO:2,3,0,5,1,,9'], 5), { service: true, generation: '3G', tech: 'HSPA+', band: null, observed_at: 5 });
    assert.deepEqual(dongleNetwork(['^SYSINFO: 2,3,0,3,1,,3'], 5), { service: true, generation: '2G', tech: 'EDGE', band: null, observed_at: 5 });
    assert.deepEqual(dongleNetwork(['^SYSINFO:2,3,0,7,1,,4'], 5), { service: true, generation: '3G', tech: 'WCDMA', band: null, observed_at: 5 });
    assert.deepEqual(dongleNetwork(['^SYSINFO:2,3,0,5,1'], 5), { service: true, generation: '3G', tech: 'WCDMA', band: null, observed_at: 5 });
    assert.equal(dongleNetwork(['^SYSINFO:0,0,0,0,1,,0'], 5)?.service, false);
    assert.equal(dongleNetwork(['^SYSINFO:2,3,0,3,1,,0'], 5)?.tech, 'GSM');
    assert.equal(dongleNetwork([], 5), null);
  });

  test('generationOf the technology names the modems use', () => {
    for (const [tech, generation] of /** @type {const} */ ([['FDD LTE', '4G'], ['TDD LTE', '4G'], ['eMTC', '4G'], ['WCDMA', '3G'], ['HSDPA', '3G'], ['HSPA+', '3G'],
      ['TD-SCDMA', '3G'], ['GSM', '2G'], ['GPRS', '2G'], ['EDGE', '2G'], ['NR5G-SA', '5G'], ['something', null]])) assert.equal(generationOf(tech), generation, tech);
  });
});

describe('network reader', () => {
  test('reads each connected modem once with its driver\'s command, then nothing until a reading is due', async () => {
    const h = harness();
    await h.reader.tick();
    assert.deepEqual(h.sent(), [`gsm1 ${QUECTEL_QUERY}`, `gsm2 ${DONGLE_QUERY}`], 'the disabled gsm3 is not asked');
    assert.equal(h.reader.get('gsm1')?.band, 'LTE band 3');
    assert.equal(h.reader.get('gsm2')?.tech, 'HSPA+');
    assert.equal(h.reader.get('gsm3'), null);
    assert.deepEqual(h.changes, ['gsm1', 'gsm2']);
    h.tick(60_000);
    await h.reader.tick();
    assert.equal(h.sent().length, 2);
    // old enough: read again; the same answer is no change
    h.tick(30 * 60_000);
    await h.reader.tick();
    assert.equal(h.sent().length, 4);
    assert.deepEqual(h.changes, ['gsm1', 'gsm2']);
  });

  test('no read in a call: the reading stays, and after the call it is renewed once the state settled', async () => {
    const h = harness();
    await h.reader.tick();
    h.set('gsm1', { driver_state: 'Active' });
    h.script.gsm1 = { lines: [HSPA] };
    h.tick(20_000);
    await h.reader.tick();
    assert.equal(h.sent().length, 2);
    assert.equal(h.reader.get('gsm1')?.generation, '4G');
    h.set('gsm1', { driver_state: 'Free' });
    h.tick(1_000);
    await h.reader.tick();
    assert.equal(h.sent().length, 2, 'not before settleMs');
    h.tick(10_000);
    await h.reader.tick();
    assert.deepEqual(h.sent().slice(2), [`gsm1 ${QUECTEL_QUERY}`]);
    assert.equal(h.reader.get('gsm1')?.generation, '3G');
    assert.deepEqual(h.changes, ['gsm1', 'gsm2', 'gsm1']);
  });

  test('a cell change is read after it settled; a modem that drops off loses its reading and is read when it is back', async () => {
    const h = harness();
    await h.reader.tick();
    h.set('gsm2', { detail: { listed: true, restarting: false, cell: '0001/0000002' } });
    h.script.gsm2 = { lines: ['^SYSINFO:2,3,0,3,1,,3'] };
    h.tick(1_000);
    await h.reader.tick();
    h.tick(10_000);
    await h.reader.tick();
    assert.equal(h.reader.get('gsm2')?.generation, '2G');
    h.set('gsm1', { driver_state: 'Not connected' });
    await h.reader.tick();
    assert.equal(h.reader.get('gsm1'), null);
    assert.deepEqual(h.changes, ['gsm1', 'gsm2', 'gsm2', 'gsm1']);
    h.set('gsm1', { driver_state: 'Free' });
    await h.reader.tick();
    assert.equal(h.reader.get('gsm1')?.generation, '4G');
  });

  test('a page asking renews a reading older than a minute, not a fresh one; nothing is read while Aster restarts the modem', async () => {
    const h = harness();
    await h.reader.tick();
    h.tick(30_000);
    h.reader.want('gsm1');
    await h.reader.tick();
    assert.equal(h.sent().length, 2);
    h.tick(31_000);
    h.reader.want('gsm1');
    await h.reader.tick();
    assert.deepEqual(h.sent().slice(2), [`gsm1 ${QUECTEL_QUERY}`]);
    h.set('gsm2', { detail: { listed: true, restarting: true, cell: '0001/0000001' } });
    h.tick(30 * 60_000);
    await h.reader.tick();
    assert.ok(!h.sent().slice(3).includes(`gsm2 ${DONGLE_QUERY}`));
  });

  test('a modem without the command shows nothing and is not asked again soon; after an AT timeout the reader pauses for that modem', async () => {
    const h = harness({ answers: { gsm1: { result: 'ERROR' }, gsm2: { result: 'TIMEOUT' } } });
    await h.reader.tick();
    assert.equal(h.reader.get('gsm1'), null);
    assert.equal(h.reader.get('gsm2'), null);
    h.tick(10 * 60_000);
    await h.reader.tick();
    assert.equal(h.sent().length, 2);
    h.tick(51 * 60_000);
    await h.reader.tick();
    assert.deepEqual(h.sent().slice(2), [`gsm1 ${QUECTEL_QUERY}`, `gsm2 ${DONGLE_QUERY}`]);
  });
});
