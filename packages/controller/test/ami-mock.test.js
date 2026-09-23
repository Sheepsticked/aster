// @ts-check
// Tests for src/ami/mock.js (the ASTER_AMI_MOCK=1 stand-in for Asterisk), driven through the real AmiClient so a UI developed
// against it talks to the same client code as the appliance.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { AmiClient, AmiError } from '../src/ami/client.js';
import { BANNER, CREDENTIALS, USSD_MENU, startMockAmi } from '../src/ami/mock.js';
import { parseDiscovery } from '../src/devices/scan.js';
import { parseDeviceEntry, showDevices } from '../src/devices/state.js';
import { REQUIRED_MODULES, runningModules } from '../src/http/routes/health.js';
import { readConnections } from '../src/sip/connections.js';

const FAST = { connectTimeoutMs: 2_000, actionTimeoutMs: 2_000, backoffMinMs: 20, backoffMaxMs: 80 };

/** @type {Array<() => Promise<void>>} */
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A config/asterisk directory with the generated device files of `quectel` and `dongle`. */
function configDir(quectel = '[gsm1]\ninitstate=start\nimei=867435040012345\n', dongle = '[gsm2]\ninitstate=stop\nimei=356938031234560\n') {
  const dir = mkdtempSync(join(tmpdir(), 'aster-ami-mock-'));
  mkdirSync(join(dir, 'aster.d'), { recursive: true });
  writeFileSync(join(dir, 'aster.d', 'quectel-devices.conf'), quectel);
  writeFileSync(join(dir, 'aster.d', 'dongle-devices.conf'), dongle);
  return dir;
}

/** The mock, and a client that is logged in to it. */
async function connected(dir = configDir()) {
  const mock = await startMockAmi({ configDir: dir });
  cleanups.push(() => mock.close());
  const ami = new AmiClient(FAST);
  cleanups.push(() => ami.close());
  await ami.connect({ host: mock.host, port: mock.port, username: mock.username, secret: mock.secret });
  return { mock, ami, dir };
}

