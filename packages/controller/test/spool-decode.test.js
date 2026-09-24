// @ts-check
// Tests for src/spool/decode.js: the aster-emit files of fixtures/spool (smoke/, valid/, one malformed/ file per rule),
// b64x/b64, the field list of each kind and the size limit.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { b64, b64x, decodeFile, DecodeError, KINDS, MAX_FILE_BYTES, parseLine, REPORT_TYPES } from '../src/spool/decode.js';

const FIXTURES = new URL('./fixtures/spool/', import.meta.url);
/** @param {string} path */
const fixture = (path) => readFileSync(new URL(path, FIXTURES));
/** @param {string} dir */
const listing = (dir) => readdirSync(new URL(dir, FIXTURES)).sort();
/** @param {string | number[]} value  base64 of the UTF-8 text or of the bytes */
const base64 = (value) => (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).toString('base64');

/** What the smoke test's dialplan cases passed (docker/asterisk/test-config/extensions.conf, context [smoke]). */
const SMOKE = {
  '1789052155654316892-728-1789052155.1.evt': {
    kind: 'call-end', modem: 'gsm_test', uniqueid: '1789052155.1', emitted: 1789052155, emittedMs: 1789052155654,
    data: { caller: '`id`;$(id)', did: '', dialstatus: 'CHANUNAVAIL', answeredtime: '', disposition: 'NO ANSWER', hangupcause: '3', dialedtime: '',
      direction: 'in' },
  },
  '1789052156669849990-875-1789052156.3.evt': {
    kind: 'call-end', modem: 'gsm_test', uniqueid: '1789052156.3', emitted: 1789052156, emittedMs: 1789052156669,
    data: { caller: '+375290000001', did: '+1234567890', dialstatus: 'CHANUNAVAIL', answeredtime: '', disposition: 'NO ANSWER',
      hangupcause: '3', dialedtime: '', direction: 'in' },
  },
  '1790239200724224715-977-1790239200.5.evt': {
    kind: 'call-end', modem: 'gsm_test', uniqueid: '1790239200.5', emitted: 1790239200, emittedMs: 1790239200724,
    data: { caller: '599', did: '+1234567890', dialstatus: 'CHANUNAVAIL', answeredtime: '', disposition: 'NO ANSWER', hangupcause: '44',
      dialedtime: '', direction: 'out' },
  },
  '1789052157042129481-936-1789052157.5.evt': {
    kind: 'sms', modem: 'gsm_test', uniqueid: '1789052157.5', emitted: 1789052157, emittedMs: 1789052157042,
    data: { sender: '";touch /tmp/aster-smoke-pwned;"', text: 'Привет из smoke-теста', scts: '2026-09-10 09:30:00 +0300' },
  },
  '1789052157382107899-997-1789052157.7.evt': {
    kind: 'sms-report', modem: 'gsm_test', uniqueid: '1789052157.7', emitted: 1789052157, emittedMs: 1789052157382,
    data: { payload: '42:1', type: 'e', success: '1', scts: '2026-09-10 09:30:05 +0300', dt: '2026-09-10 09:30:07 +0300', report: '+CDS: 6' },
  },
};

