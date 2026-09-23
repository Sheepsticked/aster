// @ts-check
// Tests for src/ami/parser.js: the transcript fixtures parse the same in any read sizes, the header rules, the legacy
// `Response: Follows` answer, the banner check and the packet size limit.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { AmiParser, AmiProtocolError, headerValue, headerValues, MAX_PACKET_BYTES } from '../src/ami/parser.js';

/** @typedef {import('../src/ami/parser.js').Packet} Packet */

const FIXTURES = new URL('./fixtures/ami/', import.meta.url);
const BANNER = 'Asterisk Call Manager/9.0.0';
/** Recorded from aster/aster-asterisk:dev with tools/ami-capture.js; SYNTHESIZED ones are written from the driver sources. */
const CAPTURED = ['at-command-refused.txt', 'command.txt', 'core-show-channels.txt', 'login-failed.txt', 'login.txt', 'pjsip-contacts.txt',
  'restart.txt', 'show-devices.txt'];
const SYNTHESIZED = ['at-command.txt', 'report.txt'];
const BACKSLASH = String.fromCharCode(92);

/** @param {string} name */
const fixture = (name) => readFileSync(new URL(name, FIXTURES));
/** @param {string} text */
const bytes = (text) => Buffer.from(text, 'utf8');

/**
 * Feeds `data` to a fresh parser in reads of the given sizes (cycled; 0 = everything at once).
 * @param {Buffer} data
 * @param {number[]} sizes
 * @param {{ maxPacketBytes?: number }} [options]
 */
function parse(data, sizes = [0], options) {
  const parser = new AmiParser(options);
  /** @type {Packet[]} */
  const packets = [];
  for (let offset = 0, i = 0; offset < data.length; i++) {
    const size = sizes[i % sizes.length] || data.length;
    packets.push(...parser.push(data.subarray(offset, offset + size)));
    offset += size;
  }
  return { banner: parser.banner, packets };
}

/** @param {Array<[string, string | string[]]>} entries @returns {Packet} */
const packet = (entries) => new Map(entries);

/**
 * The packet whose header `name` has `value`.
 * @param {Packet[]} packets
 * @param {string} name
 * @param {string} value
 */
function find(packets, name, value) {
  const found = packets.find((p) => p.get(name) === value);
  assert.ok(found, `no packet with ${name}: ${value}`);
  return found;
}

