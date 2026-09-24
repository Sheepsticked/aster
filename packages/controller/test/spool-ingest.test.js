// @ts-check
// Tests for src/spool/ingest.js: files become rows exactly once, bad files are quarantined, failures roll back and leave the
// file, and start() scans, watches and retries.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { applyReport } from '../src/sms/reports.js';
import { ingestFile, start } from '../src/spool/ingest.js';
import { migrate, open } from '../src/store/db.js';

/** @typedef {import('../src/log.js').Logger} Logger */
/** @typedef {import('../src/spool/ingest.js').Hooks} Hooks */

const FIXTURES = new URL('./fixtures/spool/', import.meta.url);
const TAB = String.fromCharCode(9);
const NOW = 1789100000000;
const now = () => NOW;
/** @param {string} path */
const fixture = (path) => readFileSync(new URL(path, FIXTURES));
/** @param {string} dir */
const listing = (dir) => readdirSync(new URL(dir, FIXTURES)).sort();

const tmp = mkdtempSync(join(tmpdir(), 'aster-spool-'));
/** @type {DatabaseSync[]} */
const opened = [];
after(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** A migrated database and an empty spool (spool/events, spool/quarantine beside it). */
function setup() {
  const home = mkdtempSync(join(tmp, 'case-'));
  const events = join(home, 'spool', 'events');
  mkdirSync(events, { recursive: true });
  const db = open(join(home, 'aster.db'));
  opened.push(db);
  migrate(db);
  return { home, db, events, quarantine: join(home, 'spool', 'quarantine'), dbPath: join(home, 'aster.db') };
}

/**
 * Copies a fixture into the spool and returns the path: named <event_id>.evt as aster-emit names it, a malformed fixture under its
 * own name, or `name`.
 * @param {string} events
 * @param {string} path
 * @param {string} [name]
 */
function put(events, path, name = path.startsWith('malformed/') ? path.slice('malformed/'.length)
  : `${fixture(path).toString('latin1').split(TAB)[2]}.evt`) {
  const target = join(events, name);
  copyFileSync(new URL(path, FIXTURES), target);
  return target;
}

/**
 * @param {DatabaseSync} db
 * @param {string} sql
 * @returns {Record<string, unknown>[]}
 */
const rows = (db, sql) => db.prepare(sql).all().map((row) => ({ ...row }));
/** @param {DatabaseSync} db */
const counts = (db) => Object.fromEntries(['events', 'messages', 'calls'].map((table) => [table,
  Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)]));
/** @param {DatabaseSync} db */
const snapshot = (db) => ({
  events: rows(db, 'SELECT * FROM events ORDER BY id'),
  messages: rows(db, 'SELECT * FROM messages ORDER BY id'),
  calls: rows(db, 'SELECT * FROM calls ORDER BY id'),
  sms_attempts: rows(db, 'SELECT * FROM sms_attempts ORDER BY outbox_id, attempt_no'),
});
/** @param {string} dir */
const filesIn = (dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/**
 * The columns of a fixture line, edited, as file bytes; `shift` moves the event id (and emitted_epoch_s) by whole seconds, so the
 * uniqueid stays and the id is new.
 * @param {string} path
 * @param {{ shift?: number, edit?: (columns: string[]) => void }} [options]
 */
function variant(path, { shift = 0, edit } = {}) {
  const columns = fixture(path).toString('latin1').slice(0, -1).split(TAB);
  const match = /^([0-9]+)(-.*)$/.exec(columns[2] ?? '');
  assert.ok(match);
  const ns = (BigInt(match[1] ?? '') + BigInt(shift) * 1_000_000_000n).toString();
  columns[2] = `${ns}${match[2]}`;
  columns[4] = ns.slice(0, -9);
  edit?.(columns);
  return { id: columns[2], bytes: Buffer.from(`${columns.join(TAB)}\n`, 'latin1') };
}

/** A logger that keeps its lines. */
function capture() {
  /** @type {Array<{ level: string, msg: string, fields: Record<string, unknown> }>} */
  const lines = [];
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ fields = {}) => {
    lines.push({ level, msg, fields });
  };
  /** @type {Logger} */
  const log = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => log };
  return { log, lines };
}

/**
 * @param {() => boolean} check
 * @param {number} [ms]
 */
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