const TAB = String.fromCharCode(9);
/** What aster-emit was given for each file of valid/. */
const VALID = {
  'call-end-absent-fields.evt': { kind: 'call-end', modem: 'gsm1', uniqueid: '1789000005.16',
    data: { caller: '', did: '', dialstatus: '', answeredtime: '', disposition: '', hangupcause: '', dialedtime: '', direction: 'in' } },
  'call-end-answered.evt': { kind: 'call-end', modem: 'gsm1', uniqueid: '1789000003.14',
    data: { caller: '+375291112233', did: '+375290000001', dialstatus: 'ANSWER', answeredtime: '42', disposition: 'ANSWERED', hangupcause: '16',
      dialedtime: '57', direction: 'in' } },
  'call-end-non-numeric.evt': { kind: 'call-end', modem: 'gsm2', uniqueid: '1789000006.17',
    data: { caller: '', did: '', dialstatus: 'ANSWER', answeredtime: '1.5', disposition: 'ANSWERED', hangupcause: '-1', dialedtime: ' 7',
      direction: 'in' } },
  'call-end-incoming-dash.evt': { kind: 'call-end', modem: 'gsm2', uniqueid: '1789000014.25',
    data: { caller: '+1234567891', did: '', dialstatus: 'NOANSWER', answeredtime: '', disposition: 'NO ANSWER', hangupcause: '16', dialedtime: '30',
      direction: 'in' } },
  'call-end-outgoing.evt': { kind: 'call-end', modem: 'gsm1', uniqueid: '1789000013.24',
    data: { caller: '599', did: '+1234567890', dialstatus: 'ANSWER', answeredtime: '42', disposition: 'ANSWERED', hangupcause: '16', dialedtime: '51',
      direction: 'out' } },
  'sms-alphanumeric-sender.evt': { kind: 'sms', modem: 'gsm2', uniqueid: '1789000001.12',
    data: { sender: 'MTS Bank', text: 'Kod 4821. Nikomu ne soobshchayte.', scts: '2026-09-10 12:35:01 +03:00' } },
  'sms-anonymous-empty.evt': { kind: 'sms', modem: 'gsm1', uniqueid: '1789000002.13', data: { sender: '', text: '', scts: '' } },
  'sms-cyrillic-multiline.evt': { kind: 'sms', modem: 'gsm1', uniqueid: '1789000000.11',
    data: { sender: '+1234567890', text: `Привет!\nВторая строка: 100 ₽ — «ok», tab${TAB}и эмодзи 👍\n`, scts: '2026-09-10 12:34:56 +03:00' } },
  'sms-report-delivered.evt': { kind: 'sms-report', modem: 'gsm1', uniqueid: '1789000008.19',
    data: { payload: '7:2', type: 'e', success: '1', scts: '2026-09-10 12:40:00 +03:00', dt: '2026-09-10 12:40:03 +03:00', report: '000,' } },
  'sms-report-expired.evt': { kind: 'sms-report', modem: 'gsm2', uniqueid: '1789000009.20',
    data: { payload: '7:2', type: 't', success: '0', scts: '', dt: '', report: '' } },
  'sms-report-submitted.evt': { kind: 'sms-report', modem: 'gsm1', uniqueid: '1789000007.18',
    data: { payload: '7:2', type: 'i', success: '1', scts: '', dt: '', report: '' } },
};

/** One problem per file of malformed/ and the reason it is refused with. */
const MALFORMED = {
  'call-end-bad-direction.evt': 'field 8 (direction): must be in, out or -',
  'call-end-nine-fields.evt': 'call-end: expected 13 or 14 TAB-separated columns, found 15',
  'call-end-no-uniqueid.evt': 'call-end without uniqueid',
  'crlf.evt': 'CR in the line (CRLF line end?)',
  'emitted-mismatch.evt': 'emitted_epoch_s does not match the nanoseconds of the event id',
  'empty-field.evt': 'field 3 (scts) is empty',
  'empty.evt': 'empty file',
  'event-id-not-numeric.evt': 'invalid event id (expected <epoch_ns>-<pid>-<uniqueid|->)',
  'event-id-other-uniqueid.evt': 'the event id does not end with the uniqueid column',
  'modem-uppercase.evt': 'invalid modem id',
  'no-line-end.evt': 'no LF at the end (incomplete line)',
  'non-ascii-byte.evt': 'a byte that is neither printable ASCII nor TAB',
  'sms-report-success-2.evt': 'field 3 (success): must be 0 or 1',
  'sms-report-type-absent.evt': 'field 2 (type): must be i, e or t',
  'sms-report-type-x.evt': 'field 2 (type): must be i, e or t',
  'sms-sender-bad-base64.evt': 'field 1 (sender): invalid base64',
  'sms-sender-no-sentinel.evt': 'field 1 (sender): missing x sentinel',
  'sms-sender-non-canonical.evt': 'field 1 (sender): non-canonical base64',
  'sms-text-not-utf8.evt': 'field 2 (text): not UTF-8',
  'sms-two-fields.evt': 'sms: expected 9 TAB-separated columns, found 8',
  'space-in-field.evt': 'field 1 (sender): invalid base64',
  'two-lines.evt': 'more than one line',
  'uniqueid-slash.evt': 'invalid uniqueid',
  'unknown-kind.evt': 'unknown kind',
  'version-2.evt': 'unknown version (this controller reads version 1)',
};

