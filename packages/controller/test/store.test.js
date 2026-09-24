// @ts-check
// Tests for src/store/db.js and its migrations: connection settings, every table with its columns,
// constraints and indexes, and migrations that are idempotent, ordered, transactional and refuse a newer database.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { listMigrations, listTables, migrate, MIGRATIONS_DIR, open, schemaVersion } from '../src/store/db.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('node:sqlite').SQLInputValue} SQLInputValue */

/** Columns, in order. */
const COLUMNS = {
  calls: ['id', 'event_id', 'modem_id', 'uniqueid', 'caller', 'did', 'dialstatus', 'answered_sec', 'dialed_sec', 'disposition',
    'hangupcause', 'outcome', 'ended_at', 'direction'],
  devices_seen: ['usb_port', 'vendor', 'product', 'imei', 'imsi', 'data_tty', 'first_seen', 'last_seen', 'present'],
  events: ['id', 'kind', 'modem_id', 'uniqueid', 'emitted_at', 'received_at', 'fields_json'],
  messages: ['id', 'event_id', 'modem_id', 'sender', 'text', 'scts', 'received_at'],
  modem_forwarding: ['modem_id', 'forwarding_json', 'observed_at'],
  notifications: ['id', 'source_kind', 'source_id', 'chat_id', 'part_no', 'part_count', 'text', 'status', 'attempts', 'next_at',
    'tg_message_id', 'error', 'created_at', 'sent_at'],
  operations: ['id', 'kind', 'modem_id', 'status', 'params_json', 'result_json', 'error', 'actor', 'created_at', 'started_at',
    'finished_at'],
  sessions: ['id', 'created_at', 'last_seen_at'],
  settings: ['key', 'value'],
  sms_attempts: ['outbox_id', 'attempt_no', 'submitted_at', 'ami_result', 'report0_at', 'report0_success', 'report1_at',
    'report1_success', 'report2_at', 'report_raw', 'status'],
  sms_outbox: ['id', 'modem_id', 'number', 'text', 'status', 'attempt_no', 'created_at', 'updated_at', 'last_error'],
};
const TABLES = Object.keys(COLUMNS).sort();

const tmp = mkdtempSync(join(tmpdir(), 'aster-store-'));
/** @type {DatabaseSync[]} */
const opened = [];
after(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // closed by the test itself
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

let counter = 0;
/** @param {string} [name] */
function fresh(name = `db-${++counter}`) {
  const db = open(join(tmp, `${name}.db`));
  opened.push(db);
  return db;
}

/**
 * @param {DatabaseSync} db
 * @param {string} sql
 * @param {...SQLInputValue} params
 */
const all = (db, sql, ...params) => db.prepare(sql).all(...params);
/**
 * @param {DatabaseSync} db
 * @param {string} sql
 * @param {...SQLInputValue} params
 */
const run = (db, sql, ...params) => db.prepare(sql).run(...params);

/**
 * A migrations directory holding the shipped 001.sql plus the given files.
 * @param {string} name
 * @param {Record<string, string>} files
 */
function migrationsDir(name, files) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  copyFileSync(join(MIGRATIONS_DIR, '001.sql'), join(dir, '001.sql'));
  for (const [file, sql] of Object.entries(files)) writeFileSync(join(dir, file), sql);
  return dir;
}

