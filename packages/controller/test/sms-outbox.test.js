// @ts-check
// Tests for src/sms/outbox.js: validation, send and its sms-send operation against a scripted driver AMI, retry, remove and
// purge, recovery at boot, the expiry sweep, and the wire format through the real AMI client.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { AmiClient, AmiTimeout } from '../src/ami/client.js';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createRunner } from '../src/ops/runner.js';
import { checkNumber, checkText, createOutbox, DEFAULTS, escapeMessage, KIND, MAX_TEXT_BYTES, OutboxError, RESTARTED, VALIDITY_MINUTES } from '../src/sms/outbox.js';
import { applyReport, createReportListener } from '../src/sms/reports.js';
import { migrate, open } from '../src/store/db.js';
import { asterisk, fakeAmi, packet } from './ami-fake-server.js';
import { FakeDriverAmi } from './devices-fake.js';

/** @typedef {import('../src/config/registry.js').Registry} Registry */
/** @typedef {import('../src/bus.js').OpProgress} OpProgress */

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0);
const tmp = mkdtempSync(join(tmpdir(), 'aster-sms-outbox-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;
const REGISTRY = validate({ version: 1, modems: [
  { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true },
  { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true },
], phones: [] });

/**
 * A migrated database (or an earlier one, reopened like a restarted controller), a scripted driver AMI with gsm1 (quectel) and gsm2
 * (dongle) connected, a runner, the outbox and the report listener on a clock the test moves.
 * @param {{ connected?: boolean, ami?: boolean, registry?: () => Registry | null, timing?: Record<string, number>, path?: string }} [options]
 */
function harness({ connected = true, ami: withAmi = true, registry = () => REGISTRY, timing = {}, path } = {}) {
  const dbPath = path ?? join(tmp, `outbox-${++counter}.db`);
  const db = open(dbPath);
  migrate(db);
  const ami = withAmi ? new FakeDriverAmi({ connected }) : null;
  ami?.addDevice('gsm1', 'quectel', { state: 'Free', current: 'start', desired: 'start' });
  ami?.addDevice('gsm2', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
  const clock = { now: T0 };
  const bus = createBus();
  /** @type {OpProgress[]} */
  const events = [];
  bus.subscribe((event) => {
    if (event.type === 'op.progress') events.push(event.payload);
  });
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus, now: () => clock.now });
  const outbox = createOutbox({ db, registry, now: () => clock.now, timing: { actionTimeoutMs: 500, ...timing } });
  outbox.register(runner);
  const listener = ami ? createReportListener({ ami: /** @type {any} */ (ami), db, now: () => clock.now }) : null;
  /** @param {{ id: number, operationId: number }} queued */
  const wait = (queued) => runner.wait(queued.operationId);
  return {
    db, dbPath, ami, runner, outbox, clock, events, listener, wait,
    start() {
      outbox.start();
      return runner.start();
    },
    async stop() {
      outbox.stop();
      await runner.stop();
      db.close();
    },
  };
}

/** @param {ReturnType<typeof harness>} h */
const started = (h) => {
  h.start();
  return h;
};

describe('sms outbox', () => {
  test('escapeMessage, checkText and checkNumber: the header escapes, leading blanks, control characters, lone surrogates, the line limit, the drivers\' number rule', () => {
    assert.equal(escapeMessage('a\\b\nc\rd\te'), 'a\\\\b\\nc\\rd\\te');
    assert.equal(escapeMessage('plain'), 'plain');
    assert.equal(checkText('  hi'), 'hi');
    assert.equal(checkText('\t\n x y '), 'x y ', 'leading blanks go, the rest stays');
    assert.equal(checkText('Привет\nиз Aster'), 'Привет\nиз Aster');
    assert.equal(MAX_TEXT_BYTES, 1013);
    assert.equal(checkText('ж'.repeat(506)), 'ж'.repeat(506), '1012 bytes');
    for (const [text, why] of /** @type {Array<[unknown, RegExp]>} */ ([
      ['', /empty/], ['   ', /empty/], [' \n\t', /empty/], [42, /string/], [null, /string/],
      [`a${String.fromCharCode(7)}b`, /control character/], [`a${String.fromCharCode(0x7f)}`, /control character/], [`a${String.fromCharCode(0)}b`, /control character/],
      [String.fromCharCode(0xd800), /well-formed/], [`x${String.fromCharCode(0xdc00)}`, /well-formed/],
      ['ж'.repeat(507), /1014 bytes/], ['\\'.repeat(507), /1014 bytes/],
    ])) {
      assert.throws(() => checkText(text), (err) => err instanceof OutboxError && err.code === 'invalid' && why.test(err.message), `${JSON.stringify(text).slice(0, 20)}: ${why}`);
    }
    for (const number of ['+1234567890', '12', '1234567890', '+' + '9'.repeat(20)]) assert.equal(checkNumber(number), number);
    for (const number of ['1', '+', '+1', '*100#', ' 123', '123 ', '+375 29', '1'.repeat(21), 123, '', null, '+375-29']) {
      assert.throws(() => checkNumber(number), (err) => err instanceof OutboxError && err.code === 'invalid', JSON.stringify(number));
    }
    assert.equal(KIND, 'sms-send');
    assert.equal(VALIDITY_MINUTES, 180);
    assert.deepEqual(DEFAULTS, { actionTimeoutMs: 30_000, validityMs: 10_800_000, graceMs: 600_000, sweepMs: 60_000 });
  });

  test('send: the queued row and its operation, then the driver request and a submitted row with the reply; Dongle prefix for a chan_dongle modem', async () => {
    const h = started(harness());
    try {
      assert.throws(() => h.outbox.send({ modemId: 'gsm9', number: '+1234567890', text: 'hi', actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'invalid' && /gsm9 is not in the registry/.test(err.message));
      assert.throws(() => h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: /** @type {any} */ ('root') }), (err) => err instanceof OutboxError && /actor/.test(err.message));
      assert.throws(() => h.outbox.send({ modemId: 'gsm1', number: '12345', text: '   ', actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'invalid');
      assert.equal(h.db.prepare('SELECT count(*) AS n FROM sms_outbox').get()?.n, 0, 'a refused send stores nothing');
      const queued = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: '  Привет\nиз Aster \\ tab\t', actor: 'admin' });
      assert.deepEqual(queued, { id: 1, operationId: 1, attemptNo: 1 });
      const stored = h.outbox.get(1);
      assert.ok(stored);
      assert.deepEqual([stored.status, stored.attempt_no, stored.text, stored.number, stored.modem_id, stored.created_at, stored.attempts], ['queued', 0, 'Привет\nиз Aster \\ tab\t', '+1234567890', 'gsm1', T0, []]);
      const op = await h.wait(queued);
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(op.modem_id, 'gsm1');
      assert.deepEqual(op.params, { outbox_id: 1 });
      assert.deepEqual(op.result, { outbox_id: 1, attempt_no: 1, modem_id: 'gsm1', driver: 'quectel', action: 'QuectelSendSMS', number: '+1234567890', reply: '[gsm1] SMS queued for send', status: 'submitted', observed_at: T0 });
      assert.deepEqual(h.ami?.sms, [{ device: 'gsm1', number: '+1234567890', message: 'Привет\\nиз Aster \\\\ tab\\t', validity: '180', report: '1', payload: '1:1' }]);
      assert.deepEqual(h.ami?.calls, ['QuectelSendSMS gsm1']);
      const row = h.outbox.get(1);
      assert.ok(row);
      assert.deepEqual([row.status, row.attempt_no, row.last_error, row.updated_at], ['submitted', 1, null, T0]);
      assert.deepEqual(row.attempts, [{ outbox_id: 1, attempt_no: 1, submitted_at: T0, ami_result: '[gsm1] SMS queued for send', report0_at: null, report0_success: null, report1_at: null, report1_success: null, report2_at: null, report_raw: null, status: 'submitted' }]);
      assert.deepEqual(h.events.map((event) => [event.status, event.message]), [['queued', null], ['running', null], ['running', 'QuectelSendSMS'], ['done', null]]);
      const dongle = await h.wait(h.outbox.send({ modemId: 'gsm2', number: '102', text: 'short code', actor: 'cli' }));
      assert.equal(dongle.status, 'done', dongle.error ?? '');
      assert.deepEqual([/** @type {any} */ (dongle.result).action, dongle.actor, h.ami?.sms[1]?.payload], ['DongleSendSMS', 'cli', '2:1']);
    } finally {
      await h.stop();
    }
  });

  test('a driver error → failed with the driver\'s text; no response → uncertain; AMI down or absent → failed; a modem gone from the registry → failed', async () => {
    const h = started(harness());
    try {
      const device = h.ami?.devices.get('gsm1');
      assert.ok(device);
      device.state = 'Stopped';
      let op = await h.wait(h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' }));
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'QuectelSendSMS gsm1: [gsm1] Device disconnected');
      assert.deepEqual(op.result, { outbox_id: 1, attempt_no: 1, modem_id: 'gsm1', driver: 'quectel', action: 'QuectelSendSMS', number: '+1234567890', reply: '[gsm1] Device disconnected', status: 'failed', observed_at: T0 });
      let row = h.outbox.get(1);
      assert.deepEqual([row?.status, row?.last_error, row?.attempts[0]?.status, row?.attempts[0]?.ami_result], ['failed', '[gsm1] Device disconnected', 'failed', '[gsm1] Device disconnected']);
      device.state = 'Free';
      if (h.ami) h.ami.onAction = () => { throw new AmiTimeout('QuectelSendSMS', 'ami-9', 500); };
      op = await h.wait(h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' }));
      assert.equal(op.status, 'uncertain');
      assert.equal(op.error, 'QuectelSendSMS gsm1: AMI QuectelSendSMS (ami-9) got no response within 500 ms; whether the driver received the SMS is unknown');
      row = h.outbox.get(2);
      assert.deepEqual([row?.status, row?.last_error, row?.attempts[0]?.status, row?.attempts[0]?.ami_result], ['uncertain', op.error, 'uncertain', null]);
      if (h.ami) h.ami.onAction = null;
      /** @type {Registry | null} */
      let current = REGISTRY;
      const gone = started(harness({ registry: () => current }));
      try {
        const queued = gone.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' });
        current = validate({ version: 1, modems: [], phones: [] });
        op = await gone.wait(queued);
        assert.deepEqual([op.status, op.error], ['failed', 'modem gsm1 is not in the registry; the SMS was not sent']);
        assert.deepEqual([gone.outbox.get(1)?.status, gone.outbox.get(1)?.last_error, gone.outbox.get(1)?.attempts], ['failed', op.error, []]);
        current = null;
        assert.throws(() => gone.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'unavailable');
      } finally {
        await gone.stop();
      }
    } finally {
      await h.stop();
    }
    const down = started(harness({ connected: false }));
    try {
      const op = await down.wait(down.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' }));
      assert.deepEqual([op.status, op.error], ['failed', 'Asterisk is not connected over AMI (connecting); the SMS was not sent']);
      assert.deepEqual([down.outbox.get(1)?.status, down.outbox.get(1)?.attempts[0]?.status, down.ami?.calls], ['failed', 'failed', []]);
      assert.deepEqual(down.events.map((event) => event.message).filter(Boolean), ['waiting for the AMI connection'], 'it waited for the action timeout first');
      // the client comes up while the operation waits: the SMS is sent
      const queued = down.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'later', actor: 'admin' });
      setTimeout(() => {
        if (down.ami) down.ami.up = true;
        down.ami?.emit('up');
      }, 50);
      const late = await down.wait(queued);
      assert.equal(late.status, 'done', late.error ?? '');
      assert.deepEqual([down.outbox.get(2)?.status, down.ami?.calls], ['submitted', ['QuectelSendSMS gsm1']]);
    } finally {
      await down.stop();
    }
    const none = started(harness({ ami: false }));
    try {
      const op = await none.wait(none.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' }));
      assert.deepEqual([op.status, op.error, none.outbox.get(1)?.last_error], ['failed', 'the controller has no AMI connection to Asterisk; the SMS was not sent', 'the controller has no AMI connection to Asterisk; the SMS was not sent']);
    } finally {
      await none.stop();
    }
  });

  test('a report dispatched before the response is handled keeps its status: the reply is stored, the row stays rejected, the operation is done', async () => {
    const h = started(harness());
    try {
      if (h.ami) {
        h.ami.onAction = (name, headers) => {
          if (name === 'QuectelSendSMS') h.ami?.emitReport('gsm1', { payload: String(headers.Payload), type: 0, success: 0 });
          return undefined;
        };
      }
      const op = await h.wait(h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' }));
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(/** @type {any} */ (op.result).status, 'rejected');
      const row = h.outbox.get(1);
      assert.deepEqual([row?.status, row?.last_error], ['rejected', 'the modem or the network rejected the submission (send error)']);
      assert.deepEqual([row?.attempts[0]?.status, row?.attempts[0]?.ami_result, row?.attempts[0]?.report0_success], ['rejected', '[gsm1] SMS queued for send', 0]);
    } finally {
      await h.stop();
    }
  });

  test('retry: failed freely; uncertain, rejected, undelivered and undelivered_expired with confirm; nothing else; not while queued; attempt n+1 carries its own payload', async () => {
    const h = started(harness());
    try {
      const device = h.ami?.devices.get('gsm1');
      assert.ok(device);
      device.state = 'Stopped';
      const first = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' });
      assert.equal((await h.wait(first)).status, 'failed');
      device.state = 'Free';
      assert.throws(() => h.outbox.retry(99, { actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'not-found');
      assert.throws(() => h.outbox.retry(1, { actor: /** @type {any} */ ('nobody') }), (err) => err instanceof OutboxError && err.code === 'invalid');
      const retry = h.outbox.retry(1, { actor: 'admin' });
      assert.deepEqual(retry, { id: 1, operationId: 2, attemptNo: 2 });
      assert.deepEqual([h.outbox.get(1)?.status, h.outbox.get(1)?.attempt_no, h.outbox.get(1)?.last_error], ['queued', 1, null]);
      assert.throws(() => h.outbox.retry(1, { actor: 'admin', confirm: true }), (err) => err instanceof OutboxError && err.code === 'not-retryable' && /is queued/.test(err.message));
      const op = await h.wait(retry);
      assert.equal(op.status, 'done', op.error ?? '');
      const row = h.outbox.get(1);
      assert.deepEqual([row?.status, row?.attempt_no, row?.attempts.map((attempt) => [attempt.attempt_no, attempt.status])], ['submitted', 2, [[1, 'failed'], [2, 'submitted']]]);
      assert.deepEqual(h.ami?.sms.map((sms) => sms.payload), ['1:2']);
      assert.throws(() => h.outbox.retry(1, { actor: 'admin', confirm: true }), (err) => err instanceof OutboxError && err.code === 'not-retryable' && /is submitted/.test(err.message));
      // the report states
      h.ami?.emitReport('gsm1', { payload: '1:2', type: 1, success: 1, report: '000,' });
      assert.throws(() => h.outbox.retry(1, { actor: 'admin', confirm: true }), (err) => err instanceof OutboxError && err.code === 'not-retryable' && /is delivered/.test(err.message));
      for (const [type, success, status] of /** @type {Array<[0 | 1 | 2, 0 | 1, string]>} */ ([[0, 0, 'rejected'], [1, 0, 'undelivered'], [2, 0, 'undelivered_expired']])) {
        const queued = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: status, actor: 'admin' });
        await h.wait(queued);
        h.ami?.emitReport('gsm1', { payload: `${queued.id}:1`, type, success });
        assert.equal(h.outbox.get(queued.id)?.status, status);
        assert.throws(() => h.outbox.retry(queued.id, { actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'confirm-required' && err.message.includes(status), status);
        assert.throws(() => h.outbox.retry(queued.id, { actor: 'admin', confirm: /** @type {any} */ ('yes') }), (err) => err instanceof OutboxError && err.code === 'confirm-required', 'confirm must be true');
        assert.equal(h.outbox.get(queued.id)?.status, status, 'a refused retry changes nothing');
        const again = h.outbox.retry(queued.id, { actor: 'admin', confirm: true });
        assert.equal((await h.wait(again)).status, 'done');
        assert.deepEqual([h.outbox.get(queued.id)?.status, h.outbox.get(queued.id)?.attempt_no], ['submitted', 2]);
      }
      // uncertain
      if (h.ami) h.ami.onAction = () => { throw new AmiTimeout('QuectelSendSMS', 'ami-9', 500); };
      const unsure = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'unsure', actor: 'admin' });
      assert.equal((await h.wait(unsure)).status, 'uncertain');
      if (h.ami) h.ami.onAction = null;
      assert.throws(() => h.outbox.retry(unsure.id, { actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'confirm-required');
      assert.equal((await h.wait(h.outbox.retry(unsure.id, { actor: 'admin', confirm: true }))).status, 'done');
      assert.deepEqual([h.outbox.get(unsure.id)?.status, h.outbox.get(unsure.id)?.attempts.length], ['submitted', 2]);
    } finally {
      await h.stop();
    }
  });

  test('remove: an SMS whose sending has ended; purge: only the ones without success; attempts go with them, a late report changes nothing', async () => {
    const h = started(harness());
    try {
      const device = h.ami?.devices.get('gsm1');
      assert.ok(device);
      device.state = 'Stopped';
      const failed = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'failed', actor: 'admin' });
      assert.equal((await h.wait(failed)).status, 'failed');
      device.state = 'Free';
      const sent = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'sent', actor: 'admin' });
      await h.wait(sent);
      assert.equal(h.outbox.get(sent.id)?.status, 'submitted');

      assert.throws(() => h.outbox.remove(99, { actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'not-found');
      assert.throws(() => h.outbox.remove(failed.id, { actor: /** @type {any} */ ('nobody') }), (err) => err instanceof OutboxError && err.code === 'invalid');
      assert.throws(() => h.outbox.remove(sent.id, { actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'not-removable' && /is submitted/.test(err.message));
      h.ami?.emitReport('gsm1', { payload: `${sent.id}:1`, type: 1, success: 1, report: '000,' });
      assert.equal(h.outbox.get(sent.id)?.status, 'delivered');
      const queued = h.outbox.retry(failed.id, { actor: 'admin' });
      assert.throws(() => h.outbox.remove(failed.id, { actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'not-removable' && /is queued/.test(err.message), 'a queued retry is in flight');
      await h.wait(queued);
      h.ami?.emitReport('gsm1', { payload: `${failed.id}:2`, type: 2, success: 0 });
      assert.deepEqual([h.outbox.get(failed.id)?.status, h.outbox.get(failed.id)?.attempts.length], ['undelivered_expired', 2]);

      assert.deepEqual(h.outbox.remove(failed.id, { actor: 'admin' }), { id: failed.id, status: 'undelivered_expired' });
      assert.equal(h.outbox.get(failed.id), null);
      assert.equal(Number(/** @type {any} */ (h.db.prepare('SELECT count(*) AS n FROM sms_attempts WHERE outbox_id = ?').get(failed.id)).n), 0, 'the attempts go with it');
      assert.throws(() => h.outbox.remove(failed.id, { actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'not-found');
      assert.equal(applyReport(h.db, { payload: `${failed.id}:2`, type: 1, success: 1, scts: null, dt: null, raw: '000,', source: 'ami', modemId: 'gsm1', at: T0 }).outcome, 'unknown');
      const next = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'next', actor: 'admin' });
      assert.ok(next.id > sent.id, 'a deleted id is never given to another SMS');
      await h.wait(next);

      // purge: every removable status, of one modem or all; nothing else
      const statuses = ['failed', 'uncertain', 'rejected', 'undelivered', 'undelivered_expired', 'queued', 'submitting', 'submitted', 'accepted', 'delivered'];
      const insert = h.db.prepare("INSERT INTO sms_outbox (modem_id, number, text, status, attempt_no, created_at, updated_at) VALUES (?, '+1234567890', 'x', ?, 1, 0, 0)");
      for (const modem of ['gsm1', 'gsm2', 'gsm9']) for (const status of statuses) insert.run(modem, status);
      const left = () => /** @type {any[]} */ (h.db.prepare('SELECT modem_id, status FROM sms_outbox WHERE text = ? ORDER BY id').all('x')).map((r) => `${r.modem_id}:${r.status}`);
      assert.throws(() => h.outbox.purge({ modemId: '', actor: 'admin' }), (err) => err instanceof OutboxError && err.code === 'invalid');
      assert.deepEqual(h.outbox.purge({ modemId: 'gsm9', actor: 'admin' }), { deleted: 5 }, 'a modem no longer in the registry');
      assert.deepEqual(h.outbox.purge({ modemId: 'gsm9', actor: 'admin' }), { deleted: 0 });
      assert.deepEqual(h.outbox.purge({ actor: 'admin' }), { deleted: 10 });
      const kept = statuses.slice(5);
      assert.deepEqual(left(), ['gsm1', 'gsm2', 'gsm9'].flatMap((modem) => kept.map((status) => `${modem}:${status}`)));
      assert.deepEqual([h.outbox.get(sent.id)?.status, h.outbox.get(next.id)?.status], ['delivered', 'submitted'], 'the SMS sent through the outbox stay');
      assert.deepEqual(h.outbox.remove(sent.id, { actor: 'admin' }), { id: sent.id, status: 'delivered' }, 'a delivered SMS is deleted one at a time');
    } finally {
      await h.stop();
    }
  });

  test('a report that arrives for a queued retry wins: the row moves to delivered and the send is refused without a request', async () => {
    const h = harness();
    try {
      h.outbox.start();
      const first = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' });
      h.runner.start();
      assert.equal((await h.wait(first)).status, 'done');
      h.ami?.emitReport('gsm1', { payload: '1:1', type: 2, success: 0 });
      assert.equal(h.outbox.get(1)?.status, 'undelivered_expired');
      const retry = h.outbox.retry(1, { actor: 'admin', confirm: true });
      // before the operation runs (it starts on the next event-loop turn), the status report of attempt 1 arrives
      assert.equal(applyReport(h.db, { payload: '1:1', type: 1, success: 1, scts: null, dt: null, raw: '000,', source: 'ami', modemId: 'gsm1', at: T0 }).outbox, 'delivered');
      const op = await h.wait(retry);
      assert.deepEqual([op.status, op.error], ['failed', 'outbox 1 is delivered, not queued; nothing was sent']);
      assert.deepEqual([h.outbox.get(1)?.status, h.outbox.get(1)?.attempts.length, h.ami?.sms.length], ['delivered', 1, 1]);
      // operations with unusable params
      for (const [params, error] of [[{ outbox_id: 'x' }, 'sms-send needs params.outbox_id, not "x"'], [{ outbox_id: 77 }, 'outbox 77 does not exist; nothing was sent'], [null, 'sms-send needs params.outbox_id, not undefined']]) {
        const bad = await h.runner.wait(h.runner.enqueue({ kind: KIND, modemId: 'gsm1', params: /** @type {any} */ (params), actor: 'admin' }));
        assert.deepEqual([bad.status, bad.error], ['failed', error]);
      }
    } finally {
      await h.stop();
    }
  });

  test('boot: an attempt left submitting is uncertain, and an interrupted sms-send is re-evaluated from its row', async () => {
    // a controller that died while the driver had not answered yet
    const dead = started(harness());
    if (dead.ami) dead.ami.onAction = () => new Promise(() => {});
    const hung = dead.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([dead.outbox.get(1)?.status, dead.runner.get(hung.operationId)?.status], ['submitting', 'running']);
    // rows a crash between two statements leaves behind: an operation running with its row still queued, or already settled
    for (const [id, status, attemptNo, attempts] of /** @type {Array<[number, string, number, string[]]>} */ ([[2, 'queued', 0, []], [3, 'submitted', 1, ['submitted']], [4, 'failed', 1, ['failed']]])) {
      dead.db.prepare("INSERT INTO sms_outbox (id, modem_id, number, text, status, attempt_no, created_at, updated_at, last_error) VALUES (?, 'gsm1', '+1234567890', 'hi', ?, ?, ?, ?, ?)").run(id, status, attemptNo, T0, T0, status === 'failed' ? '[gsm1] Device disconnected' : null);
      for (const [index, attemptStatus] of attempts.entries()) dead.db.prepare('INSERT INTO sms_attempts (outbox_id, attempt_no, submitted_at, status) VALUES (?, ?, ?, ?)').run(id, index + 1, T0, attemptStatus);
      dead.db.prepare("INSERT INTO operations (kind, modem_id, status, params_json, actor, created_at, started_at) VALUES ('sms-send', 'gsm1', 'running', ?, 'admin', ?, ?)").run(JSON.stringify({ outbox_id: id }), T0, T0);
    }
    dead.outbox.stop();
    dead.db.close(); // the hung handler never settles; its runner is left behind like the dead process
    const h = harness({ path: dead.dbPath });
    try {
      h.clock.now = T0 + 5000;
      assert.deepEqual(h.outbox.start(), { interrupted: 1, expired: 0 });
      const summary = h.runner.start();
      assert.deepEqual([summary.interrupted, summary.reevaluating], [4, 4]);
      const ops = await Promise.all([1, 2, 3, 4].map((id) => h.runner.wait(id)));
      assert.deepEqual(ops.map((op) => [op.status, op.error]), [
        ['uncertain', RESTARTED],
        ['done', null],
        ['done', null],
        ['failed', '[gsm1] Device disconnected'],
      ]);
      assert.deepEqual([h.outbox.get(1)?.status, h.outbox.get(1)?.last_error, h.outbox.get(1)?.attempts[0]?.status, h.outbox.get(1)?.updated_at], ['uncertain', RESTARTED, 'uncertain', T0 + 5000]);
      assert.deepEqual([h.outbox.get(2)?.status, h.outbox.get(2)?.attempts.length, h.ami?.sms.map((sms) => sms.payload)], ['submitted', 1, ['2:1']], 'the queued one was sent now');
      assert.deepEqual([h.outbox.get(3)?.status, /** @type {any} */ (ops[2]?.result).status], ['submitted', 'submitted'], 'the settled one is reported from its row');
      assert.ok(ops.every((op) => op.result?.interrupted_at === T0 + 5000));
      assert.throws(() => h.outbox.start(), /already started/);
    } finally {
      await h.stop();
    }
    // the runner may re-evaluate before the outbox sweep runs: the re-evaluation itself marks a submitting row uncertain
    const other = started(harness());
    if (other.ami) other.ami.onAction = () => new Promise(() => {});
    const hung2 = other.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    other.outbox.stop();
    other.db.close();
    const late = harness({ path: other.dbPath });
    try {
      late.runner.start();
      const op = await late.runner.wait(hung2.operationId);
      assert.deepEqual([op.status, op.error], ['uncertain', RESTARTED]);
      assert.deepEqual([late.outbox.get(1)?.status, late.outbox.get(1)?.last_error, late.outbox.get(1)?.attempts[0]?.status], ['uncertain', RESTARTED, 'uncertain']);
      assert.deepEqual(late.outbox.start(), { interrupted: 0, expired: 0 }, 'nothing left for the sweep');
    } finally {
      await late.stop();
    }
  });

  test('the expiry sweep: submitted without any report for validity + grace → uncertain; a late report still resolves it', async () => {
    const h = started(harness({ timing: { validityMs: 60_000, graceMs: 30_000 } }));
    try {
      const queued = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'hi', actor: 'admin' });
      assert.equal((await h.wait(queued)).status, 'done');
      assert.equal(h.ami?.sms[0]?.validity, '1', 'the validity goes to the driver in whole minutes');
      h.clock.now = T0 + 90_000 - 1;
      assert.deepEqual(h.outbox.sweep(), { interrupted: 0, expired: 0 });
      assert.equal(h.outbox.get(1)?.status, 'submitted');
      h.clock.now = T0 + 90_000;
      assert.deepEqual(h.outbox.sweep(), { interrupted: 0, expired: 1 });
      const row = h.outbox.get(1);
      assert.deepEqual([row?.status, row?.last_error, row?.attempts[0]?.status, row?.updated_at], ['uncertain', 'no report within 2 min of the submission (validity 1 min); the driver no longer tracks the SMS', 'uncertain', T0 + 90_000]);
      assert.deepEqual(h.outbox.sweep(), { interrupted: 0, expired: 0 }, 'once');
      h.ami?.emitReport('gsm1', { payload: '1:1', type: 1, success: 1, report: '000,' });
      assert.deepEqual([h.outbox.get(1)?.status, h.outbox.get(1)?.last_error], ['delivered', null]);
      // an attempt with a report is never swept
      const second = h.outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'two', actor: 'admin' });
      await h.wait(second);
      h.ami?.emitReport('gsm1', { payload: '2:1', type: 0, success: 1 });
      h.clock.now = T0 + 500_000;
      assert.deepEqual(h.outbox.sweep(), { interrupted: 0, expired: 0 });
      assert.equal(h.outbox.get(2)?.status, 'accepted');
    } finally {
      await h.stop();
    }
  });

  test('through the real AMI client: the request on the wire (escapes, Validity, Report, Payload) and a Report event in the same read as the response', async () => {
    /** @type {Array<Map<string, string>>} */
    const requests = [];
    const server = await fakeAmi([asterisk((request) => {
      if (request.get('Action') !== 'QuectelSendSMS') return undefined;
      requests.push(new Map(request));
      const id = request.get('ActionID') ?? '';
      return packet(['Response: Success', `ActionID: ${id}`, 'Message: [gsm1] SMS queued for send'])
        + packet(['Event: QuectelReport', 'Privilege: call,all', 'Device: gsm1', `Payload: ${request.get('Payload') ?? ''}`, 'SCTS: ', 'DT: ', 'Success: 0', 'Type: 0', 'Report: ']);
    })]);
    const client = new AmiClient({ backoffMinMs: 100, backoffMaxMs: 500 });
    const db = open(join(tmp, `wire-${++counter}.db`));
    migrate(db);
    const runner = createRunner({ db, ami: client, bus: createBus() });
    const outbox = createOutbox({ db, registry: () => REGISTRY, timing: { actionTimeoutMs: 2_000 } });
    outbox.register(runner);
    const listener = createReportListener({ ami: client, db });
    try {
      await client.connect({ host: '127.0.0.1', port: server.port, username: 'aster', secret: 'test' });
      runner.start();
      const queued = outbox.send({ modemId: 'gsm1', number: '+1234567890', text: 'line1\nline2 \\ tab\t end', actor: 'admin' });
      const op = await runner.wait(queued.operationId);
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.deepEqual([request?.get('Device'), request?.get('Number'), request?.get('Message'), request?.get('Validity'), request?.get('Report'), request?.get('Payload')],
        ['gsm1', '+1234567890', 'line1\\nline2 \\\\ tab\\t end', '180', '1', '1:1']);
      const row = outbox.get(1);
      assert.deepEqual([row?.status, row?.attempts[0]?.status, row?.attempts[0]?.ami_result, row?.attempts[0]?.report0_success, /** @type {any} */ (op.result).status],
        ['rejected', 'rejected', '[gsm1] SMS queued for send', 0, 'rejected']);
    } finally {
      listener.stop();
      await runner.stop();
      db.close();
      await client.close();
      await server.close();
    }
  });
});