/**
 * @param {() => unknown} fn
 * @param {string} reason
 */
function assertRefused(fn, reason) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof DecodeError, String(err));
    assert.equal(err.reason, reason);
    assert.equal(err.message, `malformed spool event: ${reason}`);
    return true;
  });
}

describe('spool decode', () => {
  test('the smoke-test files decode to what the dialplan passed: hostile caller id and sender, Cyrillic text, the report', () => {
    assert.deepEqual(listing('smoke/'), Object.keys(SMOKE).sort());
    for (const [name, expected] of Object.entries(SMOKE)) {
      const bytes = fixture(`smoke/${name}`);
      const event = decodeFile(bytes);
      const { version, kind, id, modem, emitted, emittedMs, uniqueid, data } = event;
      assert.deepEqual({ kind, modem, uniqueid, emitted, emittedMs, data }, expected, name);
      assert.equal(version, 1);
      assert.equal(`${id}.evt`, name);
      assert.deepEqual(event.fields, bytes.toString('latin1').slice(0, -1).split('\t').slice(6));
    }
  });

  test('the files aster-emit wrote for the other cases decode: multiline text, alphanumeric and empty senders, `-`, reports i/e/t', () => {
    assert.deepEqual(listing('valid/'), Object.keys(VALID).sort());
    for (const [name, expected] of Object.entries(VALID)) {
      const { kind, modem, uniqueid, data } = decodeFile(fixture(`valid/${name}`));
      assert.deepEqual({ kind, modem, uniqueid, data }, expected, name);
    }
  });

  test('every malformed file is refused with its reason, and no reason repeats a field of the line', () => {
    assert.deepEqual(listing('malformed/'), Object.keys(MALFORMED).sort());
    for (const [name, reason] of Object.entries(MALFORMED)) {
      const bytes = fixture(`malformed/${name}`);
      assertRefused(() => decodeFile(bytes), reason);
      const message = (() => {
        try {
          decodeFile(bytes);
        } catch (err) {
          return String(/** @type {Error} */ (err).message);
        }
        return '';
      })();
      for (const field of bytes.toString('latin1').split(/[\t\r\n]/).slice(6)) {
        if (field.length >= 4) assert.ok(!message.includes(field), `${name}: the reason repeats ${field}`);
      }
    }
  });

  test('b64x: `-` and a bare x are empty, the sentinel is stripped; only canonical base64 of x + UTF-8 is accepted', () => {
    assert.equal(b64x('-'), '');
    assert.equal(b64x('eA=='), '');
    assert.equal(b64x('eDQy'), '42');
    assert.equal(b64x(base64('xПривет, мир')), 'Привет, мир');
    assert.equal(b64x(base64('xx')), 'x');
    const bom = String.fromCharCode(0xfeff);
    assert.equal(b64x(base64([0x78, 0xef, 0xbb, 0xbf, 0x41])), `${bom}A`, 'a byte order mark is kept');
    assertRefused(() => b64x('eA'), 'invalid base64');
    assertRefused(() => b64x('eA='), 'invalid base64');
    assertRefused(() => b64x('e A=='), 'invalid base64');
    assertRefused(() => b64x('eA==eA=='), 'invalid base64');
    assertRefused(() => b64x(''), 'invalid base64');
    assertRefused(() => b64x('eB=='), 'non-canonical base64');
    assertRefused(() => b64x('eDR='), 'non-canonical base64');
    assertRefused(() => b64x(base64('+1234567890')), 'missing x sentinel');
    assertRefused(() => b64x(base64([0x78, 0xd0])), 'not UTF-8');
    assertRefused(() => b64x(base64([0x78, 0xed, 0xa0, 0x80])), 'not UTF-8');
  });

  test('b64 (the SMS text): no sentinel, `-` is empty, the same base64 and UTF-8 rules', () => {
    assert.equal(b64('-'), '');
    assert.equal(b64('aGk='), 'hi');
    assert.equal(b64(base64('xhi')), 'xhi');
    assertRefused(() => b64('aGl='), 'non-canonical base64');
    assertRefused(() => b64('aGk'), 'invalid base64');
    assertRefused(() => b64(base64([0xff])), 'not UTF-8');
  });

  test('every kind keeps its field list, and report types i/e/t are the AMI Types 0/1/2', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(KINDS).map(([kind, fields]) => [kind, fields.map(([name]) => name)])), {
      sms: ['sender', 'text', 'scts'],
      'call-end': ['caller', 'did', 'dialstatus', 'answeredtime', 'disposition', 'hangupcause', 'dialedtime', 'direction'],
      'sms-report': ['payload', 'type', 'success', 'scts', 'dt', 'report'],
    });
    assert.deepEqual({ ...REPORT_TYPES }, { i: 0, e: 1, t: 2 });
  });

  test('parseLine keeps the raw fields, maps uniqueid `-` to null and takes emittedMs from the nanoseconds of the event id', () => {
    const line = `1${TAB}sms${TAB}1789000000999999999-42--${TAB}gsm_1${TAB}1789000000${TAB}-${TAB}eA==${TAB}-${TAB}eA==`;
    const event = parseLine(line);
    assert.deepEqual({ ...event }, {
      version: 1, kind: 'sms', id: '1789000000999999999-42--', modem: 'gsm_1', emitted: 1789000000, emittedMs: 1789000000999,
      uniqueid: null, fields: ['eA==', '-', 'eA=='], data: { sender: '', text: '', scts: '' },
    });
    assertRefused(() => parseLine(line.replace('1789000000999999999', '17890000009999999999')), 'invalid event id (expected <epoch_ns>-<pid>-<uniqueid|->)');
    assertRefused(() => parseLine(line.replace(`${TAB}1789000000${TAB}`, `${TAB}1789000001${TAB}`)),
      'emitted_epoch_s does not match the nanoseconds of the event id');
  });

  test(`a file larger than ${MAX_FILE_BYTES} bytes is refused whole; one of exactly that size is read`, () => {
    const line = fixture('valid/sms-alphanumeric-sender.evt').toString('latin1').slice(0, -1).split(TAB);
    const padded = (/** @type {number} */ size) => {
      const head = [...line.slice(0, 7)].join(TAB);
      const tail = line[8] ?? '';
      const room = size - head.length - tail.length - 3;
      const text = 'A'.repeat(room - (room % 4));
      return Buffer.from(`${head}${TAB}${text}${TAB}${tail}\n`.padEnd(size, ''), 'latin1');
    };
    const atLimit = padded(MAX_FILE_BYTES);
    assert.ok(atLimit.length <= MAX_FILE_BYTES);
    assert.equal(decodeFile(atLimit).kind, 'sms');
    assertRefused(() => decodeFile(Buffer.concat([atLimit, Buffer.alloc(MAX_FILE_BYTES + 1 - atLimit.length, 0x41)])), `larger than ${MAX_FILE_BYTES} bytes`);
  });
});
