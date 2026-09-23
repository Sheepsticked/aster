// @ts-check
// Integration test for src/ami/client.js against the image booted with docker/asterisk/test-config (setup as in the CI workflow
// asterisk-image.yml); skipped unless ASTER_AMI_TEST=1. The last test restarts Asterisk.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, test } from 'node:test';
import { AmiClient, AmiDisconnected, AmiError } from '../src/ami/client.js';

const enabled = process.env.ASTER_AMI_TEST === '1';
const host = process.env.ASTER_AMI_HOST ?? '127.0.0.1';
const port = Number(process.env.ASTER_AMI_PORT ?? '5038');
const CONNECT_WITHIN_MS = 30_000;

describe('ami integration', { skip: !enabled && 'set ASTER_AMI_TEST=1 with the test-config container running (see the file header)' }, () => {
  /** @type {AmiClient} */
  let client;

  before(async () => {
    client = new AmiClient({ backoffMinMs: 200, backoffMaxMs: 2_000 });
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no AMI login at ${host}:${port} within ${CONNECT_WITHIN_MS} ms: ${client.lastError?.message ?? 'no answer'}`)),
        CONNECT_WITHIN_MS);
    });
    try {
      await Promise.race([client.connect({ host, port, username: 'aster', secret: 'test' }), deadline]);
    } finally {
      clearTimeout(timer);
    }
  });

  after(() => client.close());

  test('logs into the test-config container and runs core show uptime', async () => {
    assert.match(String(client.banner), /^Asterisk Call Manager\/\d+\.\d+\.\d+$/);
    const lines = await client.command('core show uptime');
    assert.match(lines[0] ?? '', /^System uptime: /);
    assert.match(lines[1] ?? '', /^Last reload: /);
  });

  test('a failing CLI command rejects with its text; a module reload answers and emits Reload; Ping', async () => {
    await assert.rejects(client.command('pjsip reload'), (err) => err instanceof AmiError
      && err.message === "No such command 'pjsip reload' (type 'core show help pjsip reload' for other possible commands)");
    const reload = once(client, 'event:Reload');
    assert.deepEqual(await client.command('module reload res_pjsip.so'), ["Module 'res_pjsip.so' reloaded successfully."]);
    const [event] = await reload;
    assert.equal(event.get('Module'), 'res_pjsip.so');
    assert.equal((await client.action('Ping')).get('Ping'), 'Pong');
    await assert.rejects(client.action('NoSuchAction'), (err) => err instanceof AmiError && /^Invalid\/unknown command: NoSuchAction\./.test(err.message));
  });

  test('both drivers list the test-config devices', async () => {
    const quectel = await client.list('QuectelShowDevices', {}, 'QuectelShowDevicesComplete');
    assert.deepEqual(quectel.map((p) => p.get('Device')).sort(), ['gsm_test', 'gsm_uac', 'gsm_unmapped']);
    const dongle = await client.list('DongleShowDevices', {}, 'DongleShowDevicesComplete');
    assert.deepEqual(dongle.map((p) => p.get('Device')).sort(), ['gsm_dongle', 'gsm_ports']);
    for (const entry of [...quectel, ...dongle]) {
      for (const field of ['State', 'IMEIState', 'IMSIState', 'DataState', 'AudioState', 'GSMRegistrationStatus', 'RSSI', 'ProviderName',
        'SubscriberNumber', 'CurrentDeviceState', 'DesiredDeviceState']) {
        assert.ok(entry.has(field), `${entry.get('Device')}: ${field}`);
      }
    }
  });

  test('a stopped device refuses an AtCommand with a caller ActionID', async () => {
    await assert.rejects(client.action('QuectelAtCommand', { ActionID: 'at-integration-1', Device: 'gsm_test', Command: 'AT', Timeout: 5 }),
      (err) => err instanceof AmiError && err.message === 'Device not connected' && err.response.get('ActionID') === 'at-integration-1');
  });

  test('core restart gracefully ends the connection; the client reconnects and runs core show uptime again', { timeout: 120_000 }, async () => {
    const down = once(client, 'down');
    const up = once(client, 'up');
    await assert.rejects(client.command('core restart gracefully', { timeout: 60_000 }), (err) => err instanceof AmiDisconnected);
    await down;
    await up;
    const lines = await client.command('core show uptime');
    assert.match(lines[0] ?? '', /^System uptime: \d+ seconds?$/);
  });
});
