// @ts-check
// Integration test for src/sms/outbox.js against a real Asterisk (setup as in apply-integration.test.js); skipped unless
// ASTER_AMI_TEST=1. A container has no modem, so only refusals are checked; a real submission needs hardware.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { AmiClient, AmiError } from '../src/ami/client.js';
import { createBus } from '../src/bus.js';
import { load } from '../src/config/registry.js';
import { createRunner } from '../src/ops/runner.js';
import { createOutbox } from '../src/sms/outbox.js';
import { migrate, open } from '../src/store/db.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_REGISTRY = join(REPO, 'docker/asterisk/test-registry.yaml');
const enabled = process.env.ASTER_AMI_TEST === '1' && Boolean(process.env.ASTER_APPLY_HOME);
const host = process.env.ASTER_AMI_HOST ?? '127.0.0.1';
const port = Number(process.env.ASTER_AMI_PORT ?? '5038');
const CONNECT_WITHIN_MS = 30_000;

describe('sms integration', { skip: !enabled && 'set ASTER_AMI_TEST=1 and ASTER_APPLY_HOME with the test-config container running (see the file header)' }, () => {
  const home = String(process.env.ASTER_APPLY_HOME);
  /** @type {AmiClient} */
  let client;
  /** every action sent: name and headers @type {Array<{ name: string, headers: Record<string, unknown> }>} */
  const sent = [];
  /** @type {import('node:sqlite').DatabaseSync} */
  let db;
  /** @type {import('../src/ops/runner.js').Runner} */
  let runner;
  /** @type {ReturnType<typeof createOutbox>} */
  let outbox;

  before(async () => {
    client = new AmiClient({ backoffMinMs: 200, backoffMaxMs: 2_000 });
    const action = client.action.bind(client);
    client.action = (name, headers, options) => {
      sent.push({ name, headers: { ...headers } });
      return action(name, headers, options);
    };
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no AMI login at ${host}:${port} within ${CONNECT_WITHIN_MS} ms: ${client.lastError?.message ?? 'no answer'}`)), CONNECT_WITHIN_MS);
    });
    try {
      await Promise.race([client.connect({ host, port, username: 'aster', secret: 'test' }), deadline]);
    } finally {
      clearTimeout(timer);
    }
    mkdirSync(join(home, 'state'), { recursive: true });
    db = open(join(home, 'state', 'sms-integration.db'));
    migrate(db);
    runner = createRunner({ db, ami: client, bus: createBus() });
    outbox = createOutbox({ db, registry: () => load(TEST_REGISTRY).registry, timing: { actionTimeoutMs: 30_000 } });
    outbox.register(runner);
    outbox.start();
    runner.start();
  });

  after(async () => {
    outbox?.stop();
    await runner?.stop();
    db?.close();
    await client?.close();
  });

  test('SendSMS to the stopped [gsm_test] → AMI Error → failed; the same through chan_dongle; a retry makes attempt 2 with its own payload', { timeout: 120_000 }, async () => {
    const queued = outbox.send({ modemId: 'gsm_test', number: '+1234567890', text: 'Aster integration', actor: 'admin' });
    let op = await runner.wait(queued.operationId);
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'QuectelSendSMS gsm_test: [gsm_test] Device disconnected');
    let row = outbox.get(queued.id);
    assert.ok(row);
    assert.deepEqual([row.status, row.last_error, row.attempt_no], ['failed', '[gsm_test] Device disconnected', 1]);
    assert.deepEqual(row.attempts.map((attempt) => [attempt.attempt_no, attempt.status, attempt.ami_result]), [[1, 'failed', '[gsm_test] Device disconnected']]);
    const request = sent.find((entry) => entry.name === 'QuectelSendSMS');
    assert.deepEqual(request?.headers, { Device: 'gsm_test', Number: '+1234567890', Message: 'Aster integration', Validity: 180, Report: 1, Payload: `${queued.id}:1` });

    const dongle = outbox.send({ modemId: 'gsm_dongle', number: '+1234567890', text: 'via chan_dongle', actor: 'admin' });
    op = await runner.wait(dongle.operationId);
    assert.deepEqual([op.status, op.error], ['failed', 'DongleSendSMS gsm_dongle: [gsm_dongle] Device disconnected']);

    const retry = outbox.retry(queued.id, { actor: 'admin' });
    assert.equal(retry.attemptNo, 2);
    op = await runner.wait(retry.operationId);
    assert.deepEqual([op.status, op.error], ['failed', 'QuectelSendSMS gsm_test: [gsm_test] Device disconnected']);
    row = outbox.get(queued.id);
    assert.deepEqual(row?.attempts.map((attempt) => [attempt.attempt_no, attempt.status]), [[1, 'failed'], [2, 'failed']]);
    assert.deepEqual(sent.filter((entry) => entry.name === 'QuectelSendSMS').map((entry) => entry.headers.Payload), [`${queued.id}:1`, `${queued.id}:2`]);
  });

  test('the drivers check the number before the device, answer Device disconnected for a device they do not know, and refuse missing headers', { timeout: 60_000 }, async () => {
    /** @param {string} name @param {Record<string, string>} headers @param {string} message */
    const refused = async (name, headers, message) => {
      await assert.rejects(client.action(name, headers), (err) => {
        assert.ok(err instanceof AmiError, String(err));
        assert.equal(err.message, message, `${name} ${JSON.stringify(headers)}`);
        return true;
      });
    };
    await refused('QuectelSendSMS', { Device: 'gsm_test', Number: 'abc', Message: 'x' }, '[gsm_test] Invalid phone number');
    await refused('DongleSendSMS', { Device: 'gsm_dongle', Number: '*100#', Message: 'x' }, '[gsm_dongle] Invalid phone number');
    await refused('QuectelSendSMS', { Device: 'nosuch', Number: '123', Message: 'x' }, '[nosuch] Device disconnected');
    await refused('DongleSendSMS', { Device: 'gsm_test', Number: '123', Message: 'x' }, '[gsm_test] Device disconnected');
    await refused('QuectelSendSMS', { Device: 'gsm_test', Message: 'x' }, 'Number not specified');
    await refused('QuectelSendSMS', { Device: 'gsm_test', Number: '123' }, 'Message not specified');
    await refused('QuectelSendSMS', { Number: '123', Message: 'x' }, 'Device not specified');
  });
});