/** Holds the write lock of a database from a second connection; the ingest connection gives up at once. */
function lock(/** @type {DatabaseSync} */ db, /** @type {string} */ dbPath) {
  db.exec('PRAGMA busy_timeout = 0');
  const other = new DatabaseSync(dbPath);
  opened.push(other);
  other.exec('BEGIN IMMEDIATE');
  return () => {
    other.exec('ROLLBACK');
    other.close();
  };
}

describe('spool ingest', () => {
  test('the smoke-test files become calls and messages rows; hostile caller id and sender are stored as plain text', () => {
    const { db, events } = setup();
    const names = listing('smoke/');
    for (const name of names) put(events, `smoke/${name}`);
    for (const name of names) {
      const result = ingestFile(db, join(events, name), { now });
      assert.equal(result.status, 'ingested', name);
      assert.equal(`${result.id}.evt`, name);
    }
    assert.deepEqual(filesIn(events), []);
    assert.deepEqual(rows(db, 'SELECT * FROM calls ORDER BY id'), [
      { id: 1, event_id: '1789052155654316892-728-1789052155.1', modem_id: 'gsm_test', uniqueid: '1789052155.1', caller: '`id`;$(id)',
        did: null, dialstatus: 'CHANUNAVAIL', answered_sec: null, dialed_sec: null, disposition: 'NO ANSWER', hangupcause: 3,
        outcome: 'pending', ended_at: 1789052155654, direction: 'in' },
      { id: 2, event_id: '1789052156669849990-875-1789052156.3', modem_id: 'gsm_test', uniqueid: '1789052156.3', caller: '+375290000001',
        did: '+1234567890', dialstatus: 'CHANUNAVAIL', answered_sec: null, dialed_sec: null, disposition: 'NO ANSWER', hangupcause: 3,
        outcome: 'pending', ended_at: 1789052156669, direction: 'in' },
      { id: 3, event_id: '1790239200724224715-977-1790239200.5', modem_id: 'gsm_test', uniqueid: '1790239200.5', caller: '599',
        did: '+1234567890', dialstatus: 'CHANUNAVAIL', answered_sec: null, dialed_sec: null, disposition: 'NO ANSWER', hangupcause: 44,
        outcome: 'pending', ended_at: 1790239200724, direction: 'out' },
    ]);
    assert.deepEqual(rows(db, 'SELECT * FROM messages'), [
      { id: 1, event_id: '1789052157042129481-936-1789052157.5', modem_id: 'gsm_test', sender: '";touch /tmp/aster-smoke-pwned;"',
        text: 'Привет из smoke-теста', scts: '2026-09-10 09:30:00 +0300', received_at: 1789052157042 },
    ]);
    const stored = rows(db, 'SELECT id, kind, modem_id, uniqueid, emitted_at, received_at, fields_json FROM events ORDER BY id');
    assert.deepEqual(stored.map(({ id, kind, uniqueid, emitted_at, received_at }) => [id, kind, uniqueid, emitted_at, received_at]), [
      ['1789052155654316892-728-1789052155.1', 'call-end', '1789052155.1', 1789052155654, NOW],
      ['1789052156669849990-875-1789052156.3', 'call-end', '1789052156.3', 1789052156669, NOW],
      ['1789052157042129481-936-1789052157.5', 'sms', '1789052157.5', 1789052157042, NOW],
      ['1789052157382107899-997-1789052157.7', 'sms-report', '1789052157.7', 1789052157382, NOW],
      ['1790239200724224715-977-1790239200.5', 'call-end', '1790239200.5', 1790239200724, NOW],
    ]);
    assert.deepEqual(JSON.parse(String(stored[3]?.fields_json)),
      { payload: '42:1', type: 'e', success: '1', scts: '2026-09-10 09:30:05 +0300', dt: '2026-09-10 09:30:07 +0300', report: '+CDS: 6' });
  });

  test('Cyrillic multiline text, alphanumeric and anonymous senders, `-` and non-numeric call fields (→ NULL), both directions', () => {
    const { db, events } = setup();
    for (const name of listing('valid/').filter((file) => !file.startsWith('sms-report'))) {
      assert.equal(ingestFile(db, put(events, `valid/${name}`), { now }).status, 'ingested', name);
    }
    const messages = rows(db, 'SELECT sender, text, scts FROM messages ORDER BY event_id');
    assert.deepEqual(messages, [
      { sender: '+1234567890', text: `Привет!\nВторая строка: 100 ₽ — «ok», tab${TAB}и эмодзи 👍\n`, scts: '2026-09-10 12:34:56 +03:00' },
      { sender: 'MTS Bank', text: 'Kod 4821. Nikomu ne soobshchayte.', scts: '2026-09-10 12:35:01 +03:00' },
      { sender: null, text: '', scts: null },
    ]);
    const calls = rows(db, 'SELECT uniqueid, direction, caller, did, dialstatus, answered_sec, dialed_sec, disposition, hangupcause FROM calls ORDER BY uniqueid');
    assert.deepEqual(calls, [
      { uniqueid: '1789000003.14', direction: 'in', caller: '+375291112233', did: '+375290000001', dialstatus: 'ANSWER', answered_sec: 42,
        dialed_sec: 57, disposition: 'ANSWERED', hangupcause: 16 },
      { uniqueid: '1789000005.16', direction: 'in', caller: null, did: null, dialstatus: null, answered_sec: null, dialed_sec: null,
        disposition: null, hangupcause: null },
      { uniqueid: '1789000006.17', direction: 'in', caller: null, did: null, dialstatus: 'ANSWER', answered_sec: null, dialed_sec: null,
        disposition: 'ANSWERED', hangupcause: null },
      { uniqueid: '1789000013.24', direction: 'out', caller: '599', did: '+1234567890', dialstatus: 'ANSWER', answered_sec: 42, dialed_sec: 51,
        disposition: 'ANSWERED', hangupcause: 16 },
      { uniqueid: '1789000014.25', direction: 'in', caller: '+1234567891', did: null, dialstatus: 'NOANSWER', answered_sec: null,
        dialed_sec: 30, disposition: 'NO ANSWER', hangupcause: 16 },
    ]);
  });

  test('a duplicate file changes nothing: the second copy is replayed and removed, and no hook runs for it', () => {
    const { db, events } = setup();
    let calls = 0;
    /** @type {Hooks} */
    const hooks = { onEvent: () => void (calls += 1) };
    const name = 'valid/sms-cyrillic-multiline.evt';
    assert.equal(ingestFile(db, put(events, name), { now, hooks }).status, 'ingested');
    const before = snapshot(db);
    const again = ingestFile(db, put(events, name), { now: () => NOW + 60_000, hooks });
    assert.deepEqual({ status: again.status, id: again.id, kind: again.kind },
      { status: 'replayed', id: '1789053129099412883-262279-1789000000.11', kind: 'sms' });
    assert.deepEqual(snapshot(db), before);
    assert.equal(calls, 1);
    assert.deepEqual(filesIn(events), []);
  });

  test('crash between COMMIT and unlink: the row exists, and the next attempt only removes the file',
    { skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false }, () => {
      const { db, events } = setup();
      const path = put(events, 'valid/call-end-answered.evt');
      chmodSync(events, 0o555);
      let first;
      try {
        first = ingestFile(db, path, { now });
      } finally {
        chmodSync(events, 0o755);
      }
      assert.equal(first.status, 'ingested');
      assert.equal(/** @type {NodeJS.ErrnoException | undefined} */ (first.unlinkError)?.code, 'EACCES');
      assert.deepEqual(filesIn(events), ['1789053129166434786-262345-1789000003.14.evt']);
      const before = snapshot(db);
      const second = ingestFile(db, path, { now: () => NOW + 1 });
      assert.equal(second.status, 'replayed');
      assert.equal(second.unlinkError, undefined);
      assert.deepEqual(snapshot(db), before);
      assert.deepEqual(counts(db), { events: 1, messages: 0, calls: 1 });
      assert.deepEqual(filesIn(events), []);
    });

  test('every malformed file is moved to spool/quarantine with <name>.reason and leaves no row', () => {
    const { db, events, quarantine } = setup();
    const names = listing('malformed/');
    for (const name of names) {
      const result = ingestFile(db, put(events, `malformed/${name}`), { now });
      assert.equal(result.status, 'quarantined', name);
      assert.ok(result.reason, name);
      assert.equal(readFileSync(join(quarantine, `${name}.reason`), 'utf8'), `2026-09-11T04:13:20.000Z ${result.reason}\n`, name);
      assert.ok(readFileSync(join(quarantine, name)).equals(fixture(`malformed/${name}`)), name);
    }
    assert.deepEqual(filesIn(events), []);
    assert.equal(filesIn(quarantine).length, 2 * names.length);
    assert.equal(readFileSync(join(quarantine, 'sms-sender-no-sentinel.evt.reason'), 'utf8').split(' ').slice(1).join(' '),
      'field 1 (sender): missing x sentinel\n');
    assert.deepEqual(counts(db), { events: 0, messages: 0, calls: 0 });
  });

  test('a file name that is not its event id, and an event id already stored with other content, are quarantined', () => {
    const { db, events, quarantine } = setup();
    const renamed = ingestFile(db, put(events, 'valid/sms-alphanumeric-sender.evt', 'renamed.evt'), { now });
    assert.deepEqual({ ...renamed }, { status: 'quarantined', file: 'renamed.evt', reason: 'the file name is not <event_id>.evt' });
    const original = put(events, 'valid/sms-alphanumeric-sender.evt');
    assert.equal(ingestFile(db, original, { now }).status, 'ingested');
    const forged = variant('valid/sms-alphanumeric-sender.evt', { edit: (columns) => void (columns[3] = 'gsm1') });
    writeFileSync(join(events, `${forged.id}.evt`), forged.bytes);
    const conflict = ingestFile(db, join(events, `${forged.id}.evt`), { now });
    assert.equal(conflict.status, 'quarantined');
    assert.equal(conflict.reason, 'the event id is already stored with different content');
    assert.deepEqual(rows(db, 'SELECT modem_id FROM messages'), [{ modem_id: 'gsm2' }]);
    assert.deepEqual(filesIn(quarantine), [`${forged.id}.evt`, `${forged.id}.evt.reason`, 'renamed.evt', 'renamed.evt.reason'].sort());
  });

  test('a hook that throws rolls the whole event back and leaves the file; hooks see the new row inside the transaction', () => {
    const { db, events } = setup();
    const path = put(events, 'valid/call-end-answered.evt');
    /** @type {Hooks} */
    const broken = { onEvent: () => { throw new Error('notification rows failed'); } };
    assert.throws(() => ingestFile(db, path, { now, hooks: broken }), /notification rows failed/);
    assert.deepEqual(counts(db), { events: 0, messages: 0, calls: 0 });
    assert.equal(db.isTransaction, false);
    assert.deepEqual(filesIn(events), ['1789053129166434786-262345-1789000003.14.evt']);
    /** @type {Array<[number | null, number, boolean]>} */
    const seen = [];
    /** @type {Hooks} */
    const hooks = {
      outcome: (call) => (call.dialstatus === 'ANSWER' ? 'answered' : 'missed'),
      onEvent: ({ db: tx, event, rowId }) => {
        seen.push([rowId, Number(tx.prepare('SELECT count(*) AS n FROM calls WHERE event_id = ?').get(event.id)?.n), tx.isTransaction]);
      },
    };
    assert.equal(ingestFile(db, path, { now, hooks }).status, 'ingested');
    assert.deepEqual(seen, [[1, 1, true]]);
    assert.deepEqual(rows(db, 'SELECT outcome FROM calls'), [{ outcome: 'answered' }]);
  });

  test('a second call-end for a uniqueid that already has a calls row stores the event but no second calls row', () => {
    const { db, events } = setup();
    /** @type {Array<number | null>} */
    const rowIds = [];
    /** @type {Hooks} */
    const hooks = { onEvent: ({ rowId }) => void rowIds.push(rowId) };
    assert.equal(ingestFile(db, put(events, 'valid/call-end-answered.evt'), { now, hooks }).status, 'ingested');
    const later = variant('valid/call-end-answered.evt', { shift: 5 });
    writeFileSync(join(events, `${later.id}.evt`), later.bytes);
    assert.equal(ingestFile(db, join(events, `${later.id}.evt`), { now, hooks }).status, 'ingested');
    assert.deepEqual(rowIds, [1, null]);
    assert.deepEqual(counts(db), { events: 2, messages: 0, calls: 1 });
  });

  test('sms-report: the default hook is sms/reports.js applyReport — each type once per attempt (accepted → delivered, a later expiry changes no status, a repeated report changes nothing); other payloads change nothing', () => {
    const { db, events } = setup();
    db.prepare(`INSERT INTO sms_outbox (id, modem_id, number, text, status, attempt_no, created_at, updated_at)
      VALUES (7, 'gsm1', '+1234567890', 'hi', 'submitted', 2, 1, 1)`).run();
    db.prepare("INSERT INTO sms_attempts (outbox_id, attempt_no, status) VALUES (7, 1, 'rejected'), (7, 2, 'submitted')").run();
    const emitted = (/** @type {string} */ name) => Number(BigInt(name.split('-')[0] ?? '') / 1_000_000n);
    const ids = {};
    /** @type {unknown[]} */
    const statuses = [];
    for (const name of ['sms-report-submitted.evt', 'sms-report-delivered.evt', 'sms-report-expired.evt']) {
      const result = ingestFile(db, put(events, `valid/${name}`), { now });
      assert.equal(result.status, 'ingested', name);
      Object.assign(ids, { [name]: emitted(String(result.id)) });
      statuses.push(db.prepare('SELECT status FROM sms_outbox WHERE id = 7').get()?.status);
    }
    assert.deepEqual(statuses, ['accepted', 'delivered', 'delivered']);
    const late = variant('valid/sms-report-delivered.evt', { shift: 60, edit: (columns) => void (columns[8] = '0') });
    writeFileSync(join(events, `${late.id}.evt`), late.bytes);
    assert.equal(ingestFile(db, join(events, `${late.id}.evt`), { now }).status, 'ingested');
    assert.equal(ingestFile(db, put(events, 'smoke/1789052157382107899-997-1789052157.7.evt'), { now }).status, 'ingested');
    assert.deepEqual(rows(db, 'SELECT * FROM sms_attempts ORDER BY attempt_no'), [
      { outbox_id: 7, attempt_no: 1, submitted_at: null, ami_result: null, report0_at: null, report0_success: null, report1_at: null,
        report1_success: null, report2_at: null, report_raw: null, status: 'rejected' },
      { outbox_id: 7, attempt_no: 2, submitted_at: null, ami_result: null, report0_at: 1789053129222, report0_success: 1,
        report1_at: 1789053129241, report1_success: 1, report2_at: 1789053129259, report_raw: '000,', status: 'delivered' },
    ]);
    assert.deepEqual(ids, { 'sms-report-submitted.evt': 1789053129222, 'sms-report-delivered.evt': 1789053129241,
      'sms-report-expired.evt': 1789053129259 });
    assert.deepEqual(rows(db, 'SELECT status, last_error FROM sms_outbox'), [{ status: 'delivered', last_error: null }]);
    assert.equal(rows(db, 'SELECT id FROM events').length, 5, 'every report file is an events row, the late and the smoke one included');
    const report = { payload: '7:2', type: /** @type {0} */ (0), success: /** @type {0} */ (0), scts: null, dt: null, raw: null,
      source: /** @type {'spool'} */ ('spool'), modemId: 'gsm1', at: 1 };
    for (const payload of ['', '7', '7:', ':2', '0:2', '7:0', '07:2', 'abc', '7:2:1']) {
      assert.equal(applyReport(db, { ...report, payload }).outcome, 'foreign', payload);
    }
    assert.equal(applyReport(db, { ...report, payload: '7:3' }).outcome, 'unknown');
    assert.deepEqual(rows(db, 'SELECT status FROM sms_attempts ORDER BY attempt_no'), [{ status: 'rejected' }, { status: 'delivered' }]);
  });

  test('applyReport replaces the default and receives the report with AMI type numbers', () => {
    const { db, events } = setup();
    /** @type {unknown[]} */
    const reports = [];
    /** @type {Hooks} */
    const hooks = { applyReport: (report, { rowId }) => void reports.push({ ...report, rowId }) };
    for (const name of ['sms-report-submitted.evt', 'sms-report-delivered.evt', 'sms-report-expired.evt']) {
      assert.equal(ingestFile(db, put(events, `valid/${name}`), { now, hooks }).status, 'ingested');
    }
    assert.deepEqual(reports, [
      { payload: '7:2', type: 0, success: 1, scts: null, dt: null, raw: null, source: 'spool', modemId: 'gsm1', at: 1789053129222, rowId: null },
      { payload: '7:2', type: 1, success: 1, scts: '2026-09-10 12:40:00 +03:00', dt: '2026-09-10 12:40:03 +03:00', raw: '000,',
        source: 'spool', modemId: 'gsm1', at: 1789053129241, rowId: null },
      { payload: '7:2', type: 2, success: 0, scts: null, dt: null, raw: null, source: 'spool', modemId: 'gsm2', at: 1789053129259, rowId: null },
    ]);
  });

  test('a locked database: ingestFile throws the SQLite error, the file stays and is not quarantined', () => {
    const { db, events, quarantine, dbPath } = setup();
    const path = put(events, 'valid/sms-alphanumeric-sender.evt');
    const release = lock(db, dbPath);
    try {
      assert.throws(() => ingestFile(db, path, { now }), (err) => {
        assert.equal(/** @type {{ errcode?: number }} */ (err).errcode, 5);
        return true;
      });
    } finally {
      release();
    }
    assert.deepEqual(filesIn(events), ['1789053129122286961-262298-1789000001.12.evt']);
    assert.deepEqual(filesIn(quarantine), []);
    assert.equal(ingestFile(db, path, { now }).status, 'ingested');
  });

  test('a file that cannot be read (a permission problem, not a malformed file) stays in place and is not quarantined',
    { skip: process.getuid?.() === 0 ? 'root ignores file permissions' : false }, () => {
      const { db, events, quarantine } = setup();
      const path = put(events, 'valid/sms-alphanumeric-sender.evt');
      chmodSync(path, 0o000);
      try {
        assert.throws(() => ingestFile(db, path, { now }), { code: 'EACCES' });
      } finally {
        chmodSync(path, 0o644);
      }
      assert.deepEqual(filesIn(events), ['1789053129122286961-262298-1789000001.12.evt']);
      assert.deepEqual(filesIn(quarantine), []);
      assert.equal(ingestFile(db, path, { now }).status, 'ingested');
    });

  test('a file that vanished before it was read is reported as gone', () => {
    const { db, events } = setup();
    assert.deepEqual({ ...ingestFile(db, join(events, 'missing.evt'), { now }) }, { status: 'gone', file: 'missing.evt' });
  });
});

