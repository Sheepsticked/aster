// @ts-check
// Tests for src/at/simnumber.js: the commands and answer parsers, and the operation through a real runner with a scripted SIM
// that keeps a selected phonebook and an own-number list.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createSimNumberOps, entryNumber, ownNumbers, selectCommand, storageOf, writeCommand } from '../src/at/simnumber.js';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi } from './devices-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-simnumber-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

const REGISTRY = validate({ version: 1, modems: [
  { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true },
  { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true },
], phones: [] });
const NUM = '+1234567890';
const WRITE = `AT+CPBW=1,"${NUM}",145`;

/** @param {{ storage?: string, locked?: boolean, connected?: boolean }} [options] */
function harness({ storage = 'SM', locked = false, connected = true } = {}) {
  const db = open(join(tmp, `sim-${++counter}.db`));
  migrate(db);
  const ami = new FakeDriverAmi();
  ami.addDevice('gsm1', 'quectel', connected ? { state: 'Free', current: 'start', desired: 'start' } : {});
  ami.addDevice('gsm2', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
  /** the SIM: the phonebook selected and its own-number entry 1 */
  const sim = { storage, own: /** @type {string | null} */ (null) };
  /** @type {Record<string, { lines?: string[], result?: 'OK' | 'ERROR' | 'TIMEOUT' | 'silent', error?: string }>} */
  const overrides = {};
  ami.at = (_device, command) => {
    if (overrides[command]) return overrides[command];
    if (command === 'AT+CPBS?') return { lines: [`+CPBS: "${sim.storage}",1,250`] };
    const select = /^AT\+CPBS="([A-Z]{2})"$/.exec(command);
    if (select) {
      sim.storage = select[1] ?? sim.storage;
      return {};
    }
    const write = /^AT\+CPBW=1,"(\+[0-9]+)",145$/.exec(command);
    if (write) {
      if (locked) return { result: 'ERROR', error: '+CME ERROR: SIM PIN2 required' };
      if (sim.storage === 'ON') sim.own = write[1] ?? null;
      return {};
    }
    if (command === 'AT+CPBR=1') return sim.storage === 'ON' && sim.own ? { lines: [`+CPBR: 1,"${sim.own}",145,""`] } : { result: 'ERROR', error: '+CME ERROR: not found' };
    if (command === 'AT+CNUM') return { lines: sim.own ? [`+CNUM: ,"${sim.own}",145`] : [] };
    return { result: 'ERROR', error: 'ERROR' };
  };
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
  createSimNumberOps({ registry: () => REGISTRY, timing: { graceMs: 50, actionTimeoutMs: 500, timeoutS: 1 } }).register(runner);
  runner.start();
  /** @param {Record<string, unknown>} params @param {string} [modemId] */
  const run = (params, modemId = 'gsm1') => runner.wait(runner.enqueue({ kind: 'sim-number', modemId, params, actor: 'admin' }));
  const commands = () => ami.atCommands.map((entry) => entry.command);
  return { ami, sim, overrides, run, commands, stop: async () => { await runner.stop(); db.close(); } };
}

describe('at sim-number', () => {
  test('the commands, and what they read from an answer', () => {
    assert.equal(selectCommand('ON'), 'AT+CPBS="ON"');
    assert.equal(writeCommand(NUM), WRITE);
    assert.equal(storageOf(['+CPBS: "SM",1,250']), 'SM');
    assert.equal(storageOf(['+CPBS: "ON",0,2']), 'ON');
    assert.equal(storageOf(['OK']), null);
    assert.equal(entryNumber([`+CPBR: 1,"${NUM}",145,""`]), NUM);
    assert.equal(entryNumber([`+CPBR: 2,"${NUM}",145,""`]), null, 'only entry 1');
    assert.deepEqual(ownNumbers([`+CNUM: ,"${NUM}",145`]), [NUM]);
    assert.deepEqual(ownNumbers([`+CNUM: "Subscriber Number","${NUM}",145`]), [NUM]);
    assert.deepEqual(ownNumbers(['+CNUM: "Subscriber Number","",145', '+CNUM: "Subscriber Number",,145']), [], 'empty entries are left out');
  });

  test('writes entry 1 of the own-number list, reads it back, selects the contacts again and asks AT+CNUM', async () => {
    const h = harness();
    try {
      const op = await h.run({ number: NUM });
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(h.commands(), ['AT+CPBS?', 'AT+CPBS="ON"', WRITE, 'AT+CPBR=1', 'AT+CPBS="SM"', 'AT+CNUM']);
      assert.deepEqual([h.sim.own, h.sim.storage], [NUM, 'SM']);
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.storage, result.read_back, result.reported, result.restored], ['SM', NUM, [NUM], true]);
      assert.equal(result.transactions.length, 6);
      assert.ok(h.ami.calls.some((call) => call.startsWith('QuectelAtCommand')));
    } finally {
      await h.stop();
    }
  });

  test('the phonebook that was in use is the one selected again, and a dongle gets the Dongle action', async () => {
    const h = harness({ storage: 'ME' });
    try {
      const op = await h.run({ number: NUM }, 'gsm2');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(h.commands().at(-2), 'AT+CPBS="ME"');
      assert.equal(h.sim.storage, 'ME');
      assert.ok(h.ami.calls.some((call) => call.startsWith('DongleAtCommand')));
    } finally {
      await h.stop();
    }
  });

  test('a SIM that refuses the write (PIN2): failed with the modem\'s error, the contacts selected again, nothing read', async () => {
    const h = harness({ locked: true });
    try {
      const op = await h.run({ number: NUM });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, `${WRITE}: +CME ERROR: SIM PIN2 required`);
      assert.deepEqual(h.commands(), ['AT+CPBS?', 'AT+CPBS="ON"', WRITE, 'AT+CPBS="SM"']);
      assert.deepEqual([h.sim.own, h.sim.storage], [null, 'SM']);
    } finally {
      await h.stop();
    }
  });

  test('a modem without an own-number list: failed after the select, nothing written', async () => {
    const h = harness();
    h.overrides['AT+CPBS="ON"'] = { result: 'ERROR', error: '+CME ERROR: operation not supported' };
    try {
      const op = await h.run({ number: NUM });
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /^AT\+CPBS="ON": the modem cannot select the SIM's own-number list \(\+CME ERROR: operation not supported\); nothing was written/);
      assert.deepEqual(h.commands(), ['AT+CPBS?', 'AT+CPBS="ON"']);
      assert.equal(h.sim.own, null);
    } finally {
      await h.stop();
    }
  });

  test('a phonebook query the modem refuses fails the operation before anything else is sent', async () => {
    const h = harness();
    h.overrides['AT+CPBS?'] = { result: 'ERROR', error: 'ERROR' };
    try {
      const op = await h.run({ number: NUM });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CPBS?: ERROR; nothing was written to the SIM');
      assert.deepEqual(h.commands(), ['AT+CPBS?']);
    } finally {
      await h.stop();
    }
  });

  test('a write without a verdict is uncertain, and nothing more is sent to the modem that went quiet', async () => {
    const h = harness();
    h.overrides[WRITE] = { result: 'silent' };
    try {
      const op = await h.run({ number: NUM });
      assert.equal(op.status, 'uncertain');
      assert.match(op.error ?? '', /whether the SIM stored the number is unknown/);
      assert.deepEqual(h.commands(), ['AT+CPBS?', 'AT+CPBS="ON"', WRITE]);
    } finally {
      await h.stop();
    }
  });

  test('an OK write that reads back as another number is uncertain', async () => {
    const h = harness();
    h.overrides['AT+CPBR=1'] = { lines: ['+CPBR: 1,"+1234567899",145,""'] };
    try {
      const op = await h.run({ number: NUM });
      assert.equal(op.status, 'uncertain');
      assert.equal(op.error, 'the SIM accepted the number, but its own-number entry reads +1234567899');
      assert.equal(h.commands().at(-1), 'AT+CNUM', 'the contacts are selected again and the driver still asked');
    } finally {
      await h.stop();
    }
  });

  test('a number that is not in international format, or a modem that is not connected, fails before the SIM changes', async () => {
    const h = harness({ connected: false });
    try {
      for (const number of ['1234567890', '+12345', undefined]) {
        const op = await h.run({ number }, 'gsm2');
        assert.equal(op.status, 'failed');
        assert.match(op.error ?? '', /^the number must be like \+1234567890/);
      }
      assert.deepEqual(h.commands(), []);
      const op = await h.run({ number: NUM });
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /^AT\+CPBS\?: .*Device not connected.*; nothing was written to the SIM$/);
    } finally {
      await h.stop();
    }
  });
});
