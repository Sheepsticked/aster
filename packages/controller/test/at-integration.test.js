// @ts-check
// Integration test for src/at/ against a real Asterisk (setup as in apply-integration.test.js); skipped unless ASTER_AMI_TEST=1.
// A container has no modem, so only refusals are checked here; the success paths need hardware.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { AmiClient } from '../src/ami/client.js';
import { createAtOps } from '../src/at/client.js';
import { createForwardingOps } from '../src/at/forwarding.js';
import { createUssdOps } from '../src/at/ussd.js';
import { createBus } from '../src/bus.js';
import { load } from '../src/config/registry.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_REGISTRY = join(REPO, 'docker/asterisk/test-registry.yaml');
const enabled = process.env.ASTER_AMI_TEST === '1' && Boolean(process.env.ASTER_APPLY_HOME);
const host = process.env.ASTER_AMI_HOST ?? '127.0.0.1';
const port = Number(process.env.ASTER_AMI_PORT ?? '5038');
const CONNECT_WITHIN_MS = 30_000;

describe('at integration', { skip: !enabled && 'set ASTER_AMI_TEST=1 and ASTER_APPLY_HOME with the test-config container running (see the file header)' }, () => {
  const home = String(process.env.ASTER_APPLY_HOME);
  /** @type {AmiClient} */
  let client;
  /** every action sent: name and headers @type {Array<{ name: string, headers: Record<string, unknown> }>} */
  const sent = [];
  /** every event received @type {string[]} */
  const events = [];
  /** @type {import('node:sqlite').DatabaseSync} */
  let db;
  /** @type {import('../src/ops/runner.js').Runner} */
  let runner;
  /** @type {ReturnType<typeof createAtOps>} */
  let atOps;
  const registry = () => load(TEST_REGISTRY).registry;
  /** @param {string} kind @param {string} modemId @param {Record<string, unknown>} params */
  const run = (kind, modemId, params) => runner.wait(runner.enqueue({ kind, modemId, params, actor: 'admin' }));

  before(async () => {
    client = new AmiClient({ backoffMinMs: 200, backoffMaxMs: 2_000 });
    const action = client.action.bind(client);
    client.action = (name, headers, options) => {
      sent.push({ name, headers: { ...headers } });
      return action(name, headers, options);
    };
    client.on('event', (packet) => events.push(String(packet.get('Event'))));
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
    db = open(join(home, 'state', 'at-integration.db'));
    migrate(db);
    runner = createRunner({ db, ami: client, bus: createBus() });
    atOps = createAtOps({ registry, timing: { actionTimeoutMs: 30_000 } });
    atOps.register(runner);
    createForwardingOps({ db, registry, timing: { actionTimeoutMs: 30_000, timeoutS: 5 } }).register(runner);
    createUssdOps({ registry, timing: { actionTimeoutMs: 30_000, answerTimeoutMs: 5_000 } }).register(runner);
    runner.start();
  });

  after(async () => {
    await runner?.stop();
    db?.close();
    await client?.close();
  });

  test('AtCommand on the stopped [gsm_test] is refused with Device not connected → the at operation failed, no event', async () => {
    const op = await atOps.run('gsm_test', 'AT+CSQ', { timeout: 5 });
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'AT+CSQ: Device not connected');
    const result = /** @type {any} */ (op.result);
    assert.deepEqual([result.modem_id, result.driver, result.action_id, result.outcome, result.error, result.reply, result.lines, result.timeout_s],
      ['gsm_test', 'quectel', `at-${op.id}`, 'refused', 'Device not connected', 'Device not connected', [], 5]);
    const request = sent.find((s) => s.name === 'QuectelAtCommand');
    assert.deepEqual(request?.headers, { Device: 'gsm_test', Command: 'AT+CSQ', ActionID: `at-${op.id}`, Timeout: '5' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(events.filter((e) => e.startsWith('QuectelAt')), [], 'a refused action leaves no AtResponse/AtDone');
  });

  test('the same through chan_dongle on [gsm_dongle]; a device the driver does not know → Device not found', async () => {
    let op = await atOps.run('gsm_dongle', 'AT+CSQ');
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'AT+CSQ: Device not connected');
    assert.equal(sent.find((s) => s.name === 'DongleAtCommand')?.headers.Device, 'gsm_dongle');
    op = await runner.wait(runner.enqueue({ kind: 'at', modemId: 'nosuch', params: { command: 'AT', driver: 'quectel' }, actor: 'admin' }));
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'AT: Device not found');
  });

  test('a forwarding query on the stopped device is failed and stores an unverified state', async () => {
    const op = await run('forwarding', 'gsm_test', { action: 'query' });
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'AT+CCFC=0,2: Device not connected');
    const result = /** @type {any} */ (op.result);
    const verdict = result.forwarding.unconditional;
    assert.deepEqual([result.mutation, result.queries[0].outcome, result.queries[0].action_id, verdict.verified, verdict.outcome, verdict.error],
      [null, 'refused', `at-${op.id}.2`, false, 'error', 'Device not connected']);
    const row = /** @type {any} */ (db.prepare("SELECT forwarding_json AS f FROM modem_forwarding WHERE modem_id = 'gsm_test'").get());
    assert.deepEqual(JSON.parse(row.f), result.forwarding);
    const set = await run('forwarding', 'gsm_test', { action: 'set', number: '+1234567890' });
    assert.equal(set.status, 'failed');
    assert.equal(set.error, 'AT+CCFC=0,3,"+1234567890",145: Device not connected');
    assert.deepEqual(/** @type {any} */ (set.result).queries, [], 'no query after a refusal');
  });

  test('SendUSSD to the stopped device → [gsm_test] Device disconnected → failed', async () => {
    const op = await run('ussd', 'gsm_test', { code: '*100#' });
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'QuectelSendUSSD gsm_test: [gsm_test] Device disconnected');
    assert.deepEqual(sent.find((s) => s.name === 'QuectelSendUSSD')?.headers, { Device: 'gsm_test', USSD: '*100#' });
  });

  test('a USSD cancel on the stopped device → AtCommand refused → failed', async () => {
    const op = await run('ussd-cancel', 'gsm_test', {});
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'AT+CUSD=2: Device not connected');
    const request = sent.find((s) => s.name === 'QuectelAtCommand' && s.headers.Command === 'AT+CUSD=2');
    assert.deepEqual(request?.headers, { Device: 'gsm_test', Command: 'AT+CUSD=2', ActionID: `ussd-cancel-${op.id}`, Timeout: '15' });
  });
});