test('open() configures WAL, synchronous=NORMAL, busy_timeout=5000, foreign keys and the RAM settings', () => {
  const db = fresh();
  assert.deepEqual({ ...db.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'wal' });
  // NORMAL (1), not FULL (2): one fsync per checkpoint instead of one per commit, to save SD card writes.
  assert.deepEqual({ ...db.prepare('PRAGMA synchronous').get() }, { synchronous: 1 });
  assert.deepEqual({ ...db.prepare('PRAGMA busy_timeout').get() }, { timeout: 5000 });
  assert.deepEqual({ ...db.prepare('PRAGMA foreign_keys').get() }, { foreign_keys: 1 });
  assert.deepEqual({ ...db.prepare('PRAGMA temp_store').get() }, { temp_store: 2 });
  // A negative cache_size is KiB rather than pages: 32 MiB of page cache, RAM spent to keep reads off the card.
  assert.deepEqual({ ...db.prepare('PRAGMA cache_size').get() }, { cache_size: -32000 });
  // No journal_size_limit: the WAL is reused in place instead of being truncated (a write) after every checkpoint.
  assert.deepEqual({ ...db.prepare('PRAGMA journal_size_limit').get() }, { journal_size_limit: -1 });
});

test('open() names the database path when the file cannot be opened', () => {
  assert.throws(() => open(join(tmp, 'missing-dir', 'aster.db')), {
    message: `cannot open database ${join(tmp, 'missing-dir', 'aster.db')}: unable to open database file`,
  });
});

test('migrate() on a new database creates every table with its columns as STRICT tables and sets the schema version', () => {
  const db = fresh();
  assert.deepEqual(migrate(db), { from: 0, to: 3, applied: [1, 2, 3] });
  assert.deepEqual(listTables(db), TABLES);
  for (const [table, columns] of Object.entries(COLUMNS)) {
    assert.deepEqual(all(db, 'SELECT name FROM pragma_table_info(?) ORDER BY cid', table).map((row) => row.name), columns, table);
  }
  const strict = all(db, "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND strict = 1 ORDER BY name");
  assert.deepEqual(strict.map((row) => row.name).filter((name) => !String(name).startsWith('sqlite_')), TABLES);
  assert.equal(schemaVersion(db), 3);
  assert.deepEqual({ ...db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() }, { value: '3' });
});

