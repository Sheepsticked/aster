// @ts-check
// Tests for src/at/client.js: transact() and the `at` operation against a scripted driver AMI, and the real AmiClient against
// the at-command.txt transcript served by the fake AMI server.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { AmiClient, AmiError, AmiTimeout } from '../src/ami/client.js';
import { checkActionId, checkCommand, checkTimeout, createAtOps, DEFINITE, OUTCOMES, transact } from '../src/at/client.js';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';
import { asterisk, fakeAmi } from './ami-fake-server.js';
import { FakeDriverAmi, until } from './devices-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-at-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

const REGISTRY = validate({ version: 1, modems: [
  { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true },
  { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true },
], phones: [] });
const FAST = { graceMs: 50, actionTimeoutMs: 500 };

function fake({ connected = true } = {}) {
  const ami = new FakeDriverAmi({ connected });
  ami.addDevice('gsm1', 'quectel', { state: 'Free', current: 'start', desired: 'start' });
  ami.addDevice('gsm2', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
  ami.addDevice('gsm3', 'quectel');
  return ami;
}

/** @param {FakeDriverAmi} ami @param {Partial<import('../src/at/client.js').TransactOptions>} [options] */
const tx = (ami, options = {}) => transact(/** @type {any} */ (ami), { driver: 'quectel', device: 'gsm1', command: 'AT+CSQ', actionId: 'at-1', timeoutS: 1, ...FAST, ...options });

/** A log that keeps its debug lines. */
function debugLog() {
  /** @type {Array<{ msg: string, fields: any }>} */
  const lines = [];
  /** @type {any} */
  const log = { debug: (/** @type {string} */ msg, /** @type {unknown} */ fields) => lines.push({ msg, fields }), info() {}, warn() {}, error() {}, child: () => log };
  return { log, lines };
}

function harness({ connected = true } = {}) {
  const db = open(join(tmp, `at-${++counter}.db`));
  migrate(db);
  const ami = fake({ connected });
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
  const ops = createAtOps({ registry: () => REGISTRY, timing: FAST });
  ops.register(runner);
  runner.start();
  return { db, ami, runner, ops, stop: async () => { await runner.stop(); db.close(); } };
}

describe('at client', () => {
  test('checkCommand / checkTimeout / checkActionId follow the patched manager.c limits', () => {
    assert.equal(checkCommand('AT+CSQ'), 'AT+CSQ');
    assert.equal(checkCommand('A'.repeat(256)), 'A'.repeat(256));
    assert.throws(() => checkCommand(''), /1 to 256 characters, not 0/);
    assert.throws(() => checkCommand('A'.repeat(257)), /1 to 256 characters, not 257/);
    assert.throws(() => checkCommand('AT\r'), /CR, LF or NUL/);
    assert.throws(() => checkCommand('AT\nAT'), /CR, LF or NUL/);
    assert.throws(() => checkCommand(' AT'), /must not start with a blank/);
    assert.throws(() => checkCommand(/** @type {any} */ (5)), /must be a string/);
    assert.equal(checkTimeout(undefined), 15);
    assert.equal(checkTimeout(null), 15);
    assert.equal(checkTimeout(60), 60);
    assert.throws(() => checkTimeout(0), /1 to 60 seconds, not 0/);
    assert.throws(() => checkTimeout(61), /1 to 60/);
    assert.throws(() => checkTimeout(1.5), /1 to 60/);
    assert.throws(() => checkTimeout(/** @type {any} */ ('5')), /1 to 60 seconds, not "5"/);
    assert.equal(checkActionId('at-12.1'), 'at-12.1');
    assert.throws(() => checkActionId('ami-1'), /not start with ami-/);
    assert.throws(() => checkActionId('a b'), /ActionID must match/);
    assert.throws(() => checkActionId('x'.repeat(64)), /ActionID must match/);
    assert.throws(() => checkActionId(''), /ActionID must match/);
    assert.deepEqual([...OUTCOMES], ['OK', 'ERROR', 'TIMEOUT', 'refused', 'disconnected', 'down', 'deadline']);
    assert.deepEqual([...DEFINITE], ['OK', 'ERROR', 'TIMEOUT', 'refused']);
  });

  test('transact(): the request, the ack, every line in order, OK; the listeners are gone afterwards', async () => {
    const ami = fake();
    ami.at = () => ({ lines: ['+CSQ: 20,99', ''], result: 'OK' });
    const before = Date.now();
    const result = await tx(ami, { timeoutS: 7 });
    assert.deepEqual([result.action_id, result.device, result.command, result.timeout_s, result.reply, result.outcome, result.error, result.lines],
      ['at-1', 'gsm1', 'AT+CSQ', 7, '[gsm1] AT command queued', 'OK', null, ['+CSQ: 20,99', '']]);
    assert.ok(result.sent_at >= before && result.observed_at >= result.sent_at);
    assert.deepEqual(ami.atCommands, [{ device: 'gsm1', command: 'AT+CSQ', actionId: 'at-1', timeout: '7' }]);
    assert.deepEqual(ami.calls, ['QuectelAtCommand gsm1']);
    for (const event of ['event:QuectelAtResponse', 'event:QuectelAtDone', 'event:QuectelStatus', 'down']) assert.equal(ami.listenerCount(event), 0, event);
    // the dongle driver: its own action and event names
    ami.at = () => ({ lines: ['^RSSI is never a line, but the fake does what it is told'] });
    const dongle = await tx(ami, { driver: 'dongle', device: 'gsm2', actionId: 'at-2' });
    assert.deepEqual([dongle.outcome, dongle.reply, dongle.lines.length, ami.calls.at(-1)], ['OK', '[gsm2] AT command queued', 1, 'DongleAtCommand gsm2']);
    assert.throws(() => tx(ami, { command: '' }), /1 to 256/);
    assert.throws(() => tx(ami, { actionId: 'ami-3' }), /not start with ami-/);
    assert.throws(() => tx(ami, { device: '' }), /device name/);
  });

  test('correlation: a transaction that hits its deadline ends there; the late AtDone and lines of its ActionID, and an AtDone of an unknown ActionID, never reach the next one', async () => {
    const ami = fake();
    const { log, lines: logged } = debugLog();
    ami.at = (_device, command) => (command === 'AT+SLOW' ? { result: 'silent' } : { lines: ['+CSQ: 20,99'], delayMs: 30 });
    const started = Date.now();
    const a = await tx(ami, { command: 'AT+SLOW', actionId: 'at-A', log });
    const elapsed = Date.now() - started;
    assert.deepEqual([a.outcome, a.error, a.lines], ['deadline', 'no AtDone within 1 s + 0.05 s', []]);
    assert.ok(elapsed >= 1_000 && elapsed < 2_500, `the deadline is the timeout plus the grace: ${elapsed} ms`);
    const pending = tx(ami, { actionId: 'at-B', log });
    await until(() => ami.atCommands.length === 2, 500, 'the second request');
    ami.emitAtResponse('gsm1', 'at-A', '+CSQ: 9,9');
    ami.emitAtDone('gsm1', 'at-A', 'OK');
    ami.emitAtDone('gsm1', 'at-0', 'TIMEOUT');
    const b = await pending;
    assert.deepEqual([b.outcome, b.lines], ['OK', ['+CSQ: 20,99']]);
    const dropped = logged.filter((l) => l.msg.endsWith('of another transaction dropped'));
    assert.deepEqual(dropped.map((l) => [l.msg, l.fields.action_id, l.fields.expected]), [
      ['QuectelAtResponse of another transaction dropped', 'at-A', 'at-B'],
      ['QuectelAtDone of another transaction dropped', 'at-A', 'at-B'],
      ['QuectelAtDone of another transaction dropped', 'at-0', 'at-B'],
    ]);
    // the events can be read before the ack: the subscription exists before the request is sent
    ami.at = () => ({ lines: ['+CSQ: 1,0'], before: true });
    const early = await tx(ami, { actionId: 'at-C' });
    assert.deepEqual([early.outcome, early.lines, early.reply], ['OK', ['+CSQ: 1,0'], '[gsm1] AT command queued'], 'the result waits for the ack that was on the wire before the events');
  });

  test('the driver verdicts: ERROR with the terminal line, TIMEOUT, task removed, queue flushed, a Result without Error', async () => {
    const ami = fake();
    ami.at = () => ({ lines: ['+CCFC: 0,255'], result: 'ERROR', error: '+CME ERROR: 30' });
    let result = await tx(ami);
    assert.deepEqual([result.outcome, result.error, result.lines], ['ERROR', '+CME ERROR: 30', ['+CCFC: 0,255']]);
    ami.at = () => ({ result: 'TIMEOUT' });
    result = await tx(ami, { actionId: 'at-2' });
    assert.deepEqual([result.outcome, result.error], ['TIMEOUT', 'timeout']);
    ami.at = () => ({ lines: ['+CMGR: 1,,24'], result: 'ERROR', error: 'task removed' });
    result = await tx(ami, { actionId: 'at-3' });
    assert.deepEqual([result.outcome, result.error, result.lines], ['ERROR', 'task removed', ['+CMGR: 1,,24']]);
    ami.at = () => ({ result: 'ERROR', error: 'queue flushed' });
    result = await tx(ami, { actionId: 'at-4' });
    assert.deepEqual([result.outcome, result.error], ['ERROR', 'queue flushed']);
    ami.at = () => ({ result: 'silent' });
    const pending = tx(ami, { actionId: 'at-5' });
    await until(() => ami.atCommands.length === 5);
    ami.emit('event:QuectelAtDone', new Map([['Event', 'QuectelAtDone'], ['ActionID', 'at-5'], ['Device', 'gsm1'], ['Result', 'ERROR']]));
    result = await pending;
    assert.deepEqual([result.outcome, result.error], ['ERROR', 'ERROR']);
    // the first verdict stands: an AtDone read before the request's own answer is not overturned by a refusal
    ami.onAction = () => {
      ami.emitAtDone('gsm1', 'at-6', 'OK');
      throw new AmiError('Device not connected', new Map([['Response', 'Error'], ['Message', 'Device not connected']]));
    };
    result = await tx(ami, { actionId: 'at-6' });
    assert.deepEqual([result.outcome, result.error, result.reply], ['OK', null, 'Device not connected']);
  });

  test('no verdict: a Disconnect of the device (another device\'s is ignored), an AMI drop, an ack that never comes, a client that is not up; a refusal', async () => {
    const ami = fake();
    ami.at = () => ({ result: 'silent' });
    let pending = tx(ami);
    await until(() => ami.atCommands.length === 1);
    ami.emitStatus('gsm2', 'Disconnect');
    ami.emitStatus('gsm3', 'Disconnect');
    ami.emitStatus('gsm1', 'Free');
    ami.emitAtResponse('gsm1', 'at-1', 'partial');
    ami.emitStatus('gsm1', 'Disconnect');
    let result = await pending;
    assert.deepEqual([result.outcome, result.error, result.lines], ['disconnected', 'the device disconnected before the command completed', ['partial']]);
    pending = tx(ami, { actionId: 'at-2' });
    await until(() => ami.atCommands.length === 2);
    ami.emit('down', new Error('socket closed'));
    result = await pending;
    assert.deepEqual([result.outcome, result.error], ['down', 'the AMI connection dropped before the command completed: socket closed']);
    // the ack never comes: the client's action timeout rejects the request
    ami.onAction = () => {
      throw new AmiTimeout('QuectelAtCommand', 'at-3', 40);
    };
    result = await tx(ami, { actionId: 'at-3', actionTimeoutMs: 40, graceMs: 5_000 });
    assert.equal(result.outcome, 'down');
    assert.match(result.error ?? '', /^the AtCommand request did not complete: .*40/);
    ami.onAction = null;
    ami.up = false;
    result = await tx(ami, { actionId: 'at-4' });
    assert.deepEqual([result.outcome, result.error], ['down', 'the AtCommand request did not complete: not up']);
    ami.up = true;
    result = await tx(ami, { actionId: 'at-5', device: 'gsm3' });
    assert.deepEqual([result.outcome, result.error, result.reply, result.lines], ['refused', 'Device not connected', 'Device not connected', []]);
    result = await tx(ami, { actionId: 'at-6', device: 'nosuch' });
    assert.deepEqual([result.outcome, result.error], ['refused', 'Device not found']);
    result = await tx(ami, { actionId: 'at-7', device: 'gsm2' });
    assert.deepEqual([result.outcome, result.error], ['refused', 'Device not found'], 'a dongle device asked through the quectel action');
  });

  test('a doubled Line header (manager debug) counts once, with the last value', async () => {
    const ami = fake();
    ami.at = () => ({ lines: [['+CSQ: 1,1', '+CSQ: 2,2'], '+CSQ: 3,3'] });
    const result = await tx(ami);
    assert.deepEqual([result.outcome, result.lines], ['OK', ['+CSQ: 2,2', '+CSQ: 3,3']]);
  });

  test('the at operation: done with the transaction, failed with the driver\'s text and the lines so far, uncertain without a verdict; run()', async () => {
    const h = harness();
    try {
      h.ami.at = (_device, command) => {
        if (command === 'AT+CSQ') return { lines: ['+CSQ: 20,99'] };
        if (command === 'AT+BAD') return { lines: ['half'], result: 'ERROR', error: 'ERROR' };
        if (command === 'AT+SLOW') return { result: 'silent' };
        if (command === 'AT+HANG') return { result: 'TIMEOUT' };
        return undefined;
      };
      let op = await h.ops.run('gsm1', 'AT+CSQ');
      assert.equal(op.status, 'done', op.error ?? '');
      let result = /** @type {any} */ (op.result);
      assert.deepEqual([result.modem_id, result.driver, result.action_id, result.command, result.timeout_s, result.reply, result.outcome, result.error, result.lines],
        ['gsm1', 'quectel', `at-${op.id}`, 'AT+CSQ', 15, '[gsm1] AT command queued', 'OK', null, ['+CSQ: 20,99']]);
      assert.equal(typeof result.observed_at, 'number');
      assert.deepEqual(h.ami.atCommands.at(-1), { device: 'gsm1', command: 'AT+CSQ', actionId: `at-${op.id}`, timeout: '15' });
      op = await h.ops.run('gsm1', 'AT+BAD', { timeout: 3, actor: 'cli' });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+BAD: ERROR');
      assert.equal(op.actor, 'cli');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.outcome, result.lines, result.timeout_s, result.action_id], ['ERROR', ['half'], 3, `at-${op.id}`]);
      assert.equal(h.ami.atCommands.at(-1)?.actionId, `at-${op.id}`, 'every operation sends its own ActionID');
      op = await h.ops.run('gsm1', 'AT+HANG');
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+HANG: no final line within 15 s; the driver restarts the modem after an AT timeout');
      op = await h.ops.run('gsm1', 'AT+SLOW', { timeout: 1 });
      assert.equal(op.status, 'uncertain');
      assert.equal(op.error, 'AT+SLOW: no AtDone within 1 s + 0.05 s; whether the modem ran it is unknown');
      assert.equal(/** @type {any} */ (op.result).outcome, 'deadline');
      // the dongle modem of the registry
      op = await h.ops.run('gsm2', 'AT+CSQ');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(h.ami.calls.at(-1), 'DongleAtCommand gsm2');
      assert.throws(() => createAtOps({ registry: () => REGISTRY }).run('gsm1', 'AT'), /register\(runner\) must run first/);
    } finally {
      await h.stop();
    }
  });

  test('one transaction per modem at a time, in queue order; modems in parallel', async () => {
    const h = harness();
    try {
      h.ami.at = (_device, command) => ({ lines: [command], delayMs: 25 });
      const ids = [
        h.runner.enqueue({ kind: 'at', modemId: 'gsm1', params: { command: 'AT+A' }, actor: 'admin' }),
        h.runner.enqueue({ kind: 'at', modemId: 'gsm1', params: { command: 'AT+B' }, actor: 'admin' }),
        h.runner.enqueue({ kind: 'at', modemId: 'gsm2', params: { command: 'AT+C' }, actor: 'admin' }),
        h.runner.enqueue({ kind: 'at', modemId: 'gsm1', params: { command: 'AT+D' }, actor: 'admin' }),
      ];
      const ops = await Promise.all(ids.map((id) => h.runner.wait(id)));
      assert.deepEqual(ops.map((op) => op.status), ['done', 'done', 'done', 'done']);
      const gsm1 = h.ami.atCommands.filter((c) => c.device === 'gsm1').map((c) => c.command);
      assert.deepEqual(gsm1, ['AT+A', 'AT+B', 'AT+D']);
      const results = ops.map((op) => /** @type {any} */ (op.result));
      assert.ok(results[1].sent_at >= results[0].observed_at, 'B waited for A');
      assert.ok(results[3].sent_at >= results[1].observed_at, 'D waited for B');
      assert.ok(results[2].sent_at < results[1].observed_at, 'the other modem did not wait');
    } finally {
      await h.stop();
    }
  });

  test('refusals: not in the registry (unless the driver is given), an invalid command or timeout, no modem id, AMI down, a stopped device; nothing sent for the checks', async () => {
    const h = harness();
    try {
      let op = await h.ops.run('ghost', 'AT');
      assert.equal(op.status, 'failed');
      assert.match(op.error ?? '', /modem ghost is not in the registry \(pass params.driver/);
      op = await h.ops.run('gsm1', '');
      assert.match(op.error ?? '', /1 to 256 characters/);
      op = await h.ops.run('gsm1', 'AT', { timeout: 0 });
      assert.match(op.error ?? '', /1 to 60 seconds/);
      op = await h.runner.wait(h.runner.enqueue({ kind: 'at', modemId: 'gsm1', params: { command: 'AT', driver: 'huawei' }, actor: 'admin' }));
      assert.match(op.error ?? '', /driver must be quectel or dongle, not "huawei"/);
      op = await h.runner.wait(h.runner.enqueue({ kind: 'at', modemId: null, params: { command: 'AT' }, actor: 'admin' }));
      assert.match(op.error ?? '', /at needs the modem id/);
      assert.deepEqual(h.ami.calls, []);
      h.ami.up = false;
      op = await h.ops.run('gsm1', 'AT');
      assert.match(op.error ?? '', /not connected over AMI \(connecting\); the command was not sent/);
      h.ami.up = true;
      op = await h.runner.wait(h.runner.enqueue({ kind: 'at', modemId: 'gsm3', params: { command: 'AT+CSQ', driver: 'quectel' }, actor: 'admin' }));
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CSQ: Device not connected');
      assert.deepEqual([/** @type {any} */ (op.result).outcome, /** @type {any} */ (op.result).reply], ['refused', 'Device not connected']);
    } finally {
      await h.stop();
    }
  });

  test('an operation interrupted by a controller restart is uncertain at the next start', async () => {
    const db = open(join(tmp, `at-${++counter}.db`));
    migrate(db);
    const at = Date.now();
    db.prepare("INSERT INTO operations (kind, modem_id, status, params_json, actor, created_at, started_at) VALUES ('at', 'gsm1', 'running', '{\"command\":\"AT\"}', 'admin', ?, ?)").run(at, at);
    const ami = fake();
    const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
    createAtOps({ registry: () => REGISTRY, timing: FAST }).register(runner);
    runner.start();
    try {
      const op = await runner.wait(1);
      assert.equal(op.status, 'uncertain');
      assert.deepEqual(ami.calls, []);
    } finally {
      await runner.stop();
      db.close();
    }
  });

  test('against the synthesized transcript through the real AmiClient: escaped CRLF in a line, task removed, queue flushed before Status Free/Disconnect, the AtDone of an ActionID never sent', async () => {
    const text = readFileSync(new URL('./fixtures/ami/at-command.txt', import.meta.url), 'latin1');
    /** the blocks that follow each `Response: Success` of an at-<n> request, keyed by that ActionID @type {Map<string, string[]>} */
    const groups = new Map();
    /** @type {string[] | null} */
    let current = null;
    for (const block of text.split('\r\n\r\n')) {
      const match = /^Response: Success\r\nActionID: (at-\d+)\r\n/.exec(block);
      if (match) {
        current = [block];
        groups.set(String(match[1]), current);
      } else if (current && block.startsWith('Event: ')) current.push(block);
      else current = null;
    }
    assert.deepEqual([...groups.keys()], ['at-1', 'at-2', 'at-3']);
    const server = await fakeAmi([asterisk((request) => {
      if (request.get('Action') !== 'QuectelAtCommand') return undefined;
      const group = groups.get(String(request.get('ActionID') ?? ''));
      return group ? `${group.join('\r\n\r\n')}\r\n\r\n` : undefined;
    })]);
    const client = new AmiClient({ backoffMinMs: 100, backoffMaxMs: 500 });
    const { log, lines: logged } = debugLog();
    /** the ActionIDs of every AtDone the client emitted @type {string[]} */
    const seen = [];
    client.on('event:QuectelAtDone', (packet) => seen.push(String(packet.get('ActionID'))));
    try {
      await client.connect({ host: '127.0.0.1', port: server.port, username: 'aster', secret: 'test' });
      const common = { driver: /** @type {const} */ ('quectel'), device: 'gsm1', timeoutS: 1, log, ...FAST };
      const one = await transact(client, { ...common, command: 'AT+CCFC=0,2', actionId: 'at-1' });
      assert.deepEqual([one.reply, one.outcome, one.error, one.lines], ['[gsm1] AT command queued', 'OK', null, ['+CCFC: 1,1,"+1234567890",145', '+CCFC: 0,2']]);
      const two = await transact(client, { ...common, command: 'AT+CMGR=1', actionId: 'at-2' });
      assert.deepEqual([two.outcome, two.error, two.lines], ['ERROR', 'task removed', ['+CMGR: 1,,24\\r\\n07919730071111F1040B919730071111F10000629090315000210548656C6C6F']]);
      const three = await transact(client, { ...common, command: 'AT+CSQ', actionId: 'at-3' });
      assert.deepEqual([three.outcome, three.error, three.lines], ['ERROR', 'queue flushed', []]);
      // the AtDone of at-0 (never sent) reached the client after at-1 had settled: no transaction was listening, none took it
      assert.deepEqual(seen, ['at-1', 'at-0', 'at-2', 'at-3']);
      assert.deepEqual(logged.filter((l) => l.msg.endsWith('dropped')), []);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
