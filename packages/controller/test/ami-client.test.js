// @ts-check
// Tests for src/ami/client.js against test/ami-fake-server.js: the captured transcripts replayed request by request, and
// scripted servers for booting, keepalive loss, timeouts, backoff, broken streams and request validation.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { AmiClient, AmiDisconnected, AmiError, AmiTimeout, backoffDelay, DEFAULTS, MAX_HEADERS, MAX_LINE_BYTES } from '../src/ami/client.js';
import { createLogger } from '../src/log.js';
import { asterisk, fakeAmi, packet, retag } from './ami-fake-server.js';

/** @typedef {import('./ami-fake-server.js').Script} Script */
/** @typedef {import('../src/ami/client.js').Options} Options */

/** @param {string} name */
const fixture = (name) => readFileSync(new URL(`./fixtures/ami/${name}`, import.meta.url));
const FAST = { backoffMinMs: 20, backoffMaxMs: 80, connectTimeoutMs: 2_000, actionTimeoutMs: 2_000 };
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {Array<() => Promise<void>>} */
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A logger that keeps its lines as objects. */
function memoryLog() {
  /** @type {Array<Record<string, any>>} */
  const lines = [];
  const log = createLogger({ level: 'debug', stream: { write: (text) => lines.push(JSON.parse(text)) } });
  return { log, lines };
}

/**
 * @param {Script[]} scripts
 * @param {Options} [options]
 */
async function setup(scripts, options = {}) {
  const server = await fakeAmi(scripts);
  const client = new AmiClient({ ...FAST, ...options });
  cleanups.push(() => server.close(), () => client.close());
  const target = { host: '127.0.0.1', port: server.port, username: 'aster', secret: 'test' };
  return { server, client, target };
}

/**
 * @param {{ connections: import('./ami-fake-server.js').Conn[] }} server
 * @param {number} index
 */
function conn(server, index) {
  const found = server.connections[index];
  assert.ok(found, `connection ${index}`);
  return found;
}

