// @ts-check
// Tests for src/notify/hooks.js through the real spool ingester: one notification per recipient for missed calls and SMS,
// recipient resolution, and the registry falling back to its last valid version.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createIngestHooks } from '../src/notify/hooks.js';
import { ingestFile } from '../src/spool/ingest.js';
import { migrate, open } from '../src/store/db.js';

/** @typedef {import('../src/config/registry.js').Registry} Registry */

const FIXTURES = new URL('./fixtures/spool/', import.meta.url);
const TAB = String.fromCharCode(9);
const NOW = Date.UTC(2026, 8, 11, 11, 0, 0);
const HOST = 'aster-test';

const tmp = mkdtempSync(join(tmpdir(), 'aster-notify-hooks-'));
/** @type {Array<import('node:sqlite').DatabaseSync>} */
const opened = [];
after(() => {
  for (const db of opened) db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * The registry of these tests: the modems of fixtures/spool/calls (cap_*), gsm1/gsm2 and gsm_test.
 * @param {{ defaults?: string[], alerts?: boolean }} [options]
 * @returns {Registry}
 */
function testRegistry({ defaults = ['111222333', '-1001234567890'] } = {}) {
  const quiet = (/** @type {string} */ id, /** @type {string} */ imei, /** @type {Record<string, unknown>} */ extra = {}) => ({ id, driver: 'quectel', imei, enabled: false, ...extra });
  return validate({
    version: 1,
    settings: { timezone: 'Europe/Istanbul' },
    telegram: { default_recipients: defaults },
    modems: [
      quiet('cap_noanswer', '000000000000103'),
      quiet('cap_busy', '000000000000104', { recipients: ['777'] }),
      quiet('cap_congestion', '000000000000105', { recipients: [] }),
      quiet('gsm1', '000000000000201', { recipients: ['111', '222'] }),
      quiet('gsm2', '000000000000202'),
    ],
    phones: [],
  });
}

/**
 * @param {{ registry?: () => Registry | null, host?: () => string }} [options]
 */
function setup({ registry = () => testRegistry(), host = () => HOST } = {}) {
  const home = mkdtempSync(join(tmp, 'case-'));
  const events = join(home, 'spool', 'events');
  mkdirSync(events, { recursive: true });
  const db = open(join(home, 'aster.db'));
  opened.push(db);
  migrate(db);
  const bus = createBus();
  /** @type {Array<{ type: string, payload: Record<string, unknown> }>} */
  const published = [];
  /** @type {boolean[]} */
  const inTransaction = [];
  bus.subscribe((event) => {
    published.push({ type: event.type, payload: { ...event.payload } });
    inTransaction.push(db.isTransaction);
  });
  const hooks = createIngestHooks({ registry, bus, now: () => NOW, host });
  /**
   * Copies a fixture into the spool under its event id (or a variant's bytes) and ingests it.
   * @param {string | { id: string, bytes: Buffer }} source
   */
  const ingest = (source) => {
    const bytes = typeof source === 'string' ? readFileSync(new URL(source, FIXTURES)) : source.bytes;
    const id = typeof source === 'string' ? bytes.toString('latin1').split(TAB)[2] : source.id;
    const path = join(events, `${id}.evt`);
    writeFileSync(path, bytes);
    return ingestFile(db, path, { hooks, now: () => NOW });
  };
  const notifications = () => db.prepare('SELECT source_kind, source_id, chat_id, part_no, part_count, text, status, next_at, created_at FROM notifications ORDER BY id')
    .all().map((row) => ({ ...row }));
  return { db, events, ingest, notifications, published, inTransaction, hooks };
}

/**
 * A copy of a fixture line with its event id moved by `shift` seconds (so it is a new event with the same uniqueid) and `edit` applied.
 * @param {string} path
 * @param {number} shift
 * @param {(columns: string[]) => void} [edit]
 */
function variant(path, shift, edit) {
  const columns = readFileSync(new URL(path, FIXTURES)).toString('latin1').slice(0, -1).split(TAB);
  const match = /^([0-9]+)(-.*)$/.exec(columns[2] ?? '');
  assert.ok(match);
  const ns = (BigInt(match[1] ?? '') + BigInt(shift) * 1_000_000_000n).toString();
  columns[2] = `${ns}${match[2]}`;
  columns[4] = ns.slice(0, -9);
  edit?.(columns);
  return { id: columns[2], bytes: Buffer.from(`${columns.join(TAB)}\n`, 'latin1') };
}

/** @param {string} value */
const b64x = (value) => Buffer.from(`x${value}`, 'utf8').toString('base64');

describe('notify ingest hooks', () => {
  test('the captured call-end events: outcome stored, and one notification per recipient for each missed call only', () => {
    const { db, ingest, notifications } = setup();
    const files = readdirSync(new URL('calls/', FIXTURES)).filter((name) => name.endsWith('.evt')).sort();
    assert.equal(files.length, 12);
    for (const file of files) assert.equal(ingest(`calls/${file}`).status, 'ingested', file);
    const calls = db.prepare('SELECT id, modem_id, uniqueid, dialstatus, outcome FROM calls ORDER BY id').all().map((row) => ({ ...row }));
    /** @type {Record<string, string>} */
    const outcomes = {};
    for (const call of calls) outcomes[String(call.modem_id) + (call.dialstatus === null ? '' : `:${call.dialstatus}`)] = String(call.outcome);
    assert.deepEqual(outcomes, {
      'cap_busy:BUSY': 'missed', // anonymous-busy and busy share the modem and status
      'cap_answered:ANSWER': 'answered',
      'cap_callerend:ANSWER': 'answered',
      cap_nodial: 'missed',
      'cap_cancel:CANCEL': 'missed',
      'cap_unavail:CHANUNAVAIL': 'missed',
      'cap_congestion:CONGESTION': 'missed',
      'cap_noanswer:NOANSWER': 'missed',
      'cap_invalid:INVALIDARGS': 'failed',
      cap_empty: 'missed',
    });
    const byCall = new Map(calls.map((call) => [call.id, call]));
    /** @type {Record<string, string[]>} */
    const sent = {};
    for (const row of notifications()) {
      assert.equal(row.source_kind, 'call');
      assert.deepEqual([row.part_no, row.part_count, row.status, row.next_at, row.created_at], [1, 1, 'pending', NOW, NOW]);
      const call = byCall.get(row.source_id);
      assert.ok(call, `source_id ${row.source_id} is a calls row`);
      assert.equal(call.outcome, 'missed');
      const key = `${call.uniqueid}`;
      sent[key] = [...(sent[key] ?? []), String(row.chat_id)];
    }
    // missed calls: busy ×2 (modem recipients ['777']), congestion (recipients [] → nobody), noanswer ×2, unavail, cancel, empty, nodial
    // (defaults, two chats each); answered and failed calls: none
    const missedUniqueids = calls.filter((call) => call.outcome === 'missed').map((call) => String(call.uniqueid));
    assert.equal(missedUniqueids.length, 9);
    for (const call of calls) {
      const chats = sent[String(call.uniqueid)] ?? [];
      if (call.outcome !== 'missed' || call.modem_id === 'cap_congestion') assert.deepEqual(chats, [], `${call.modem_id} ${call.dialstatus}`);
      else if (call.modem_id === 'cap_busy') assert.deepEqual(chats, ['777']);
      else assert.deepEqual(chats, ['111222333', '-1001234567890'], `${call.modem_id} ${call.dialstatus}`);
    }
    assert.equal(notifications().length, 2 + 6 * 2);
  });

  test('an outgoing call never sends a missed-call notification: no answer, busy and cancel are unanswered, the rest failed', () => {
    const { db, ingest, notifications } = setup();
    for (const file of ['noanswer', 'busy', 'cancel', 'chanunavail', 'congestion']) {
      assert.equal(ingest(variant(`calls/${file}.evt`, 1, (columns) => void columns.push('out'))).status, 'ingested', file);
    }
    assert.deepEqual(db.prepare('SELECT dialstatus, direction, outcome FROM calls ORDER BY id').all().map((row) => Object.values(row).join(' ')), [
      'NOANSWER out unanswered', 'BUSY out unanswered', 'CANCEL out unanswered', 'CHANUNAVAIL out failed', 'CONGESTION out failed',
    ]);
    assert.deepEqual(notifications(), []);
  });

  test('the missed-call text: the modem id, caller or unknown, the time in the registry timezone, the reason', () => {
    const { ingest, notifications } = setup();
    ingest('calls/did-noanswer.evt');
    ingest('calls/anonymous-busy.evt');
    ingest('calls/cancel.evt');
    ingest('calls/ring-empty.evt');
    const texts = [...new Set(notifications().map((row) => String(row.text)))];
    const at = (/** @type {string} */ file) => {
      const ns = readFileSync(new URL(file, FIXTURES)).toString('latin1').split(TAB)[2]?.split('-')[0] ?? '';
      const ms = Number(BigInt(ns) / 1_000_000n);
      // Europe/Istanbul is UTC+3 all year
      return new Date(ms + 3 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    };
    assert.deepEqual(texts, [
      `[${HOST}] Missed call cap_noanswer from +375290000109 [${at('calls/did-noanswer.evt')} +03:00] (no answer)`,
      `[${HOST}] Missed call cap_busy from unknown [${at('calls/anonymous-busy.evt')} +03:00] (busy)`,
      `[${HOST}] Missed call cap_cancel from +375290000100 [${at('calls/cancel.evt')} +03:00] (caller hung up)`,
      `[${HOST}] Missed call cap_empty from +375290000100 [${at('calls/ring-empty.evt')} +03:00] (nobody was dialed)`,
    ]);
  });

  test('a replayed file and a second call-end of the same uniqueid add no notification', () => {
    const { db, events, ingest, notifications } = setup();
    const first = ingest('calls/noanswer.evt');
    assert.equal(first.status, 'ingested');
    assert.equal(notifications().length, 2);
    // the same file again (a crash between COMMIT and unlink)
    copyFileSync(new URL('calls/noanswer.evt', FIXTURES), join(events, `${first.id}.evt`));
    assert.equal(ingestFile(db, join(events, `${first.id}.evt`), { hooks: createIngestHooks({ registry: () => testRegistry() }) }).status, 'replayed');
    // a second hangup-handler run for the same channel: a new event id, the same uniqueid
    const second = ingest(variant('calls/noanswer.evt', 1));
    assert.equal(second.status, 'ingested');
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM events').get()?.n), 2);
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM calls').get()?.n), 1);
    assert.equal(notifications().length, 2, 'one notification per recipient per missed call');
  });

  test('an SMS: one notification per recipient with its text; modem recipients, defaults, an unknown modem, nobody', () => {
    const { ingest, notifications, db } = setup();
    ingest('valid/sms-cyrillic-multiline.evt'); // gsm1: recipients 111, 222
    ingest('valid/sms-alphanumeric-sender.evt'); // gsm2: defaults
    ingest('valid/sms-anonymous-empty.evt'); // gsm1, empty sender, text and scts
    ingest('smoke/1789052157042129481-936-1789052157.5.evt'); // gsm_test: not in the registry → defaults
    ingest(variant('valid/sms-alphanumeric-sender.evt', 5, (columns) => { columns[3] = 'cap_congestion'; })); // recipients [] → nobody
    ingest('valid/sms-report-delivered.evt'); // reports never notify
    const messageIds = db.prepare('SELECT id, modem_id FROM messages ORDER BY id').all().map((row) => [row.id, row.modem_id]);
    assert.equal(messageIds.length, 5);
    assert.deepEqual(notifications().map((row) => [row.source_kind, row.source_id, row.chat_id, row.text]), [
      ['sms', messageIds[0]?.[0], '111', `[${HOST}] SMS gsm1 from +1234567890 [2026-09-10 12:34:56 +03:00]\nПривет!\nВторая строка: 100 ₽ — «ok», tab\tи эмодзи 👍\n`],
      ['sms', messageIds[0]?.[0], '222', `[${HOST}] SMS gsm1 from +1234567890 [2026-09-10 12:34:56 +03:00]\nПривет!\nВторая строка: 100 ₽ — «ok», tab\tи эмодзи 👍\n`],
      ['sms', messageIds[1]?.[0], '111222333', `[${HOST}] SMS gsm2 from MTS Bank [2026-09-10 12:35:01 +03:00]\nKod 4821. Nikomu ne soobshchayte.`],
      ['sms', messageIds[1]?.[0], '-1001234567890', `[${HOST}] SMS gsm2 from MTS Bank [2026-09-10 12:35:01 +03:00]\nKod 4821. Nikomu ne soobshchayte.`],
      ['sms', messageIds[2]?.[0], '111', `[${HOST}] SMS gsm1 from unknown\n`],
      ['sms', messageIds[2]?.[0], '222', `[${HOST}] SMS gsm1 from unknown\n`],
      ['sms', messageIds[3]?.[0], '111222333', `[${HOST}] SMS gsm_test from ";touch /tmp/aster-smoke-pwned;" [2026-09-10 09:30:00 +0300]\nПривет из smoke-теста`],
      ['sms', messageIds[3]?.[0], '-1001234567890', `[${HOST}] SMS gsm_test from ";touch /tmp/aster-smoke-pwned;" [2026-09-10 09:30:00 +0300]\nПривет из smoke-теста`],
    ]);
  });

  test('a long SMS becomes ordered parts per recipient', () => {
    const { ingest, notifications } = setup();
    const long = Array.from({ length: 200 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n');
    ingest(variant('valid/sms-alphanumeric-sender.evt', 9, (columns) => { columns[7] = Buffer.from(long, 'utf8').toString('base64'); }));
    const rows = notifications();
    assert.deepEqual(rows.map((row) => [row.chat_id, row.part_no, row.part_count]), [
      ['111222333', 1, 3], ['111222333', 2, 3], ['111222333', 3, 3], ['-1001234567890', 1, 3], ['-1001234567890', 2, 3], ['-1001234567890', 3, 3],
    ]);
    assert.equal(rows.slice(0, 3).map((row) => row.text).join('\n'), `[${HOST}] SMS gsm2 from MTS Bank [2026-09-10 12:35:01 +03:00]\n${long}`);
  });

  test('the host name is read for each text: a renamed host is named from the next one on, and no name is no prefix', () => {
    let name = 'aster-old';
    const { ingest, notifications } = setup({ host: () => name });
    ingest('valid/sms-anonymous-empty.evt'); // gsm1: recipients 111, 222
    name = 'aster-new';
    ingest('calls/noanswer.evt'); // cap_noanswer: the default recipients
    name = '';
    ingest('valid/sms-alphanumeric-sender.evt'); // gsm2: the default recipients
    const texts = notifications().map((row) => String(row.text).split('\n')[0]);
    assert.equal(texts.length, 6);
    assert.deepEqual(texts.slice(0, 2), ['[aster-old] SMS gsm1 from unknown', '[aster-old] SMS gsm1 from unknown']);
    assert.match(texts[2] ?? '', /^\[aster-new\] Missed call cap_noanswer from /);
    assert.match(texts[3] ?? '', /^\[aster-new\] Missed call cap_noanswer from /);
    assert.deepEqual(texts.slice(4), ['SMS gsm2 from MTS Bank [2026-09-10 12:35:01 +03:00]', 'SMS gsm2 from MTS Bank [2026-09-10 12:35:01 +03:00]']);
  });

  test('while the registry cannot be loaded the last valid one decides; without one the event rolls back and its file stays', () => {
    /** @type {Registry | null} */
    let current = null;
    const { db, events, ingest, notifications, published } = setup({ registry: () => current });
    const edit = (/** @type {string[]} */ columns) => { columns[6] = b64x('+375290000001'); };
    const pending = variant('calls/busy.evt', 20, edit);
    assert.throws(() => ingest(pending), /the registry cannot be loaded/);
    assert.deepEqual(readdirSync(events), [`${pending.id}.evt`], 'the file stays for the next scan');
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM events').get()?.n), 0, 'nothing of the event is stored');
    assert.equal(published.length, 0);
    // an answered call needs no recipients, so it is ingested even now
    assert.equal(ingest('calls/answered.evt').status, 'ingested');

    current = testRegistry({ defaults: ['999'] });
    assert.equal(ingest(variant('calls/noanswer.evt', 30)).status, 'ingested');
    current = null;
    assert.equal(ingest(pending).status, 'ingested');
    assert.deepEqual(notifications().map((row) => row.chat_id), ['999', '777'], 'the last valid registry (cap_busy → 777)');
  });

  test('message.new and call.new are published after COMMIT with the stored row; replays and reports publish nothing', () => {
    const { db, ingest, published, inTransaction } = setup();
    const sms = ingest('valid/sms-alphanumeric-sender.evt');
    const call = ingest('calls/answered.evt');
    ingest('valid/sms-report-submitted.evt');
    assert.equal(ingest('calls/answered.evt').status, 'replayed');
    assert.deepEqual(published.map((event) => event.type), ['message.new', 'call.new']);
    assert.deepEqual(inTransaction, [false, false], 'published once the transaction is committed');
    assert.deepEqual(published[0]?.payload, { ...db.prepare('SELECT * FROM messages WHERE event_id = ?').get(String(sms.id)) });
    assert.deepEqual(published[1]?.payload, { ...db.prepare('SELECT * FROM calls WHERE event_id = ?').get(String(call.id)) });
    assert.equal(published[1]?.payload.outcome, 'answered');
  });

  test('an afterCommit hook that throws is reported on the result; the event stays stored and its file is removed', () => {
    const { db, events } = setup();
    const hooks = createIngestHooks({ registry: () => testRegistry() });
    const failing = { ...hooks, afterCommit: () => { throw new Error('listener broke'); } };
    const bytes = readFileSync(new URL('calls/answered.evt', FIXTURES));
    const id = bytes.toString('latin1').split(TAB)[2];
    writeFileSync(join(events, `${id}.evt`), bytes);
    const result = ingestFile(db, join(events, `${id}.evt`), { hooks: failing });
    assert.equal(result.status, 'ingested');
    assert.equal(result.hookError?.message, 'listener broke');
    assert.deepEqual(readdirSync(events), []);
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM calls').get()?.n), 1);
  });
});