describe('spool ingest start()', () => {
  test('the first scan ingests in name order, quarantines malformed files, skips a fresh .tmp and reads a stale one', async () => {
    const { db, events, quarantine } = setup();
    const valid = ['valid/sms-report-expired.evt', 'valid/call-end-answered.evt', 'valid/sms-alphanumeric-sender.evt'];
    for (const path of valid) put(events, path);
    put(events, 'malformed/version-2.evt');
    const fresh = variant('valid/sms-cyrillic-multiline.evt', { shift: 100 });
    writeFileSync(join(events, `${fresh.id}.tmp`), fresh.bytes.subarray(0, 40));
    const stale = variant('valid/sms-cyrillic-multiline.evt', { shift: -100 });
    writeFileSync(join(events, `${stale.id}.tmp`), stale.bytes);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(events, `${stale.id}.tmp`), old, old);
    writeFileSync(join(events, 'notes.txt'), 'not an event\n');
    mkdirSync(join(events, 'directory.evt'));
    /** @type {string[]} */
    const order = [];
    const { log, lines } = capture();
    const spool = start(db, events, { watch: false, rescanMs: 3_600_000, log, hooks: { onEvent: ({ event }) => void order.push(event.id) } });
    try {
      const result = await spool.scan();
      assert.deepEqual(result, { ingested: 4, replayed: 0, quarantined: 1, failed: 0, skipped: 0 });
    } finally {
      await spool.stop();
    }
    assert.deepEqual(order, [...order].sort());
    assert.equal(order.length, 4);
    assert.ok(order.includes(stale.id));
    assert.deepEqual(filesIn(events), [`${fresh.id}.tmp`, 'directory.evt', 'notes.txt'].sort());
    assert.deepEqual(filesIn(quarantine), ['version-2.evt', 'version-2.evt.reason']);
    assert.deepEqual(counts(db), { events: 4, messages: 2, calls: 1 });
    assert.equal(lines.filter((line) => line.msg === 'spool event ingested').length, 4);
    assert.equal(lines.filter((line) => line.level === 'warn' && line.fields.file === 'version-2.evt').length, 1);
  });

  test('a file written the way aster-emit writes it (.tmp, then rename) is ingested after the watch event, before any rescan', async () => {
    const { db, events } = setup();
    const spool = start(db, events, { rescanMs: 3_600_000, debounceMs: 20 });
    try {
      await spool.scan();
      const event = variant('valid/sms-alphanumeric-sender.evt');
      writeFileSync(join(events, `${event.id}.tmp`), event.bytes);
      renameSync(join(events, `${event.id}.tmp`), join(events, `${event.id}.evt`));
      await until(() => counts(db).messages === 1);
      await until(() => filesIn(events).length === 0);
    } finally {
      await spool.stop();
    }
  });

  test('without the watch, the periodic rescan picks a new file up', async () => {
    const { db, events } = setup();
    const spool = start(db, events, { watch: false, rescanMs: 50 });
    try {
      await spool.scan();
      put(events, 'valid/call-end-answered.evt');
      await until(() => counts(db).calls === 1);
    } finally {
      await spool.stop();
    }
  });

  test('a database error ends the scan and is logged once; the files stay and a later scan ingests them all', async () => {
    const { db, events, quarantine, dbPath } = setup();
    for (const path of ['valid/sms-report-expired.evt', 'valid/call-end-answered.evt', 'valid/sms-alphanumeric-sender.evt']) put(events, path);
    const { log, lines } = capture();
    const release = lock(db, dbPath);
    const spool = start(db, events, { watch: false, rescanMs: 3_600_000, log });
    try {
      const failed = await spool.scan();
      assert.deepEqual(failed, { ingested: 0, replayed: 0, quarantined: 0, failed: 2, skipped: 4 });
      await spool.scan();
      assert.equal(lines.filter((line) => line.level === 'error').length, 1);
      assert.equal(filesIn(events).length, 3);
      release();
      const recovered = await spool.scan();
      assert.deepEqual(recovered, { ingested: 3, replayed: 0, quarantined: 0, failed: 0, skipped: 0 });
    } finally {
      await spool.stop();
    }
    assert.deepEqual(filesIn(events), []);
    assert.deepEqual(filesIn(quarantine), []);
  });

  test('a file that fails for another reason stays in place, is retried by every scan, logged once, and ingested once it works', async () => {
    const { db, events, quarantine } = setup();
    put(events, 'valid/call-end-answered.evt');
    put(events, 'valid/sms-alphanumeric-sender.evt');
    let broken = true;
    const { log, lines } = capture();
    /** @type {Hooks} */
    const hooks = { onEvent: ({ event }) => { if (broken && event.kind === 'call-end') throw new Error('call notification failed'); } };
    const spool = start(db, events, { watch: false, rescanMs: 3_600_000, log, hooks });
    try {
      for (let i = 0; i < 5; i += 1) await spool.scan();
      assert.deepEqual(filesIn(events), ['1789053129166434786-262345-1789000003.14.evt']);
      assert.deepEqual(filesIn(quarantine), []);
      assert.deepEqual(counts(db), { events: 1, messages: 1, calls: 0 });
      assert.equal(lines.filter((line) => line.level === 'error').length, 1);
      broken = false;
      const result = await spool.scan();
      assert.equal(result.ingested, 1);
    } finally {
      await spool.stop();
    }
    assert.deepEqual(counts(db), { events: 2, messages: 1, calls: 1 });
    assert.deepEqual(filesIn(events), []);
  });

  test('stop() ends the watch and the rescan; a later scan() does nothing', async () => {
    const { db, events } = setup();
    const spool = start(db, events, { rescanMs: 20, debounceMs: 5 });
    await spool.scan();
    await spool.stop();
    put(events, 'valid/call-end-answered.evt');
    assert.deepEqual(await spool.scan(), { ingested: 0, replayed: 0, quarantined: 0, failed: 0, skipped: 0 });
    await sleep(150);
    assert.equal(filesIn(events).length, 1);
    assert.deepEqual(counts(db), { events: 0, messages: 0, calls: 0 });
  });

  test('a missing spool directory is created', async () => {
    const { db, home } = setup();
    const dir = join(home, 'other', 'events');
    const spool = start(db, dir, { watch: false, rescanMs: 3_600_000 });
    await spool.stop();
    assert.deepEqual(filesIn(dir), []);
    assert.ok(readdirSync(join(home, 'other')).includes('events'));
  });
});