describe('ami client', () => {
  test('login.txt: the Login request, up after FullyBooted, close() says Logoff and the server answers Goodbye', async () => {
    const { server, client, target } = await setup([fixture('login.txt')]);
    /** @type {string[]} */
    const seen = [];
    client.on('up', () => seen.push('up'));
    client.on('event', (p) => seen.push(`event ${p.get('Event')}`));
    client.on('down', (err) => seen.push(`down ${err.message}`));
    assert.equal(client.state, 'idle');
    const connecting = client.connect(target);
    assert.equal(client.state, 'connecting');
    await connecting;
    assert.deepEqual(seen, ['up', 'event FullyBooted']);
    assert.equal(client.state, 'up');
    assert.equal(client.connected, true);
    assert.equal(client.banner, 'Asterisk Call Manager/9.0.0');
    assert.equal(client.lastError, null);
    assert.equal(typeof client.since, 'number');
    const first = conn(server, 0);
    assert.equal(first.raw, 'Action: Login\r\nActionID: ami-1\r\nUsername: aster\r\nSecret: test\r\n\r\n');
    await client.close();
    assert.equal(client.state, 'closed');
    assert.equal(client.connected, false);
    assert.deepEqual(seen, ['up', 'event FullyBooted', 'down AMI client closed']);
    assert.equal(first.raw, 'Action: Login\r\nActionID: ami-1\r\nUsername: aster\r\nSecret: test\r\n\r\nAction: Logoff\r\nActionID: ami-2\r\n\r\n');
    await first.closed;
    await client.close();
  });

  test('command.txt: Output lines, a failing CLI command, a reload and its event, dialplan output, an unknown action, Ping', async () => {
    const { server, client, target } = await setup([fixture('command.txt')]);
    await client.connect(target);
    assert.deepEqual(await client.command('core show uptime'), ['System uptime: 4 minutes', 'Last reload: 4 minutes']);
    await assert.rejects(client.command('pjsip reload'), (err) => err instanceof AmiError
      && err.message === "No such command 'pjsip reload' (type 'core show help pjsip reload' for other possible commands)"
      && err.output.length === 1 && err.response.get('Response') === 'Error' && err.response.get('ActionID') === 'ami-3');
    /** @type {string[]} */
    const reloads = [];
    client.on('event:Reload', (p) => reloads.push(p.get('Module')));
    assert.deepEqual(await client.command('module reload res_pjsip.so'), ["Module 'res_pjsip.so' reloaded successfully."]);
    assert.deepEqual(reloads, ['res_pjsip.so'], 'an event in the same read as the response is emitted before the promise settles');
    const dialplan = await client.command('dialplan show smoke');
    assert.equal(dialplan.length, 22);
    assert.equal(dialplan[20], '');
    await assert.rejects(client.action('NoSuchAction'), (err) => err instanceof AmiError
      && err.message === 'Invalid/unknown command: NoSuchAction. Use Action: ListCommands to show available commands.' && err.output.length === 0);
    const pong = await client.action('Ping');
    assert.equal(pong.get('Ping'), 'Pong');
    await client.close();
    assert.deepEqual(conn(server, 0).requests.map((r) => `${r.get('Action')} ${r.get('ActionID')} ${r.get('Command') ?? ''}`.trim()), [
      'Login ami-1', 'Command ami-2 core show uptime', 'Command ami-3 pjsip reload', 'Command ami-4 module reload res_pjsip.so',
      'Command ami-5 dialplan show smoke', 'NoSuchAction ami-6', 'Ping ami-7', 'Logoff ami-8',
    ]);
  });

  test('show-devices.txt: list() collects the DeviceEntry events up to the Complete event; they are not emitted', async () => {
    const { client, target } = await setup([fixture('show-devices.txt')]);
    /** @type {string[]} */
    const emitted = [];
    client.on('event', (p) => emitted.push(String(p.get('Event'))));
    await client.connect(target);
    const quectel = await client.list('QuectelShowDevices', {}, 'QuectelShowDevicesComplete');
    assert.deepEqual(quectel.map((p) => p.get('Device')), ['gsm_test', 'gsm_uac', 'gsm_unmapped']);
    assert.deepEqual(quectel.map((p) => p.get('State')), ['Stopped', 'Stopped', 'Stopped']);
    const dongle = await client.list('DongleShowDevices', {}, 'DongleShowDevicesComplete');
    assert.deepEqual(dongle.map((p) => [p.get('Event'), p.get('Device'), p.get('DataSetting')]),
      [['DongleDeviceEntry', 'gsm_dongle', ''], ['DongleDeviceEntry', 'gsm_ports', '/dev/ttyUSB9']]);
    assert.deepEqual(emitted, ['FullyBooted']);
  });

  test('at-command-refused.txt: caller-chosen ActionIDs are sent as given; a refused AtCommand rejects with its Message', async () => {
    const { server, client, target } = await setup([fixture('at-command-refused.txt')]);
    await client.connect(target);
    await assert.rejects(client.action('QuectelAtCommand', { ActionID: 'at-1', Device: 'gsm_test', Command: 'AT+CCFC=0,2', Timeout: 15 }),
      (err) => err instanceof AmiError && err.message === 'Device not connected');
    await assert.rejects(client.action('DongleAtCommand', { ActionID: 'at-2', Device: 'gsm_dongle', Command: 'AT', Timeout: 0 }),
      (err) => err instanceof AmiError && err.message === 'Invalid Timeout');
    await client.close();
    assert.equal(conn(server, 0).raw, 'Action: Login\r\nActionID: ami-1\r\nUsername: aster\r\nSecret: test\r\n\r\n'
      + 'Action: QuectelAtCommand\r\nActionID: at-1\r\nDevice: gsm_test\r\nCommand: AT+CCFC=0,2\r\nTimeout: 15\r\n\r\n'
      + 'Action: DongleAtCommand\r\nActionID: at-2\r\nDevice: gsm_dongle\r\nCommand: AT\r\nTimeout: 0\r\n\r\n'
      + 'Action: Logoff\r\nActionID: ami-2\r\n\r\n');
  });

  test('restart.txt: the connection ends mid-action → AmiDisconnected, down, reconnect, Login again, up', async () => {
    const { server, client, target } = await setup([fixture('restart.txt'), retag(fixture('login.txt'), { 'ami-1': 'ami-3', 'ami-2': 'ami-4' })]);
    await client.connect(target);
    /** @type {Error[]} */
    const downs = [];
    client.on('down', (err) => downs.push(err));
    const upAgain = once(client, 'up');
    await assert.rejects(client.command('core restart gracefully'), (err) => err instanceof AmiDisconnected
      && err.message === 'AMI connection lost: AMI connection closed by the server' && err.cause instanceof AmiDisconnected);
    assert.equal(downs.length, 1);
    assert.equal(downs[0]?.message, 'AMI connection closed by the server');
    assert.equal(client.state, 'connecting');
    assert.equal(client.lastError, downs[0]);
    await assert.rejects(client.action('Ping'), (err) => err instanceof AmiDisconnected && err.message === 'AMI is not up (connecting)');
    await upAgain;
    assert.equal(client.lastError, null);
    assert.equal(conn(server, 1).requests[0]?.get('ActionID'), 'ami-3', 'ActionIDs keep counting across connections');
    await client.close();
    assert.equal(conn(server, 1).requests[1]?.get('Action'), 'Logoff');
  });

  test('login-failed.txt: a refused login is retried with backoff, logged, kept in lastError, and never emits down', async () => {
    const { log, lines } = memoryLog();
    const { server, client, target } = await setup([
      fixture('login-failed.txt'),
      retag(fixture('login-failed.txt'), { 'ami-1': 'ami-2' }),
      retag(fixture('login.txt'), { 'ami-1': 'ami-3', 'ami-2': 'ami-4' }),
    ], { log, backoffMinMs: 40, backoffMaxMs: 1_000 });
    /** @type {Error[]} */
    const downs = [];
    client.on('down', (err) => downs.push(err));
    const connecting = client.connect(target);
    await server.waitForConnections(2);
    assert.equal(client.connected, false);
    assert.ok(client.lastError instanceof AmiError);
    assert.equal(client.lastError.message, 'AMI login refused: Authentication failed');
    await connecting;
    assert.equal(server.connections.length, 3);
    assert.ok(conn(server, 1).at - conn(server, 0).at >= 35, 'first retry after backoffMinMs');
    assert.ok(conn(server, 2).at - conn(server, 1).at >= 75, 'second retry after twice backoffMinMs');
    assert.deepEqual(downs, []);
    assert.deepEqual(lines.filter((l) => l.level === 'warn').map((l) => [l.msg, l.message, l.retry_ms]),
      [['AMI login refused', 'AMI login refused: Authentication failed', 40], ['AMI login refused', 'AMI login refused: Authentication failed', 80]]);
    assert.ok(!JSON.stringify(lines).includes('"test"'), 'the secret is never logged');
    assert.equal(lines.at(-1)?.msg, 'AMI up');
  });

  test('up resets the backoff: a connection lost after refused logins is retried after backoffMinMs again', async () => {
    const { log, lines } = memoryLog();
    const { server, client, target } = await setup([
      fixture('login-failed.txt'),
      retag(fixture('login-failed.txt'), { 'ami-1': 'ami-2' }),
      asterisk((request, c) => {
        if (request.get('Action') !== 'Drop') return undefined;
        c.socket.destroy();
        return null;
      }),
      asterisk(),
    ], { log, backoffMinMs: 30, backoffMaxMs: 1_000 });
    await client.connect(target);
    const upAgain = once(client, 'up');
    await assert.rejects(client.action('Drop'), (err) => err instanceof AmiDisconnected);
    await upAgain;
    assert.deepEqual(lines.filter((l) => l.level === 'warn').map((l) => [l.msg, l.retry_ms]),
      [['AMI login refused', 30], ['AMI login refused', 60], ['AMI down', 30]]);
    assert.equal(server.connections.length, 4);
  });

  test('close() while retrying rejects connect() and stops reconnecting', async () => {
    const { server, client, target } = await setup([fixture('login-failed.txt')]);
    const connecting = client.connect(target);
    await server.waitForConnections(2);
    // Handle the rejection before close(): close() rejects connect() at once but may then wait for a live socket to close, and a
    // rejection still unhandled when the microtasks run out fails the test as an unhandled rejection.
    const rejected = assert.rejects(connecting, (err) => err instanceof AmiDisconnected && err.message === 'AMI client closed');
    await client.close();
    await rejected;
    const count = server.connections.length;
    await sleep(3 * FAST.backoffMaxMs);
    assert.equal(server.connections.length, count);
  });

  test('booting: logged in without FullyBooted is not up; FullyBooted later brings it up; none within bootTimeoutMs → retry', async () => {
    const { log, lines } = memoryLog();
    const { server, client, target } = await setup([asterisk(undefined, { booted: false }), asterisk(undefined, { booted: false })],
      { log, bootTimeoutMs: 60 });
    const connecting = client.connect(target);
    await server.waitForConnections(2);
    assert.match(String(lines.find((l) => l.msg === 'AMI connection attempt failed')?.err?.message),
      /^AMI logged in but Asterisk sent no FullyBooted within 60 ms \(the AMI user needs read=system\)$/);
    while (client.state !== 'booting') await sleep(2);
    await assert.rejects(client.action('Ping'), (err) => err instanceof AmiDisconnected && err.message === 'AMI is not up (booting)');
    conn(server, 1).send(packet(['Event: FullyBooted', 'Privilege: system,all', 'Status: Fully Booted']));
    await connecting;
    assert.equal(client.state, 'up');
  });

  test('a server that never sends the banner hits connectTimeoutMs; a broken banner is a protocol error; both are retried', async () => {
    const { log, lines } = memoryLog();
    const { server, client, target } = await setup([() => {}, (c) => c.send('HTTP/1.1 400 Bad Request\r\n\r\n'), asterisk()],
      { log, connectTimeoutMs: 50 });
    await client.connect(target);
    assert.equal(server.connections.length, 3);
    const failures = lines.filter((l) => l.msg === 'AMI connection attempt failed').map((l) => [l.err?.name, l.err?.message]);
    assert.deepEqual(failures, [
      ['AmiDisconnected', `AMI login to 127.0.0.1:${target.port} did not finish within 50 ms`],
      ['AmiProtocolError', 'not an AMI banner: "HTTP/1.1 400 Bad Request"'],
    ]);
  });

  test('keepalive: a Ping every pingIntervalMs; an unanswered Ping drops the connection and the client reconnects', async () => {
    let answered = 0;
    const { server, client, target } = await setup([
      asterisk((request) => (request.get('Action') === 'Ping' && ++answered > 2 ? null : undefined)),
      asterisk(),
    ], { pingIntervalMs: 30, pingTimeoutMs: 60 });
    await client.connect(target);
    const [err] = await once(client, 'down');
    assert.ok(err instanceof AmiDisconnected);
    assert.equal(err.message, 'AMI keepalive Ping unanswered within 60 ms');
    await once(client, 'up');
    const pings = conn(server, 0).requests.filter((r) => r.get('Action') === 'Ping');
    assert.equal(pings.length, 3, 'no second Ping while one is unanswered');
    assert.deepEqual(pings.map((r) => [...r.keys()]), [['Action', 'ActionID'], ['Action', 'ActionID'], ['Action', 'ActionID']]);
    await sleep(100);
    assert.ok(conn(server, 1).requests.filter((r) => r.get('Action') === 'Ping').length >= 2, 'the new connection keeps pinging');
  });

  test('keepalive: a Ping behind a slower action waits for it (Asterisk answers one request at a time), then gets a full window', async (t) => {
    // mocked timers make the order exact: the server answers only when the test says so
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let slowId = '';
    /** @type {string[]} */
    const pings = [];
    const server = await fakeAmi([asterisk((request) => {
      if (request.get('Action') === 'Slow') slowId = String(request.get('ActionID'));
      else if (request.get('Action') === 'Ping') pings.push(String(request.get('ActionID')));
      else return undefined;
      return null;
    })]);
    const client = new AmiClient({ ...FAST, pingIntervalMs: 20, pingTimeoutMs: 100 });
    /** @type {Error[]} */
    const downs = [];
    client.on('down', (err) => downs.push(err));
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    /** @param {() => boolean} condition */
    const until = async (condition) => {
      for (let i = 0; !condition(); i++) {
        assert.ok(i < 100_000, 'condition not reached');
        await turn();
      }
    };
    const turns = async () => {
      for (let i = 0; i < 50; i++) await turn();
    };
    try {
      await client.connect({ host: '127.0.0.1', port: server.port, username: 'aster', secret: 'test' });
      const slow = client.action('Slow', {}, { timeout: 60_000 });
      await until(() => slowId !== '');
      t.mock.timers.tick(20);
      await until(() => pings.length === 1);
      t.mock.timers.tick(100); // the Ping's window ends while Slow, sent before it, is unanswered
      await turns();
      assert.equal(client.state, 'up', 'the Ping waits behind Slow');
      conn(server, 0).send(packet(['Response: Success', `ActionID: ${slowId}`]));
      await slow;
      t.mock.timers.tick(100); // Slow is answered; the Ping gets one more full window
      await turns();
      assert.equal(client.state, 'up', 'a full window after the action ahead of it settled');
      conn(server, 0).send(packet(['Response: Success', `ActionID: ${pings[0]}`, 'Ping: Pong']));
      await client.action('Probe'); // answered after the Pong on the same stream, so the Pong has been handled
      t.mock.timers.tick(100);
      await until(() => pings.length === 2);
      assert.deepEqual(downs, []);
    } finally {
      t.mock.timers.reset();
      await client.close();
      await server.close();
    }
  });

  test('command(): a CR the CLI text carried is dropped from each Output line; a command that prints nothing gives one empty line', async () => {
    const { client, target } = await setup([asterisk((request) => {
      const id = request.get('ActionID');
      switch (request.get('Command')) {
        case 'crlf':
          return `Response: Success\r\nActionID: ${id}\r\nMessage: Command output follows\r\nOutput: first\r\r\nOutput: \r\r\nOutput: last\r\n\r\n`;
        case 'quiet':
          return packet(['Response: Success', `ActionID: ${id}`, 'Message: Command output follows', 'Output: ']);
        case 'failing':
          return `Response: Error\r\nActionID: ${id}\r\nMessage: Command output follows\r\nOutput: Usage: x\r\r\nOutput:  indented\r\n\r\n`;
        default:
          return undefined;
      }
    })]);
    await client.connect(target);
    assert.deepEqual(await client.command('crlf'), ['first', '', 'last']);
    assert.deepEqual(await client.command('quiet'), ['']);
    await assert.rejects(client.command('failing'), (err) => err instanceof AmiError && err.message === 'Usage: x\n indented'
      && err.output.length === 2 && err.response.get('Response') === 'Error');
  });

  test('at-command.txt (synthesized): AtResponse/AtDone events in stream order, a late AtDone for an unknown ActionID, Disconnect', async () => {
    const { server, client, target } = await setup([fixture('at-command.txt')]);
    /** @type {string[]} */
    const events = [];
    client.on('event', (p) => events.push([p.get('Event'), p.get('ActionID'), p.get('Result') ?? p.get('Status'), p.get('Error')].filter(Boolean).join(' ')));
    /** @type {string[]} */
    const done = [];
    client.on('event:QuectelAtDone', (p) => done.push(String(p.get('ActionID'))));
    await client.connect(target);
    /** @param {string} id @param {string} command */
    const at = (id, command) => client.action('QuectelAtCommand', { ActionID: id, Device: 'gsm1', Command: command, Timeout: 15 });
    const first = await at('at-1', 'AT+CCFC=0,2');
    assert.equal(first.get('Message'), '[gsm1] AT command queued');
    assert.deepEqual(events.splice(0), ['FullyBooted Fully Booted', 'QuectelAtResponse at-1', 'QuectelAtResponse at-1', 'QuectelAtDone at-1 OK',
      'QuectelAtDone at-0 TIMEOUT timeout'], 'events of the same read are emitted before the response settles the promise');
    await at('at-2', 'AT+CMGR=1');
    assert.deepEqual(events.splice(0), ['QuectelAtResponse at-2', 'QuectelNewCMGR', 'QuectelAtDone at-2 ERROR task removed']);
    await at('at-3', 'AT+COPS?');
    assert.deepEqual(events.splice(0), ['QuectelAtDone at-3 ERROR queue flushed', 'QuectelStatus Free', 'QuectelStatus Disconnect']);
    assert.deepEqual(done, ['at-1', 'at-0', 'at-2', 'at-3']);
    await client.close();
    assert.deepEqual(conn(server, 0).requests.map((r) => r.get('ActionID')), ['ami-1', 'at-1', 'at-2', 'at-3', 'ami-2']);
  });

  test('report.txt (synthesized): SendSMS answers, Report events with their Payload, NewSMS after its stray empty line', async () => {
    const { client, target } = await setup([fixture('report.txt')]);
    /** @type {Array<import('../src/ami/parser.js').Packet>} */
    const reports = [];
    client.on('event:DongleReport', (p) => reports.push(p));
    /** @type {string[]} */
    const other = [];
    client.on('event', (p) => other.push(String(p.get('Event'))));
    await client.connect(target);
    /** @param {string} device @param {string} payload @param {string} report */
    const send = (device, payload, report) => client.action('DongleSendSMS', { Device: device, Number: '+1234567890', Message: 'Привет', Report: report, Payload: payload });
    for (const [payload, report] of [['out-1', 'no'], ['out-2', 'yes'], ['out-3', 'yes']]) {
      assert.equal((await send('gsm_dongle', String(payload), String(report))).get('Message'), '[gsm_dongle] SMS queued for send');
    }
    assert.deepEqual(reports.map((p) => `${p.get('Payload')} ${p.get('Type')} ${p.get('Success')}`), ['out-1 0 1', 'out-2 1 1', 'out-3 2 0']);
    assert.deepEqual(other, ['FullyBooted', 'DongleReport', 'DongleNewCMGR', 'DongleReport', 'DongleReport', 'DongleNewSMS', 'DongleNewSMSBase64']);
    await assert.rejects(send('gsm_x', 'out-4', 'yes'), (err) => err instanceof AmiError && err.message === '[gsm_x] Device disconnected');
  });

  test('timeout: AmiTimeout; the late response is dropped and the connection stays up', async () => {
    const { log, lines } = memoryLog();
    const { client, target } = await setup([asterisk((request, c) => {
      if (request.get('Action') !== 'Slow') return undefined;
      setTimeout(() => c.send(packet(['Response: Success', `ActionID: ${request.get('ActionID')}`])), 80);
      return null;
    })], { log });
    await client.connect(target);
    await assert.rejects(client.action('Slow', {}, { timeout: 20 }), (err) => err instanceof AmiTimeout
      && err.message === 'AMI Slow (ami-2) got no response within 20 ms' && err.action === 'Slow' && err.actionId === 'ami-2');
    await sleep(120);
    assert.equal(client.state, 'up');
    assert.equal((await client.action('Ping')).get('Ping'), 'Pong');
    assert.deepEqual(lines.filter((l) => l.msg === 'AMI response without a pending action dropped').map((l) => l.action_id), ['ami-2']);
  });

  test('a lost connection rejects pending actions and lists with AmiDisconnected; events of other ActionIDs are still emitted', async () => {
    const { client, target } = await setup([asterisk((request, c) => {
      const id = request.get('ActionID');
      if (request.get('Action') === 'DeviceList') {
        return packet(['Response: Success', `ActionID: ${id}`, 'EventList: start']) + packet(['Event: Entry', `ActionID: ${id}`])
          + packet(['Event: Unrelated', 'ActionID: at-9']);
      }
      if (request.get('Action') === 'Hang') setTimeout(() => c.socket.destroy(), 30);
      return request.get('Action') === 'Hang' ? null : undefined;
    }), asterisk()]);
    await client.connect(target);
    /** @type {string[]} */
    const events = [];
    client.on('event', (p) => events.push(`${p.get('Event')} ${p.get('ActionID')}`));
    const listing = client.list('DeviceList', {}, 'DeviceListComplete');
    const hanging = client.action('Hang');
    const lost = (/** @type {unknown} */ err) => err instanceof AmiDisconnected && err.message === 'AMI connection lost: AMI connection closed by the server';
    await assert.rejects(listing, lost);
    await assert.rejects(hanging, lost);
    assert.deepEqual(events, ['Unrelated at-9']);
    await once(client, 'up');
  });

  test('list(): a ListItems mismatch, a refused list and a list without its Complete event reject', async () => {
    const { client, target } = await setup([asterisk((request) => {
      const id = request.get('ActionID');
      switch (request.get('Action')) {
        case 'BadCount':
          return packet(['Response: Success', `ActionID: ${id}`, 'EventList: start']) + packet(['Event: E', `ActionID: ${id}`])
            + packet(['Event: BadCountComplete', `ActionID: ${id}`, 'EventList: Complete', 'ListItems: 2']);
        case 'Refused':
          return packet(['Response: Error', `ActionID: ${id}`, 'Message: Permission denied']);
        case 'Endless':
          return packet(['Response: Success', `ActionID: ${id}`, 'EventList: start']) + packet(['Event: E', `ActionID: ${id}`]);
        case 'NoCount':
          return packet(['Response: Success', `ActionID: ${id}`]) + packet(['Event: E', `ActionID: ${id}`]) + packet(['Event: NoCountComplete', `ActionID: ${id}`]);
        default:
          return undefined;
      }
    })]);
    await client.connect(target);
    await assert.rejects(client.list('BadCount', {}, 'BadCountComplete'),
      (err) => err instanceof Error && err.message === 'AMI BadCount: BadCountComplete says ListItems: 2, 1 entries arrived');
    await assert.rejects(client.list('Refused', {}, 'RefusedComplete'), (err) => err instanceof AmiError && err.message === 'Permission denied');
    await assert.rejects(client.list('Endless', {}, 'EndlessComplete', { timeout: 30 }), (err) => err instanceof AmiTimeout);
    assert.equal((await client.list('NoCount', {}, 'NoCountComplete')).length, 1, 'without ListItems the count is not checked');
  });

  test('a listener that throws is logged and the packets after it are still delivered', async () => {
    const { log, lines } = memoryLog();
    const { client, target } = await setup([asterisk((request) => (request.get('Action') === 'Burst'
      ? packet(['Response: Success', `ActionID: ${request.get('ActionID')}`]) + packet(['Event: First']) + packet(['Event: Second'])
      : undefined))], { log });
    await client.connect(target);
    client.on('event:First', () => {
      throw new Error('listener bug');
    });
    const second = once(client, 'event:Second');
    await client.action('Burst');
    await second;
    const logged = lines.find((l) => l.msg === 'AMI listener threw');
    assert.equal(logged?.listener, 'event:First');
    assert.equal(logged?.err?.message, 'listener bug');
    assert.equal(client.state, 'up');
  });

  test('requests are validated before anything is written: CR/LF/NUL, names, Action, duplicates, ActionIDs, sizes, timeouts', async () => {
    const { server, client, target } = await setup([asterisk((request) => (request.get('Action') === 'Hold' ? null : undefined))]);
    await client.connect(target);
    const before = conn(server, 0).raw;
    /** @type {Array<[string, Record<string, any>, { timeout?: number } | undefined, RegExp]>} */
    const invalid = [
      ['Originate', { Channel: 'a\r\nAction: Command' }, undefined, /^AMI header Channel contains CR, LF or NUL$/],
      ['Originate', { Channel: 'a\nb' }, undefined, /^AMI header Channel contains CR, LF or NUL$/],
      ['Originate', { Channel: 'a b'.replace(' ', String.fromCharCode(0)) }, undefined, /^AMI header Channel contains CR, LF or NUL$/],
      ['Originate', { Variable: ['ok', 'x\ry'] }, undefined, /^AMI header Variable contains CR, LF or NUL$/],
      ['Bad Name', {}, undefined, /^AMI action name must match/],
      ['Originate', { 'Chan: nel': 'x' }, undefined, /^AMI header name must match/],
      ['Originate', { Action: 'Command' }, undefined, /^the action name is the first argument, not an Action header$/],
      ['Originate', { Channel: 'a', channel: 'b' }, undefined, /^AMI header channel is given twice$/],
      ['Originate', { ActionID: 'ami-7' }, undefined, /^ActionID must match .* and not start with ami-: "ami-7"$/],
      ['Originate', { ActionID: 'at 1' }, undefined, /^ActionID must match/],
      ['Originate', { ActionID: 'a'.repeat(64) }, undefined, /^ActionID must match/],
      ['Originate', { actionid: 12 }, undefined, /^ActionID must match/],
      ['Originate', { Channel: { nested: true } }, undefined, /^AMI header Channel must be a string or a number$/],
      ['Originate', { Timeout: Number.NaN }, undefined, /^AMI header Timeout must be a finite number$/],
      ['Originate', { Channel: ' leading space' }, undefined, /^AMI header Channel starts with a blank or control character$/],
      ['Originate', { Channel: `${String.fromCharCode(9)}tab` }, undefined, /^AMI header Channel starts with a blank or control character$/],
      ['Originate', { Channel: `${String.fromCharCode(1)}x` }, undefined, /^AMI header Channel starts with a blank or control character$/],
      ['A'.repeat(MAX_LINE_BYTES), {}, undefined, new RegExp(`^AMI header Action is longer than ${MAX_LINE_BYTES - 2} bytes with its name$`)],
      ['Command', { Command: 'x'.repeat(MAX_LINE_BYTES - 'Command: '.length - 1) }, undefined, new RegExp(`^AMI header Command is longer than ${MAX_LINE_BYTES - 2} bytes with its name$`)],
      ['Originate', Object.fromEntries(Array.from({ length: MAX_HEADERS - 1 }, (_, i) => [`H${i}`, 'x'])), undefined, new RegExp(`^AMI Originate: more than ${MAX_HEADERS} header lines$`)],
      ['Ping', {}, { timeout: 0 }, /^timeout must be an integer from 1 to 2147483647 ms$/],
      ['Ping', {}, { timeout: 1.5 }, /^timeout must be an integer/],
      ['Ping', {}, { timeout: 2 ** 31 }, /^timeout must be an integer/],
    ];
    for (const [name, headers, options, message] of invalid) {
      await assert.rejects(client.action(name, headers, options), (err) => (err instanceof TypeError || err instanceof RangeError) && message.test(err.message),
        `${name} ${JSON.stringify(headers).slice(0, 60)}`);
    }
    await assert.rejects(client.action('Originate', { Channel: 'sec\r\nret' }), (err) => err instanceof TypeError && !err.message.includes('sec'));
    assert.equal(conn(server, 0).raw, before, 'nothing was written');

    const longest = 'y'.repeat(MAX_LINE_BYTES - 'Command: '.length - 2);
    await client.action('Command', { Command: longest });
    await client.action('Originate', { Variable: ['a=1', 'b=2'], Timeout: 30000, Empty: '' });
    await client.action('Originate', Object.fromEntries(Array.from({ length: MAX_HEADERS - 2 }, (_, i) => [`H${i}`, 'x'])));
    const held = client.action('Hold', { ActionID: 'at-1' });
    await assert.rejects(client.action('Other', { ActionID: 'at-1' }), (err) => err instanceof Error && err.message === 'ActionID at-1 is already pending');
    while (conn(server, 0).requests.at(-1)?.get('Action') !== 'Hold') await sleep(2);
    const sent = conn(server, 0).raw.slice(before.length);
    assert.ok(sent.startsWith(`Action: Command\r\nActionID: ami-2\r\nCommand: ${longest}\r\n\r\n`), 'generated ActionIDs skip nothing for rejected calls');
    assert.ok(sent.includes('Action: Originate\r\nActionID: ami-3\r\nVariable: a=1\r\nVariable: b=2\r\nTimeout: 30000\r\nEmpty: \r\n\r\n'));
    assert.ok(sent.endsWith('Action: Hold\r\nActionID: at-1\r\n\r\n'));
    assert.equal(conn(server, 0).requests.filter((r) => r.get('Action') === 'Other').length, 0);
    const heldRejected = assert.rejects(held, (err) => err instanceof AmiDisconnected && err.message === 'AMI client closed');
    await client.close();
    await heldRejected;
    await assert.rejects(client.action('Ping'), (err) => err instanceof AmiDisconnected && err.message === 'AMI client closed');
  });

  test('connect(): once per client, target checked without echoing the secret; before connect() actions are refused', async () => {
    const client = new AmiClient(FAST);
    cleanups.push(() => client.close());
    await assert.rejects(client.action('Ping'), (err) => err instanceof AmiDisconnected && err.message === 'AMI is not up (idle)');
    await assert.rejects(client.connect({ host: '', port: 5038, username: 'aster', secret: 'x' }), /^TypeError: AMI host must be a non-empty string$/);
    await assert.rejects(client.connect({ host: 'h', port: 0, username: 'aster', secret: 'x' }), /^RangeError: AMI port must be an integer from 1 to 65535$/);
    await assert.rejects(client.connect({ host: 'h', port: 5038, username: 'aster', secret: 'top\nsecret' }),
      (err) => err instanceof TypeError && err.message === 'AMI header Secret contains CR, LF or NUL');
    await assert.rejects(client.connect({ host: 'h', port: 5038, username: 'aster', secret: ' spaced' }),
      (err) => err instanceof TypeError && err.message === 'AMI header Secret starts with a blank or control character');
    await assert.rejects(client.connect({ host: 'h', port: 5038, username: 'aster', secret: 's'.repeat(MAX_LINE_BYTES) }),
      (err) => err instanceof RangeError && err.message === `AMI header Secret is longer than ${MAX_LINE_BYTES - 2} bytes with its name`);
    const { server, target } = await setup([asterisk()]);
    await client.connect(target);
    await assert.rejects(client.connect(target), /^Error: AmiClient\.connect\(\) may be called once$/);
    assert.equal(server.connections.length, 1);
  });

  test('options and backoff: defaults, validation, 1 s → 30 s doubling', () => {
    assert.deepEqual({ ...DEFAULTS }, {
      actionTimeoutMs: 10_000, connectTimeoutMs: 10_000, bootTimeoutMs: 120_000, pingIntervalMs: 30_000, pingTimeoutMs: 10_000,
      backoffMinMs: 1_000, backoffMaxMs: 30_000, maxPacketBytes: 8 * 1024 * 1024,
    });
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.throws(() => new AmiClient(/** @type {any} */ ({ bogus: 1 })), /^TypeError: unknown AmiClient option: bogus$/);
    assert.throws(() => new AmiClient({ pingIntervalMs: 0 }), /^RangeError: pingIntervalMs must be an integer/);
    assert.throws(() => new AmiClient({ backoffMinMs: 100, backoffMaxMs: 50 }), /^RangeError: backoffMaxMs must not be smaller than backoffMinMs$/);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 1000].map((attempt) => backoffDelay(attempt, 1_000, 30_000)),
      [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  test('a packet larger than maxPacketBytes drops the connection', async () => {
    const { log, lines } = memoryLog();
    const { client, target } = await setup([asterisk((request) => (request.get('Action') === 'Big'
      ? `Response: Success\r\nActionID: ${request.get('ActionID')}\r\nOutput: ${'z'.repeat(5_000)}\r\n\r\n` : undefined)), asterisk()],
    { log, maxPacketBytes: 4_096 });
    await client.connect(target);
    await assert.rejects(client.action('Big'), (err) => err instanceof AmiDisconnected
      && err.message === 'AMI connection lost: AMI packet larger than 4096 bytes');
    await once(client, 'up');
    assert.equal(lines.find((l) => l.msg === 'AMI down')?.err?.name, 'AmiProtocolError');
  });
});