test('migrate() twice is idempotent, on the same connection and on a new one', () => {
  const path = join(tmp, 'twice.db');
  /** @param {DatabaseSync} db */
  const schema = (db) => all(db, 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name');
  const first = open(path);
  opened.push(first);
  migrate(first);
  const before = schema(first);
  assert.deepEqual(migrate(first), { from: 3, to: 3, applied: [] });
  first.close();
  const second = open(path);
  opened.push(second);
  assert.deepEqual(migrate(second), { from: 3, to: 3, applied: [] });
  assert.deepEqual(schema(second), before);
  assert.deepEqual(listTables(second), TABLES);
});

test('UNIQUE, FOREIGN KEY, NOT NULL, CHECK and STRICT constraints hold', () => {
  const db = fresh();
  migrate(db);
  const now = Date.now();
  const event = 'INSERT INTO events (id, kind, modem_id, uniqueid, emitted_at, received_at, fields_json) VALUES (?, ?, ?, ?, ?, ?, ?)';
  run(db, event, 'e1', 'sms', 'gsm1', null, now, now, '{"sender":"+100"}');
  run(db, event, 'e2', 'call-end', 'gsm1', '1757.1', now, now, '{}');
  run(db, event, 'e3', 'call-end', 'gsm2', '1757.2', now, now, '{}');
  run(db, 'INSERT INTO messages (event_id, modem_id, sender, text, received_at) VALUES (?, ?, ?, ?, ?)', 'e1', 'gsm1', '+100', 'hi', now);
  run(db, 'INSERT INTO calls (event_id, modem_id, uniqueid, ended_at) VALUES (?, ?, ?, ?)', 'e2', 'gsm1', '1757.1', now);
  run(db, 'INSERT INTO sms_outbox (modem_id, number, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'gsm1', '+200', 'out', 'queued', now, now);
  const attempt = 'INSERT INTO sms_attempts (outbox_id, attempt_no, status, report0_success) VALUES (?, ?, ?, ?)';
  run(db, attempt, 1, 1, 'submitted', 1);
  const notification = `INSERT INTO notifications (source_kind, source_id, chat_id, part_no, part_count, text, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  run(db, notification, 'sms', 1, '111222333', 1, 2, 'part 1', 'pending', now);

  /** @type {Array<[string, SQLInputValue[], RegExp]>} */
  const violations = [
    [event, ['e1', 'sms', 'gsm1', null, now, now, '{}'], /^UNIQUE constraint failed: events\.id$/],
    [event, ['e4', 'sms', 'gsm1', null, now, now, 'not json'], /^CHECK constraint failed: json_valid\(fields_json\)$/],
    [event, ['e5', 'sms', 'gsm1', null, now + 0.5, now, '{}'], /^cannot store REAL value in INTEGER column events\.emitted_at$/],
    ['INSERT INTO messages (event_id, modem_id, text, received_at) VALUES (?, ?, ?, ?)', ['e1', 'gsm1', 'again', now],
      /^UNIQUE constraint failed: messages\.event_id$/],
    ['INSERT INTO messages (event_id, modem_id, text, received_at) VALUES (?, ?, ?, ?)', ['missing', 'gsm1', 'x', now],
      /^FOREIGN KEY constraint failed$/],
    ['INSERT INTO messages (event_id, modem_id, text, received_at) VALUES (?, ?, ?, ?)', ['e3', 'gsm2', null, now],
      /^NOT NULL constraint failed: messages\.text$/],
    ['INSERT INTO calls (event_id, modem_id, uniqueid, ended_at) VALUES (?, ?, ?, ?)', ['e3', 'gsm2', '1757.1', now],
      /^UNIQUE constraint failed: calls\.uniqueid$/],
    ['INSERT INTO calls (event_id, modem_id, uniqueid, ended_at) VALUES (?, ?, ?, ?)', ['e2', 'gsm1', '1757.9', now],
      /^UNIQUE constraint failed: calls\.event_id$/],
    [attempt, [1, 1, 'submitted', null], /^UNIQUE constraint failed: sms_attempts\.outbox_id, sms_attempts\.attempt_no$/],
    [attempt, [99, 1, 'submitted', null], /^FOREIGN KEY constraint failed$/],
    [attempt, [1, 0, 'submitted', null], /^CHECK constraint failed: attempt_no >= 1$/],
    [attempt, [1, 2, 'submitted', 2], /^CHECK constraint failed: report0_success IN \(0, 1\)$/],
    [notification, ['email', null, '1', 1, 1, 'x', 'pending', now], /^CHECK constraint failed: source_kind IN /],
    [notification, ['test', null, '1', 2, 1, 'x', 'pending', now], /^CHECK constraint failed: part_count >= part_no$/],
    ['INSERT INTO operations (kind, status, params_json, actor, created_at) VALUES (?, ?, ?, ?, ?)', ['scan', 'queued', '{', 'admin', now],
      /^CHECK constraint failed: params_json IS NULL OR json_valid\(params_json\)$/],
    ["INSERT INTO settings (key, value) VALUES ('schema_version', '9')", [], /^UNIQUE constraint failed: settings\.key$/],
    ['INSERT INTO devices_seen (usb_port, first_seen, last_seen, present) VALUES (?, ?, ?, ?)', ['1-1.3', now, now, 2],
      /^CHECK constraint failed: present IN \(0, 1\)$/],
    ['INSERT INTO modem_forwarding (modem_id, forwarding_json, observed_at) VALUES (?, ?, ?)', ['gsm1', '[1,', now],
      /^CHECK constraint failed: json_valid\(forwarding_json\)$/],
  ];
  for (const [sql, params, expected] of violations) {
    assert.throws(() => run(db, sql, ...params), { message: expected }, `${sql} ${JSON.stringify(params)}`);
  }

  // Deleting an outbox row removes its attempts; a deleted id is never reused (it travels inside SMS report payloads).
  run(db, 'DELETE FROM sms_outbox WHERE id = 1');
  assert.deepEqual(all(db, 'SELECT * FROM sms_attempts'), []);
  const outbox = run(db, 'INSERT INTO sms_outbox (modem_id, number, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'gsm1', '+200', 'again', 'queued', now, now);
  assert.equal(outbox.lastInsertRowid, 2);
});

test('indexes on messages (modem_id, received_at), notifications (status, next_at) and (created_at)', () => {
  const db = fresh();
  migrate(db);
  /** @param {string} table */
  const indexes = (table) =>
    all(db, "SELECT name FROM pragma_index_list(?) WHERE origin = 'c' ORDER BY name", table).map((index) => {
      const columns = all(db, 'SELECT name FROM pragma_index_info(?) ORDER BY seqno', String(index.name)).map((c) => c.name);
      return `${String(index.name)}(${columns.join(', ')})`;
    });
  assert.deepEqual(indexes('messages'), ['messages_modem_received(modem_id, received_at)']);
  assert.deepEqual(indexes('notifications'), ['notifications_created(created_at)', 'notifications_status_next(status, next_at)']);
  assert.deepEqual(indexes('operations'), ['operations_created(created_at)']);
  const plan = all(db, 'EXPLAIN QUERY PLAN SELECT id FROM notifications WHERE status = ? AND next_at <= ?', 'retry', Date.now());
  assert.match(plan.map((step) => String(step.detail)).join('\n'), /USING (COVERING )?INDEX notifications_status_next/);
});

test('later migrations are applied once each, in order, with their schema_version', () => {
  const dir = migrationsDir('ordered', {
    '002.sql': 'CREATE TABLE extra (x INTEGER) STRICT;\n',
    '003.sql': "ALTER TABLE extra ADD COLUMN y TEXT;\nINSERT INTO extra (x, y) VALUES (3, 'three');\n",
  });
  const db = fresh();
  assert.deepEqual(migrate(db, { dir }), { from: 0, to: 3, applied: [1, 2, 3] });
  assert.deepEqual(migrate(db, { dir }), { from: 3, to: 3, applied: [] });
  assert.deepEqual(all(db, 'SELECT x, y FROM extra').map((row) => ({ ...row })), [{ x: 3, y: 'three' }]);
  assert.deepEqual(listMigrations(dir).map((m) => m.version), [1, 2, 3]);
});

test('a failing migration is rolled back completely; the steps before it stay committed', () => {
  const dir = migrationsDir('broken', { '002.sql': 'CREATE TABLE extra (x INTEGER) STRICT;\nINSERT INTO no_such_table VALUES (1);\n' });
  const db = fresh();
  // migrationsDir() copies 001.sql only, so this fixture's 002 replaces the real one: what stays committed is the
  // schema of 001, which still has modem_state and not yet the modem_forwarding that the real 002 swaps it for.
  const after001 = [...TABLES.filter((name) => name !== 'modem_forwarding'), 'modem_state'].sort();
  assert.throws(() => migrate(db, { dir }), { message: `migration ${join(dir, '002.sql')} failed: no such table: no_such_table` });
  assert.equal(schemaVersion(db), 1);
  assert.deepEqual(listTables(db), after001);
  writeFileSync(join(dir, '002.sql'), 'CREATE TABLE extra (x INTEGER) STRICT;\n');
  assert.deepEqual(migrate(db, { dir }), { from: 1, to: 2, applied: [2] });
});

test('002 moves a stored forwarding verdict into modem_forwarding and drops modem_state', () => {
  const db = fresh();
  // the schema before 002: migrationsDir() copies 001.sql only
  assert.deepEqual(migrate(db, { dir: migrationsDir('v1', {}) }), { from: 0, to: 1, applied: [1] });
  const verdict = { verified: true, outcome: 'ok', enabled: true, number: '+1234567890', type: 145, class: 1, entries: [], observed_at: 1_700_000_000_000 };
  run(db, "INSERT INTO modem_state (modem_id, state, observed_at, detail_json) VALUES ('gsm1', 'ready', 1700000000000, ?)",
    JSON.stringify({ listed: true, forwarding: verdict }));
  run(db, "INSERT INTO modem_state (modem_id, state, observed_at, detail_json) VALUES ('gsm2', 'ready', 1700000000001, ?)",
    JSON.stringify({ listed: true, forwarding: null }));
  run(db, "INSERT INTO modem_state (modem_id, state, observed_at) VALUES ('gsm3', 'ready', 1700000000002)");

  assert.deepEqual(migrate(db), { from: 1, to: 3, applied: [2, 3] });
  assert.deepEqual(listTables(db), TABLES, 'modem_state is gone, modem_forwarding is there');
  const rows = all(db, 'SELECT modem_id, forwarding_json, observed_at FROM modem_forwarding ORDER BY modem_id');
  assert.equal(rows.length, 1, 'only the modem that had a verdict; a null one and a missing detail carry nothing');
  assert.equal(rows[0]?.modem_id, 'gsm1');
  assert.equal(rows[0]?.observed_at, 1_700_000_000_000);
  assert.deepEqual(JSON.parse(String(rows[0]?.forwarding_json)), verdict);
});

test('003 marks every call recorded before it as incoming and allows only in and out', () => {
  const db = fresh();
  const before = migrationsDir('v2', { '002.sql': readFileSync(join(MIGRATIONS_DIR, '002.sql'), 'utf8') });
  assert.deepEqual(migrate(db, { dir: before }), { from: 0, to: 2, applied: [1, 2] });
  run(db, "INSERT INTO events (id, kind, modem_id, emitted_at, received_at, fields_json) VALUES ('e1', 'call-end', 'gsm1', 1, 1, '{}')");
  run(db, "INSERT INTO calls (event_id, modem_id, uniqueid, ended_at) VALUES ('e1', 'gsm1', '1757.1', 1)");
  assert.deepEqual(migrate(db), { from: 2, to: 3, applied: [3] });
  assert.deepEqual(all(db, 'SELECT uniqueid, direction FROM calls').map((row) => ({ ...row })), [{ uniqueid: '1757.1', direction: 'in' }]);
  run(db, "INSERT INTO events (id, kind, modem_id, emitted_at, received_at, fields_json) VALUES ('e2', 'call-end', 'gsm1', 2, 2, '{}')");
  assert.throws(() => run(db, "INSERT INTO calls (event_id, modem_id, uniqueid, ended_at, direction) VALUES ('e2', 'gsm1', '1757.2', 2, 'both')"),
    { message: /^CHECK constraint failed: direction IN \('in', 'out'\)$/ });
});

test('a database newer than this build, or with a garbled schema_version, is refused', () => {
  const db = fresh();
  migrate(db);
  run(db, "UPDATE settings SET value = '7' WHERE key = 'schema_version'");
  assert.throws(() => migrate(db), {
    message: 'database schema_version 7 is newer than this controller (latest migration 3); refusing to use it',
  });
  run(db, "UPDATE settings SET value = '01' WHERE key = 'schema_version'");
  assert.throws(() => migrate(db), { message: 'settings.schema_version is not a version number: 01' });
});

test('migration files must be named NNN.sql and numbered from 001 without gaps', () => {
  assert.deepEqual(listMigrations().map((m) => m.version), [1, 2, 3]);
  const gap = migrationsDir('gap', { '003.sql': '' });
  assert.throws(() => listMigrations(gap), { message: `migrations in ${gap} must be numbered 001..002 without gaps; found ${join(gap, '003.sql')}` });
  const badName = migrationsDir('bad-name', { '2.sql': '' });
  assert.throws(() => listMigrations(badName), { message: `unexpected file in migrations directory ${badName}: 2.sql (expected NNN.sql)` });
});
