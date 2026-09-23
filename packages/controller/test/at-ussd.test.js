// @ts-check
// Tests for src/at/ussd.js: ussdText() on the NewUSSD shapes and the operation through a real runner with the scripted
// driver AMI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { CODE, createUssdOps, ussdText } from '../src/at/ussd.js';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi, until } from './devices-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-ussd-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

const REGISTRY = validate({ version: 1, modems: [
  { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true },
  { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true },
], phones: [] });

function harness({ connected = true } = {}) {
  const db = open(join(tmp, `ussd-${++counter}.db`));
  migrate(db);
  const ami = new FakeDriverAmi({ connected });
  ami.addDevice('gsm1', 'quectel', { state: 'Free', current: 'start', desired: 'start' });
  ami.addDevice('gsm2', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
  ami.addDevice('gsm3', 'quectel');
  ami.ussdAnswer = (_device, code) => (code === '*100#' ? 'Balance: 1.23 EUR\r\n\r\nValid until 2026-12-31' : null);
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
  createUssdOps({ registry: () => REGISTRY, timing: { answerTimeoutMs: 80, actionTimeoutMs: 500 } }).register(runner);
  runner.start();
  /** @param {Record<string, unknown>} params @param {string | null} [modemId] */
  const run = (params, modemId = 'gsm1') => runner.wait(runner.enqueue({ kind: 'ussd', modemId, params, actor: 'admin' }));
  return { db, ami, runner, run, stop: async () => { await runner.stop(); db.close(); } };
}

describe('at ussd', () => {
  test('ussdText(): LineCount and MessageLine<n>; without LineCount every MessageLine in order; CODE', () => {
    assert.deepEqual(ussdText(new Map([['Event', 'QuectelNewUSSD'], ['Device', 'gsm1'], ['LineCount', '2'], ['MessageLine0', 'Balance: 1.23'], ['MessageLine1', 'Valid until 2026-12-31']])),
      { lines: ['Balance: 1.23', 'Valid until 2026-12-31'], text: 'Balance: 1.23\nValid until 2026-12-31' });
    assert.deepEqual(ussdText(new Map([['Event', 'DongleNewUSSD'], ['Device', 'gsm2'], ['LineCount', '0']])), { lines: [], text: '' });
    assert.deepEqual(ussdText(new Map([['Event', 'DongleNewUSSD'], ['Device', 'gsm2'], ['MessageLine0', 'a'], ['MessageLine1', 'b']])), { lines: ['a', 'b'], text: 'a\nb' });
    assert.deepEqual(ussdText(new Map(/** @type {any} */ ([['LineCount', '2'], ['MessageLine0', ['x', 'y']]]))), { lines: ['x', ''], text: 'x\n' }, 'a missing line is empty, a doubled header takes the first');
    for (const ok of ['*100#', '#100#', '*111*1#', '1', '0'.repeat(64)]) assert.ok(CODE.test(ok), ok);
    for (const bad of ['', '*100# ', 'abc', '*100#\n', '0'.repeat(65)]) assert.ok(!CODE.test(bad), JSON.stringify(bad));
  });

  test('the ussd operation: the driver\'s ack and the network\'s answer as lines and text', async () => {
    const h = harness();
    try {
      const op = await h.run({ code: '*100#' });
      assert.equal(op.status, 'done', op.error ?? '');
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.modem_id, result.driver, result.code, result.reply, result.text, result.lines],
        ['gsm1', 'quectel', '*100#', '[gsm1] USSD queued for send', 'Balance: 1.23 EUR\nValid until 2026-12-31', ['Balance: 1.23 EUR', 'Valid until 2026-12-31']]);
      assert.ok(result.observed_at >= result.sent_at);
      assert.deepEqual(h.ami.ussd, [{ device: 'gsm1', code: '*100#' }]);
      assert.deepEqual(h.ami.calls, ['QuectelSendUSSD gsm1']);
      for (const event of ['event:QuectelNewUSSD', 'event:QuectelStatus', 'down']) assert.equal(h.ami.listenerCount(event), 0, event);
      const dongle = await h.run({ code: '*100#' }, 'gsm2');
      assert.equal(dongle.status, 'done', dongle.error ?? '');
      assert.equal(h.ami.calls.at(-1), 'DongleSendUSSD gsm2');
    } finally {
      await h.stop();
    }
  });

  test('no answer in time, another device\'s answer ignored, a Disconnect, an AMI drop: uncertain; a stopped device: failed', async () => {
    const h = harness();
    try {
      let op = await h.run({ code: '*101#' });
      assert.equal(op.status, 'uncertain');
      assert.equal(op.error, '*101#: no USSD answer within 80 ms; whether the network received the code is unknown');
      let result = /** @type {any} */ (op.result);
      assert.deepEqual([result.reply, result.text, result.lines], ['[gsm1] USSD queued for send', null, []]);
      let pending = h.run({ code: '*102#' });
      await until(() => h.ami.ussd.length === 2);
      h.ami.emitUssd('gsm2', 'not for gsm1 (a dongle event)');
      h.ami.emitUssd('gsm3', 'not for gsm1 (the same driver, another device)');
      h.ami.emitUssd('gsm1', 'for gsm1');
      op = await pending;
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(/** @type {any} */ (op.result).text, 'for gsm1');
      pending = h.run({ code: '*103#' });
      await until(() => h.ami.ussd.length === 3);
      h.ami.emitStatus('gsm1', 'Disconnect');
      op = await pending;
      assert.equal(op.status, 'uncertain');
      assert.equal(op.error, '*103#: the device disconnected before the network answered; whether the network received the code is unknown');
      pending = h.run({ code: '*104#' });
      await until(() => h.ami.ussd.length === 4);
      h.ami.emit('down', new Error('socket closed'));
      op = await pending;
      assert.equal(op.status, 'uncertain');
      assert.match(op.error ?? '', /the AMI connection dropped before the network answered: socket closed/);
      op = await h.runner.wait(h.runner.enqueue({ kind: 'ussd', modemId: 'gsm3', params: { code: '*100#', driver: 'quectel' }, actor: 'admin' }));
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'QuectelSendUSSD gsm3: [gsm3] Device disconnected');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.reply, result.text], ['[gsm3] Device disconnected', null]);
    } finally {
      await h.stop();
    }
  });

  test('parameter checks and AMI down send nothing; an interrupted operation is uncertain at the next start', async () => {
    const h = harness();
    try {
      let op = await h.run({ code: 'abc' });
      assert.match(op.error ?? '', /code must be 1 to 64 digits, \* and #, not "abc"/);
      op = await h.run({});
      assert.match(op.error ?? '', /code must be/);
      op = await h.run({ code: '*100#' }, 'ghost');
      assert.match(op.error ?? '', /modem ghost is not in the registry/);
      op = await h.run({ code: '*100#' }, null);
      assert.match(op.error ?? '', /ussd needs the modem id/);
      h.ami.up = false;
      op = await h.run({ code: '*100#' });
      assert.match(op.error ?? '', /not connected over AMI \(connecting\); the USSD was not sent/);
      assert.deepEqual(h.ami.calls, []);
    } finally {
      await h.stop();
    }
    const db = open(join(tmp, `ussd-${++counter}.db`));
    migrate(db);
    const at = Date.now();
    db.prepare("INSERT INTO operations (kind, modem_id, status, params_json, actor, created_at, started_at) VALUES ('ussd', 'gsm1', 'running', '{\"code\":\"*100#\"}', 'admin', ?, ?)").run(at, at);
    const ami = new FakeDriverAmi();
    const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
    createUssdOps({ registry: () => REGISTRY }).register(runner);
    runner.start();
    try {
      assert.equal((await runner.wait(1)).status, 'uncertain');
      assert.deepEqual(ami.calls, []);
    } finally {
      await runner.stop();
      db.close();
    }
  });
});