describe('ami parser', () => {
  test('the fixtures are untouched captures: CRLF only, the banner first, every packet closed', () => {
    const files = readdirSync(FIXTURES).filter((file) => file.endsWith('.txt'));
    assert.deepEqual(files.sort(), [...CAPTURED, ...SYNTHESIZED].sort(), 'every transcript is listed as captured or synthesized');
    for (const file of files) {
      const text = fixture(file).toString('latin1');
      assert.ok(text.startsWith(`${BANNER}\r\n`), file);
      assert.ok(text.endsWith('\r\n\r\n'), file);
      assert.doesNotMatch(text, /[^\r]\n/, `${file}: a bare LF (line endings converted?)`);
      assert.doesNotMatch(text, /\r[^\n]/, `${file}: a bare CR`);
    }
  });

  test('every fixture parses to the same banner and packets whole, byte by byte and in uneven reads', () => {
    for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith('.txt'))) {
      const data = fixture(file);
      const whole = parse(data);
      assert.equal(whole.banner, BANNER, file);
      assert.ok(whole.packets.length > 0, file);
      for (const sizes of [[1], [2, 3, 5, 7, 11, 13], [4096, 1]]) assert.deepEqual(parse(data, sizes), whole, `${file} in reads of ${sizes}`);
    }
  });

  test('login.txt: the login response, FullyBooted and the Logoff answer', () => {
    assert.deepEqual(parse(fixture('login.txt')).packets, [
      packet([['Response', 'Success'], ['ActionID', 'ami-1'], ['Message', 'Authentication accepted']]),
      packet([['Event', 'FullyBooted'], ['Privilege', 'system,all'], ['Uptime', '236'], ['LastReload', '236'], ['Status', 'Fully Booted']]),
      packet([['Response', 'Goodbye'], ['ActionID', 'ami-2'], ['Message', 'Thanks for all the fish.']]),
    ]);
    assert.deepEqual(parse(fixture('login-failed.txt')).packets, [
      packet([['Response', 'Error'], ['ActionID', 'ami-1'], ['Message', 'Authentication failed']]),
    ]);
  });

  test('command.txt: Output lines split at the first colon, keep their indentation and UTF-8, an empty line stays', () => {
    const { packets } = parse(fixture('command.txt'), [1]);
    assert.deepEqual(find(packets, 'ActionID', 'ami-2'), packet([['Response', 'Success'], ['ActionID', 'ami-2'],
      ['Message', 'Command output follows'], ['Output', ['System uptime: 4 minutes', 'Last reload: 4 minutes']]]));
    assert.deepEqual(find(packets, 'ActionID', 'ami-3'), packet([['Response', 'Error'], ['ActionID', 'ami-3'], ['Message', 'Command output follows'],
      ['Output', "No such command 'pjsip reload' (type 'core show help pjsip reload' for other possible commands)"]]));
    assert.equal(find(packets, 'ActionID', 'ami-4').get('Output'), "Module 'res_pjsip.so' reloaded successfully.");
    assert.deepEqual(find(packets, 'Event', 'Reload'), packet([['Event', 'Reload'], ['Privilege', 'system,all'], ['Module', 'res_pjsip.so'], ['Status', '0']]));
    const dialplan = headerValues(find(packets, 'ActionID', 'ami-5'), 'Output');
    assert.equal(dialplan.length, 22);
    assert.equal(dialplan[0], "[ Context 'smoke' created by 'pbx_config' ]");
    assert.match(dialplan[1] ?? '', /^ {2}'call' => {9}1\. Set\(CALLERID\(num\)=`id`;\$\(id\)\) +\[extensions\.conf:29\]$/);
    assert.match(dialplan[14] ?? '', /BASE64_ENCODE\(Привет из smoke-теста\)/);
    assert.equal(dialplan[20], '');
    assert.equal(dialplan[21], '-= 5 extensions (19 priorities) in 1 context. =-');
    assert.equal(find(packets, 'ActionID', 'ami-6').get('Message'),
      'Invalid/unknown command: NoSuchAction. Use Action: ListCommands to show available commands.');
    assert.deepEqual([...find(packets, 'ActionID', 'ami-7').keys()], ['Response', 'ActionID', 'Ping', 'Timestamp']);
  });

  test('show-devices.txt: list responses, one DeviceEntry per device with empty values kept, the Complete events', () => {
    const { packets } = parse(fixture('show-devices.txt'));
    const quectel = packets.filter((p) => p.get('Event') === 'QuectelDeviceEntry');
    const dongle = packets.filter((p) => p.get('Event') === 'DongleDeviceEntry');
    assert.deepEqual(quectel.map((p) => p.get('Device')), ['gsm_test', 'gsm_uac', 'gsm_unmapped']);
    assert.deepEqual(dongle.map((p) => p.get('Device')), ['gsm_dongle', 'gsm_ports']);
    for (const entry of quectel) assert.equal(entry.get('ActionID'), 'ami-2');
    const first = quectel[0] ?? new Map();
    assert.equal(first.size, 58);
    assert.equal(dongle[0]?.size, 57, 'chan_dongle has no UseUCS2Encoding');
    assert.equal(first.get('AudioSetting'), '');
    assert.equal(first.get('RSSI'), '0, <= -113 dBm');
    assert.equal(first.get('DefaultCallingPres'), '<Not set>');
    /** @type {Array<[string, string, string]>} */
    const lists = [['ami-2', 'QuectelShowDevicesComplete', '3'], ['ami-3', 'DongleShowDevicesComplete', '2']];
    for (const [actionId, list, items] of lists) {
      assert.deepEqual(find(packets, 'Event', list), packet([['Event', list], ['ActionID', actionId], ['EventList', 'Complete'], ['ListItems', items]]));
      assert.equal(packets.filter((p) => p.get('Response') === 'Success' && p.get('ActionID') === actionId && p.get('EventList') === 'start').length, 1);
    }
  });

  test('at-command.txt (synthesized): AtResponse lines with escaped CRLF, AtDone with and without Error, Status events', () => {
    const { packets } = parse(fixture('at-command.txt'), [7]);
    const events = packets.filter((p) => p.has('Event')).map((p) => [p.get('Event'), p.get('ActionID') ?? null, p.get('Result') ?? p.get('Status') ?? null]);
    assert.deepEqual(events, [
      ['FullyBooted', null, 'Fully Booted'],
      ['QuectelAtResponse', 'at-1', null], ['QuectelAtResponse', 'at-1', null], ['QuectelAtDone', 'at-1', 'OK'], ['QuectelAtDone', 'at-0', 'TIMEOUT'],
      ['QuectelAtResponse', 'at-2', null], ['QuectelNewCMGR', null, null], ['QuectelAtDone', 'at-2', 'ERROR'],
      ['QuectelAtDone', 'at-3', 'ERROR'], ['QuectelStatus', null, 'Free'], ['QuectelStatus', null, 'Disconnect'],
    ]);
    const atDone = packets.filter((p) => p.get('Event') === 'QuectelAtDone');
    assert.deepEqual(atDone.map((p) => [...p.keys()]), [
      ['Event', 'Privilege', 'ActionID', 'Device', 'Result'],
      ['Event', 'Privilege', 'ActionID', 'Device', 'Result', 'Error'],
      ['Event', 'Privilege', 'ActionID', 'Device', 'Result', 'Error'],
      ['Event', 'Privilege', 'ActionID', 'Device', 'Result', 'Error'],
    ]);
    assert.deepEqual(atDone.map((p) => p.get('Error') ?? null), [null, 'timeout', 'task removed', 'queue flushed']);
    const cmgr = find(packets, 'ActionID', 'at-2');
    assert.equal(cmgr.get('Response'), 'Success');
    const line = packets.find((p) => p.get('Event') === 'QuectelAtResponse' && p.get('ActionID') === 'at-2')?.get('Line');
    assert.equal(line, `+CMGR: 1,,24${BACKSLASH}r${BACKSLASH}n07919730071111F1040B919730071111F10000629090315000210548656C6C6F`);
    assert.equal(packets.find((p) => p.get('ActionID') === 'at-1' && p.get('Event') === 'QuectelAtResponse')?.get('Line'), '+CCFC: 1,1,"+1234567890",145');
  });

  test('report.txt (synthesized): Report Types 0/1/2, a MessageLine starting with a space, the stray empty line after NewSMS', () => {
    const { packets } = parse(fixture('report.txt'), [1]);
    const reports = packets.filter((p) => p.get('Event') === 'DongleReport');
    assert.deepEqual(reports.map((p) => [p.get('Payload'), p.get('Type'), p.get('Success'), p.get('SCTS'), p.get('DT'), p.get('Report')]), [
      ['out-1', '0', '1', '', '', ''],
      ['out-2', '1', '1', '2026-09-10 09:30:05 +03:00', '2026-09-10 09:30:07 +03:00', '000,'],
      ['out-3', '2', '0', '', '', ''],
    ]);
    const sms = find(packets, 'Event', 'DongleNewSMS');
    assert.deepEqual([...sms.entries()], [['Event', 'DongleNewSMS'], ['Privilege', 'call,all'], ['Device', 'gsm_dongle'], ['From', '+375290000001'],
      ['LineCount', '2'], ['MessageLine0', 'Привет'], ['MessageLine1', ' из Aster']]);
    const base64 = find(packets, 'Event', 'DongleNewSMSBase64');
    assert.equal(Buffer.from(String(base64.get('Message')), 'base64').toString('utf8'), 'Привет\n из Aster');
    assert.ok(fixture('report.txt').includes('MessageLine1:  из Aster\r\n\r\n\r\nEvent: DongleNewSMSBase64'), 'the fixture carries the stray empty line');
    assert.equal(packets.filter((p) => p.size === 0).length, 0);
    assert.equal(find(packets, 'ActionID', 'ami-5').get('Message'), '[gsm_x] Device disconnected');
  });

  test('header rules: one space dropped, colon-less and empty-name lines, bare LF in a value, repeated names, stray empty lines', () => {
    const text = `${BANNER}\r\nA:b\r\nB:  two\r\nC:\r\nD: x: y\r\n: nameless\r\nno colon here\r\nLine: one\ntwo\r\nR: 1\r\nR: 2\r\nR: 3\r\n\r\n`
      + '\r\n\r\nEvent: Next\r\n\r\n';
    const { packets } = parse(bytes(text), [3]);
    assert.deepEqual(packets, [
      packet([['A', 'b'], ['B', ' two'], ['C', ''], ['D', 'x: y'], ['', ['nameless', 'no colon here']], ['Line', 'one\ntwo'], ['R', ['1', '2', '3']]]),
      packet([['Event', 'Next']]),
    ]);
    const [first] = packets;
    assert.ok(first);
    assert.equal(headerValue(first, 'R'), '1');
    assert.deepEqual(headerValues(first, 'R'), ['1', '2', '3']);
    assert.equal(headerValue(first, 'missing'), undefined);
    assert.deepEqual(headerValues(first, 'A'), ['b']);
    assert.deepEqual(headerValues(first, 'missing'), []);
    const values = headerValues(first, 'R');
    values.push('4');
    assert.deepEqual(first.get('R'), ['1', '2', '3'], 'headerValues returns a copy');
  });

  test('a terminator or a UTF-8 character split across reads, and a banner arriving alone, are handled', () => {
    const parser = new AmiParser();
    assert.deepEqual(parser.push(bytes('Asterisk Call Manager/9.0.0\r')), []);
    assert.equal(parser.banner, null);
    assert.deepEqual(parser.push(bytes('\n')), []);
    assert.equal(parser.banner, BANNER);
    const cyrillic = bytes('Event: Т\r\n\r');
    assert.deepEqual(parser.push(cyrillic.subarray(0, 8)), []);
    assert.deepEqual(parser.push(cyrillic.subarray(8)), []);
    assert.deepEqual(parser.push(bytes('\nEvent: B\r\n\r\n')), [packet([['Event', 'Т']]), packet([['Event', 'B']])]);
  });

  test('legacy Command answer (Asterisk 13.38.3): output lines up to --END COMMAND--, blank lines and CRLF inside kept', () => {
    const legacy = `${BANNER}\r\n`
      + 'Response: Follows\r\nPrivilege: Command\r\nActionID: ami-2\r\nSystem uptime: 4 minutes\nLast reload: 4 minutes\n\nbefore\r\n\r\nafter\n--END COMMAND--\r\n\r\n'
      + 'Response: Follows\r\nPrivilege: Command\r\n--END COMMAND--\r\n\r\n'
      + 'Response: Follows\r\nPrivilege: Command\r\nno newline--END COMMAND--\r\n\r\n'
      + 'Response: Success\r\nActionID: ami-3\r\n\r\n';
    const expected = [
      packet([['Response', 'Follows'], ['Privilege', 'Command'], ['ActionID', 'ami-2'],
        ['Output', ['System uptime: 4 minutes', 'Last reload: 4 minutes', '', 'before\r', '\r', 'after']]]),
      packet([['Response', 'Follows'], ['Privilege', 'Command']]),
      packet([['Response', 'Follows'], ['Privilege', 'Command'], ['Output', 'no newline']]),
      packet([['Response', 'Success'], ['ActionID', 'ami-3']]),
    ];
    for (const sizes of [[0], [1], [17, 2]]) assert.deepEqual(parse(bytes(legacy), sizes).packets, expected, `reads of ${sizes}`);
  });

  test('a first line that is not an AMI banner is a protocol error', () => {
    const parser = new AmiParser();
    assert.throws(() => parser.push(bytes('HTTP/1.1 400 Bad Request\r\n')), (err) => err instanceof AmiProtocolError
      && err.name === 'AmiProtocolError' && err.message === 'not an AMI banner: "HTTP/1.1 400 Bad Request"');
  });

  test('a banner, packet or legacy answer longer than maxPacketBytes is a protocol error, whole or in pieces', () => {
    assert.equal(MAX_PACKET_BYTES, 8 * 1024 * 1024);
    const limit = { maxPacketBytes: 40 };
    const tooLarge = (/** @type {unknown} */ err) => err instanceof AmiProtocolError && err.message === 'AMI packet larger than 40 bytes';
    const exact = `Event: ${'x'.repeat(33)}`;
    assert.equal(exact.length, 40);
    assert.equal(parse(bytes(`${BANNER}\r\n${exact}\r\n\r\n`), [0], limit).packets.length, 1, 'a packet of exactly the limit passes');
    assert.throws(() => parse(bytes(`${BANNER}\r\n${exact}x\r\n\r\n`), [0], limit), tooLarge);
    assert.throws(() => parse(bytes(`${BANNER}\r\n${exact}x`), [5], limit), tooLarge);
    assert.throws(() => parse(bytes(`Asterisk Call Manager/${'9'.repeat(30)}`), [1], limit), tooLarge);
    assert.throws(() => parse(bytes(`${BANNER}\r\nResponse: Follows\r\n${'y'.repeat(30)}`), [0], limit), tooLarge);
  });
});