describe('ami mock', () => {
  test('the first phone of aster.d/phones.conf is registered, no call is up; without phones nothing is', async () => {
    const { ami, dir } = await connected();
    assert.deepEqual(await readConnections(ami, Date.now()), [], 'no phones.conf yet');
    writeFileSync(join(dir, 'aster.d', 'phones.conf'), '[101](aster-phone)\nauth=101\n[101](aster-auth)\n[102](aster-phone)\n');
    const phones = await readConnections(ami, Date.now());
    assert.deepEqual(phones.map((phone) => [phone.number, phone.contacts.map((contact) => [contact.address, contact.user_agent]), phone.calls]),
      [['101', [['192.0.2.10', 'Zoiper v2.10.20.5']], []]]);
  });

  test('logs in, reports itself booted and answers a Ping', async () => {
    const { ami } = await connected();
    assert.equal(ami.state, 'up'); // 'up' needs the FullyBooted event, not only the login
    assert.equal(ami.banner, BANNER);
    const pong = await ami.action('Ping');
    assert.equal(pong.get('Ping'), 'Pong');
  });

  test('answers nothing but a login before there is a session', async () => {
    const mock = await startMockAmi({ configDir: configDir() });
    cleanups.push(() => mock.close());
    const ami = new AmiClient(FAST);
    cleanups.push(() => ami.close());
    // connect() logs in; this is the raw socket, which is what an unauthenticated client would be.
    const socket = createConnection({ host: mock.host, port: mock.port });
    cleanups.push(() => new Promise((done) => socket.end(() => done())));
    const answer = new Promise((resolve) => {
      let text = '';
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        if (text.includes('Response:')) resolve(text);
      });
    });
    socket.write('Action: QuectelShowDevices\r\nActionID: ami-1\r\n\r\n');
    assert.match(String(await answer), /Response: Error[\s\S]*Permission denied/);
  });

  test('refuses a wrong secret, which the client keeps as its last error and retries', async () => {
    const mock = await startMockAmi({ configDir: configDir() });
    cleanups.push(() => mock.close());
    const ami = new AmiClient({ ...FAST, connectTimeoutMs: 1_000, backoffMinMs: 20, backoffMaxMs: 40 });
    cleanups.push(() => ami.close());
    // A refused login is not an end: the client retries it with backoff (ami/client.js), so connect() is left running here.
    void ami.connect({ host: mock.host, port: mock.port, username: mock.username, secret: 'wrong' }).catch(() => {});
    for (let waited = 0; !(ami.lastError instanceof AmiError) && waited < 2_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(String(ami.lastError?.message), /Authentication failed/);
    assert.equal(ami.connected, false);
  });

  test('lists the devices of the generated files, with the state their initstate asks for', async () => {
    const { ami } = await connected();
    const entries = await showDevices(ami, 'quectel');
    assert.equal(entries.length, 1);
    const [gsm1] = entries;
    assert.ok(gsm1);
    assert.equal(gsm1.device, 'gsm1');
    assert.equal(gsm1.state, 'Free');
    assert.equal(gsm1.current, 'start');
    assert.equal(gsm1.imei, '867435040012345');
    assert.match(String(gsm1.dataTty), /^\/dev\/ttyUSB/);
    assert.equal(gsm1.rssi, 21);
    // `initstate=stop` is a device the driver knows and has not started: Stopped, with nothing observed.
    const [gsm2] = await showDevices(ami, 'dongle');
    assert.ok(gsm2);
    assert.equal(gsm2.device, 'gsm2');
    assert.equal(gsm2.state, 'Stopped');
    assert.equal(gsm2.desired, 'stop');
    assert.equal(gsm2.imei, null);
  });

  test('a device started with radio=off (a disabled modem) is Radio off: identified, never initialized, refusing AT and SMS', async () => {
    const { ami } = await connected(configDir('[gsm1]\ninitstate=start\nradio=off\nimei=867435040012345\n'));
    const [gsm1] = await showDevices(ami, 'quectel');
    assert.ok(gsm1);
    assert.deepEqual([gsm1.state, gsm1.radio, gsm1.current, gsm1.imei, gsm1.imsi, gsm1.provider, gsm1.number, gsm1.rssi],
      ['Radio off', 'off', 'start', '867435040012345', null, null, null, 0]);
    // without a radio line the driver reports its default
    const [gsm2] = await showDevices(ami, 'dongle');
    assert.equal(gsm2?.radio, 'keep');
    await assert.rejects(ami.action('QuectelAtCommand', { Device: 'gsm1', Command: 'AT', ActionID: 'at-1' }), /Device not initialized/);
    await assert.rejects(ami.action('QuectelSendSMS', { Device: 'gsm1', Number: '+1234567890', Message: 'x' }), /Device disconnected/);
  });

  test('re-reads the generated file on Reload, which is how an applied registry reaches it', async () => {
    const { ami, mock, dir } = await connected();
    assert.deepEqual(mock.devices().sort(), ['gsm1', 'gsm2']);
    writeFileSync(join(dir, 'aster.d', 'quectel-devices.conf'), '[gsm1]\ninitstate=start\n[gsm3]\ninitstate=start\n');
    // Until the driver is told to reload, it still lists what it read at the start.
    assert.deepEqual((await showDevices(ami, 'quectel')).map((entry) => entry.device), ['gsm1']);
    await ami.action('QuectelReload', { When: 'gracefully' });
    assert.deepEqual((await showDevices(ami, 'quectel')).map((entry) => entry.device).sort(), ['gsm1', 'gsm3']);
  });

  test('lists one device when asked for one, which is how reconcile finds out a modem is gone', async () => {
    const { ami } = await connected(configDir('[gsm1]\ninitstate=start\n[gsm3]\ninitstate=start\n'));
    assert.deepEqual((await showDevices(ami, 'quectel', { device: 'gsm3' })).map((entry) => entry.device), ['gsm3']);
    await ami.action('QuectelRemove', { Device: 'gsm3', When: 'gracefully' });
    assert.deepEqual(await showDevices(ami, 'quectel', { device: 'gsm3' }), []);
    // The other device is still there: a Remove takes one device out, not the driver's whole list.
    assert.deepEqual((await showDevices(ami, 'quectel')).map((entry) => entry.device), ['gsm1']);
  });

  test('starts and stops a device, and names an unknown one the way both drivers do', async () => {
    const { ami } = await connected();
    const stopped = await ami.action('QuectelStop', { Device: 'gsm1', When: 'now' });
    assert.match(String(stopped.get('Message')), /^\[gsm1\] Stop scheduled$/);
    assert.equal((await showDevices(ami, 'quectel')).at(0)?.state, 'Stopped');
    await ami.action('QuectelStart', { Device: 'gsm1' });
    assert.equal((await showDevices(ami, 'quectel')).at(0)?.state, 'Free');
    // A refusal is an AMI error, not a Success carrying a sentence: sms/outbox.js and at/client.js read the response type,
    // and a stand-in that answered Success would let a failed send look submitted.
    await assert.rejects(ami.action('QuectelStart', { Device: 'nosuch' }),
      (err) => err instanceof AmiError && err.message === '[nosuch] Device not found');
  });

  test('refuses an action on a stopped device the way the drivers do, with an error and their own sentence', async () => {
    const { ami } = await connected();
    for (const [action, message] of /** @type {const} */ ([
      ['DongleSendSMS', '[gsm2] Device disconnected'],
      ['DongleSendUSSD', '[gsm2] Device disconnected'],
      ['DongleReset', '[gsm2] Device disconnected'],
      ['DongleAtCommand', '[gsm2] Device not connected'],
    ])) {
      await assert.rejects(ami.action(action, { Device: 'gsm2', Number: '+375291112233', Message: 'x', USSD: '*100#', Command: 'AT', ActionID: 'at-9' }),
        (err) => err instanceof AmiError && err.message === message, action);
    }
  });

  test('answers an AT command with its lines and exactly one AtDone', async () => {
    const { ami } = await connected();
    /** @type {any[]} */
    const responses = [];
    /** @type {any[]} */
    const done = [];
    ami.on('event:QuectelAtResponse', (packet) => responses.push(packet));
    ami.on('event:QuectelAtDone', (packet) => done.push(packet));
    const ack = await ami.action('QuectelAtCommand', { Device: 'gsm1', Command: 'AT+CSQ', ActionID: 'at-7', Timeout: 10 });
    assert.equal(ack.get('Message'), '[gsm1] AT command queued');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(responses.map((packet) => packet.get('Line')), ['+CSQ: 21,99']);
    assert.equal(done.length, 1);
    assert.equal(done.at(0)?.get('Result'), 'OK');
    assert.equal(done.at(0)?.get('ActionID'), 'at-7');
  });

  test('remembers a forwarding mutation per condition so the queries that follow it answer what was set', async () => {
    const { ami } = await connected();
    /** @type {string[]} */
    const lines = [];
    ami.on('event:QuectelAtResponse', (packet) => lines.push(String(packet.get('Line'))));
    /** @param {string} command */
    const at = async (command) => {
      await ami.action('QuectelAtCommand', { Device: 'gsm1', Command: command, ActionID: `at-${lines.length}-${command.length}` });
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    await at('AT+CCFC=0,3,"+375291112233",145');
    await at('AT+CCFC=0,2');
    await at('AT+CCFC=2,2');
    assert.deepEqual(lines.splice(0), ['+CCFC: 1,1,"+375291112233",145', '+CCFC: 0,1']);
    await at('AT+CCFC=5,3,"+375294445566",145,7,,,20');
    for (const reason of [1, 2, 3]) await at(`AT+CCFC=${reason},2`);
    assert.deepEqual(lines.splice(0), ['+CCFC: 1,1,"+375294445566",145', '+CCFC: 1,1,"+375294445566",145,,,20', '+CCFC: 1,1,"+375294445566",145']);
    await at('AT+CCFC=1,0');
    await at('AT+CCFC=1,2');
    await at('AT+CCFC=0,2');
    assert.deepEqual(lines.splice(0), ['+CCFC: 0,1', '+CCFC: 1,1,"+375291112233",145']);
  });

  test('answers a USSD request with a NewUSSD event', async () => {
    const { ami } = await connected();
    /** @type {any[]} */
    const ussd = [];
    ami.on('event:QuectelNewUSSD', (packet) => ussd.push(packet));
    const ack = await ami.action('QuectelSendUSSD', { Device: 'gsm1', USSD: '*100#' });
    assert.equal(ack.get('Message'), '[gsm1] USSD queued for send');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(ussd.length, 1);
    assert.match(String(ussd.at(0)?.get('MessageLine0')), /\*100#/);
  });

  test('opens a USSD menu: the raw NewCUSD comes first, and an answer or AT+CUSD=2 closes the menu', async () => {
    const { ami } = await connected();
    /** @type {string[]} */
    const seen = [];
    ami.on('event:QuectelNewCUSD', (packet) => seen.push(`cusd ${String(packet.get('Message')).slice(0, 8)}`));
    ami.on('event:QuectelNewUSSD', (packet) => seen.push(`ussd ${packet.get('LineCount')} ${packet.get('MessageLine0')}`));
    /** @param {string} code */
    const ussd = async (code) => {
      await ami.action('QuectelSendUSSD', { Device: 'gsm1', USSD: code });
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    await ussd(USSD_MENU);
    await ussd('1');
    await ussd(USSD_MENU);
    const ack = await ami.action('QuectelAtCommand', { Device: 'gsm1', Command: 'AT+CUSD=2', ActionID: 'at-1', Timeout: '15' });
    assert.equal(ack.get('Message'), '[gsm1] AT command queued');
    await ussd('1');
    assert.deepEqual(seen, ['cusd +CUSD: 1', 'ussd 3 Menu', 'cusd +CUSD: 0', 'ussd 1 Balance 12.34 EUR',
      'cusd +CUSD: 1', 'ussd 3 Menu', 'cusd +CUSD: 0', 'ussd 1 Balance 12.34 EUR. Request 1']);
  });

  test('prints a discovery list the scanner can parse, and nothing once that device is a modem', async () => {
    const { ami } = await connected();
    const found = parseDiscovery(await ami.command('quectel discovery'), 'quectel');
    assert.equal(found.length, 1);
    assert.equal(found.at(0)?.imei, '867435040099999');
    assert.equal(found.at(0)?.data_tty, '/dev/ttyUSB8');

    // The same device, once a modem claims its IMEI, is not free any more — which is what makes an assign visible.
    const { ami: after } = await connected(configDir('[gsm1]\ninitstate=start\nimei=867435040099999\n'));
    assert.deepEqual(parseDiscovery(await after.command('quectel discovery'), 'quectel'), []);
  });

  test('answers the reload and verification commands of an apply, and refuses what it does not know', async () => {
    const { ami } = await connected();
    assert.deepEqual(await ami.command('dialplan reload'), ['']);
    assert.match(String((await ami.command('dialplan show aster-ring-gsm1')).at(0)), /^\[ Context aster-ring-gsm1/);
    assert.match(String((await ami.command('pjsip show endpoint 101')).at(0)), /^Endpoint:  101/);
    // /api/health probes these two; without them a development run would show itself degraded for ever.
    const running = runningModules(await ami.command('module show'));
    assert.deepEqual(REQUIRED_MODULES.filter((name) => !running.has(name)), []);
    assert.match(String((await ami.command('core show version')).at(0)), /^Asterisk \d+\./);
    await assert.rejects(ami.command('nonsense'), (err) => err instanceof AmiError && /No such command/.test(err.message));
    await assert.rejects(ami.action('QuectelNonsense', { Device: 'gsm1' }),
      (err) => err instanceof AmiError && /Invalid\/unknown command/.test(err.message));
  });

  test('listens on the loopback address only, and keeps its own credentials', async () => {
    assert.throws(() => startMockAmi({ configDir: configDir(), host: '0.0.0.0' }), /loopback/);
    assert.equal(CREDENTIALS.username, 'aster');
  });

  test('is a device entry the state module parses the same way as the captured one', async () => {
    const { ami } = await connected();
    const [packet] = await ami.list('QuectelShowDevices', {}, 'QuectelShowDevicesComplete');
    assert.ok(packet);
    const entry = parseDeviceEntry(packet, 'quectel');
    assert.equal(entry.device, 'gsm1');
    assert.equal(entry.gsmReg, 'Registered, home network');
    assert.equal(entry.provider, 'Operator');
    assert.equal(entry.number, '+1234567890');
    assert.equal(entry.calls, 0);
  });
});
