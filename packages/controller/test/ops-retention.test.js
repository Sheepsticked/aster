// @ts-check
// Tests for src/ops/retention.js: only finished rows past their retention days are deleted, SMS and calls with their spool
// events, and startRetention's schedule.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DAY_MS, purge, startRetention } from '../src/ops/retention.js';
import { REMOVABLE } from '../src/sms/outbox.js';
import { migrate, open } from '../src/store/db.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../src/log.js').Logger} Logger */

const NOW = 1789100000000;
const tmp = mkdtempSync(join(tmpdir(), 'aster-retention-'));
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

function setup() {
  const db = open(join(tmp, `db-${opened.length + 1}.db`));
  opened.push(db);
  migrate(db);
  return db;
}

/**
 * @param {DatabaseSync} db
 * @param {string} status
 * @param {number} createdAt
 */
function addOperation(db, status, createdAt) {
  const result = status === 'queued' || status === 'running' ? null : '{"observed_at":1}';
  db.prepare("INSERT INTO operations (kind, status, result_json, actor, created_at) VALUES ('scan', ?, ?, 'system', ?)").run(status, result, createdAt);
}

/**
 * @param {DatabaseSync} db
 * @param {string} status
 * @param {number} createdAt
 */
function addNotification(db, status, createdAt) {
  db.prepare(`INSERT INTO notifications (source_kind, chat_id, part_no, part_count, text, status, created_at)
    VALUES ('test', '111222333', 1, 1, 'x', ?, ?)`).run(status, createdAt);
}

/** Spans long enough that nothing of that kind is deleted. */
const KEEP = { operations: 36500, notifications: 36500, messages: 36500, calls: 36500 };

/**
 * @param {DatabaseSync} db
 * @param {string} table
 * @returns {string[]}  `<status> <age>` with the age in days before NOW (fractions for rows past a cutoff)
 */
const remaining = (db, table) => db.prepare(`SELECT status, created_at FROM ${table} ORDER BY id`).all()
  .map((row) => `${String(row.status)} ${(NOW - Number(row.created_at)) / DAY_MS}`);

/** A logger that keeps its lines. */
function recorder() {
  /** @type {Array<[string, string, Record<string, unknown>]>} */
  const lines = [];
  /** @type {Logger} */
  const log = {
    debug: (msg, fields = {}) => void lines.push(['debug', msg, fields]),
    info: (msg, fields = {}) => void lines.push(['info', msg, fields]),
    warn: (msg, fields = {}) => void lines.push(['warn', msg, fields]),
    error: (msg, fields = {}) => void lines.push(['error', msg, fields]),
    child: () => log,
  };
  return { log, lines };
}

describe('ops retention', () => {
  test('purge deletes finished operations and notifications older than their retention days and keeps everything else', () => {
    const db = setup();
    const OP_AGES = [10 * DAY_MS, 10 * DAY_MS + 1, DAY_MS];
    const NOTE_AGES = [5 * DAY_MS, 5 * DAY_MS + 1, DAY_MS];
    for (const status of ['queued', 'running', 'interrupted', 'done', 'failed', 'uncertain']) {
      for (const age of OP_AGES) addOperation(db, status, NOW - age);
    }
    for (const status of ['pending', 'sending', 'retry', 'sent', 'failed']) {
      for (const age of NOTE_AGES) addNotification(db, status, NOW - age);
    }
    db.exec(`INSERT INTO events (id, kind, modem_id, emitted_at, received_at, fields_json) VALUES ('e1', 'sms', 'gsm1', 0, 0, '{}'), ('e2', 'call-end', 'gsm1', 0, 0, '{}');
      INSERT INTO messages (event_id, modem_id, text, received_at) VALUES ('e1', 'gsm1', 'old', 0);
      INSERT INTO calls (event_id, modem_id, uniqueid, ended_at) VALUES ('e2', 'gsm1', '1.1', 0);
      INSERT INTO sms_outbox (modem_id, number, text, status, created_at, updated_at) VALUES ('gsm1', '+100', 'old', 'delivered', 0, 0);`);

    const days = { ...KEEP, operations: 10, notifications: 5 };
    assert.deepEqual(purge(db, { days, now: NOW }), { operations: 3, notifications: 2, messages: 0, calls: 0 });
    const past = 10 + 1 / DAY_MS;
    assert.deepEqual(remaining(db, 'operations'), [
      'queued 10', `queued ${past}`, 'queued 1', 'running 10', `running ${past}`, 'running 1', 'interrupted 10', `interrupted ${past}`,
      'interrupted 1', 'done 10', 'done 1', 'failed 10', 'failed 1', 'uncertain 10', 'uncertain 1',
    ]);
    const notePast = 5 + 1 / DAY_MS;
    assert.deepEqual(remaining(db, 'notifications'), [
      'pending 5', `pending ${notePast}`, 'pending 1', 'sending 5', `sending ${notePast}`, 'sending 1', 'retry 5', `retry ${notePast}`, 'retry 1',
      'sent 5', 'sent 1', 'failed 5', 'failed 1',
    ]);
    for (const table of ['events', 'messages', 'calls', 'sms_outbox']) {
      assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n), table === 'events' ? 2 : 1, table);
    }
    assert.deepEqual(purge(db, { days, now: NOW }), { operations: 0, notifications: 0, messages: 0, calls: 0 });
  });

  test('purge deletes SMS, delivery reports and calls older than their retention days with their spool events; SMS still being sent are kept', () => {
    const db = setup();
    /** @param {string} id @param {string} kind @param {number} age @param {string | null} [uniqueid] */
    const addEvent = (id, kind, age, uniqueid = null) => db.prepare(`INSERT INTO events (id, kind, modem_id, uniqueid, emitted_at, received_at, fields_json)
      VALUES (?, ?, 'gsm1', ?, ?, ?, '{}')`).run(id, kind, uniqueid, NOW - age, NOW - age);
    /** @param {string} id @param {number} age */
    const addReceived = (id, age) => {
      addEvent(id, 'sms', age);
      db.prepare("INSERT INTO messages (event_id, modem_id, text, received_at) VALUES (?, 'gsm1', ?, ?)").run(id, id, NOW - age);
    };
    /** @param {string} id @param {number} age */
    const addCall = (id, age) => {
      addEvent(id, 'call-end', age, `u-${id}`);
      db.prepare("INSERT INTO calls (event_id, modem_id, uniqueid, ended_at) VALUES (?, 'gsm1', ?, ?)").run(id, `u-${id}`, NOW - age);
    };
    /** @param {string} status @param {number} age */
    const addSent = (status, age) => Number(db.prepare(`INSERT INTO sms_outbox (modem_id, number, text, status, attempt_no, created_at, updated_at)
      VALUES ('gsm1', '+100', ?, ?, 1, ?, ?)`).run(`${status} ${age / DAY_MS}`, status, NOW - age, NOW - age).lastInsertRowid);
    const IN_FLIGHT = ['queued', 'submitting', 'submitted', 'accepted'];

    addReceived('in-old', 10 * DAY_MS + 1);
    addReceived('in-edge', 10 * DAY_MS);
    for (const status of [...REMOVABLE, ...IN_FLIGHT]) addSent(status, 10 * DAY_MS + 1);
    const recent = addSent('delivered', DAY_MS);
    db.prepare("INSERT INTO sms_attempts (outbox_id, attempt_no, status) VALUES (1, 1, 'delivered'), (?, 1, 'delivered')").run(recent);
    addEvent('report-old', 'sms-report', 10 * DAY_MS + 1);
    addEvent('report-new', 'sms-report', DAY_MS);
    addCall('call-old', 5 * DAY_MS + 1);
    addCall('call-edge', 5 * DAY_MS);

    const days = { ...KEEP, messages: 10, calls: 5 };
    assert.deepEqual(purge(db, { days, now: NOW }), { operations: 0, notifications: 0, messages: 1 + REMOVABLE.length, calls: 1 });
    const column = (/** @type {string} */ sql) => db.prepare(sql).all().map((row) => Object.values(row).join(' '));
    assert.deepEqual(column('SELECT event_id FROM messages ORDER BY id'), ['in-edge']);
    assert.deepEqual(column('SELECT text FROM sms_outbox ORDER BY id'), [...IN_FLIGHT.map((status) => `${status} ${10 + 1 / DAY_MS}`), 'delivered 1']);
    assert.deepEqual(column('SELECT outbox_id FROM sms_attempts'), [String(recent)], 'attempts go with their SMS');
    assert.deepEqual(column('SELECT event_id FROM calls ORDER BY id'), ['call-edge']);
    assert.deepEqual(column('SELECT id FROM events ORDER BY id'), ['call-edge', 'in-edge', 'report-new']);
    assert.deepEqual(purge(db, { days, now: NOW }), { operations: 0, notifications: 0, messages: 0, calls: 0 });
  });

  test('invalid retention days throw a RangeError before anything is deleted', () => {
    const db = setup();
    addOperation(db, 'done', NOW - 400 * DAY_MS);
    addNotification(db, 'sent', NOW - 400 * DAY_MS);
    db.exec(`INSERT INTO events (id, kind, modem_id, emitted_at, received_at, fields_json) VALUES ('e1', 'sms', 'gsm1', 0, 0, '{}');
      INSERT INTO messages (event_id, modem_id, text, received_at) VALUES ('e1', 'gsm1', 'old', 0);`);
    /** @type {Array<[unknown, string]>} */
    const cases = [
      [{ ...KEEP, operations: 0 }, 'retention_days.operations must be a whole number of days from 1 to 36500, not 0'],
      [{ ...KEEP, notifications: 1.5 }, 'retention_days.notifications must be a whole number of days from 1 to 36500, not 1.5'],
      [{ ...KEEP, operations: '90' }, 'retention_days.operations must be a whole number of days from 1 to 36500, not 90'],
      [{ ...KEEP, notifications: 36501 }, 'retention_days.notifications must be a whole number of days from 1 to 36500, not 36501'],
      [{ ...KEEP, messages: 0 }, 'retention_days.messages must be a whole number of days from 1 to 36500, not 0'],
      [{ operations: 90, notifications: 90, messages: 90 }, 'retention_days.calls must be a whole number of days from 1 to 36500, not undefined'],
      [undefined, 'retention_days.operations must be a whole number of days from 1 to 36500, not undefined'],
    ];
    for (const [days, message] of cases) {
      assert.throws(() => purge(db, { days: /** @type {any} */ (days), now: NOW }), { name: 'RangeError', message });
    }
    assert.deepEqual([remaining(db, 'operations'), remaining(db, 'notifications')], [['done 400'], ['sent 400']]);
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM messages').get()?.n), 1);
    assert.equal(db.isTransaction, false);
  });

  test('startRetention purges after its delay and then at every interval with the days of that moment; a failing run is logged; stop() ends it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const db = setup();
    const { log, lines } = recorder();
    let clock = NOW;
    /** @type {import('../src/ops/retention.js').RetentionDays | null} */
    let days = { ...KEEP, operations: 10, notifications: 10 };
    addOperation(db, 'done', NOW - 11 * DAY_MS);
    addOperation(db, 'failed', NOW - 2 * DAY_MS);
    addNotification(db, 'sent', NOW - 11 * DAY_MS);
    const retention = startRetention(db, {
      days: () => {
        if (!days) throw new Error('registry unreadable');
        return days;
      },
      log,
      now: () => clock,
    });

    t.mock.timers.tick(59_999);
    assert.equal(remaining(db, 'operations').length, 2);
    t.mock.timers.tick(1);
    assert.deepEqual(remaining(db, 'operations'), ['failed 2']);
    assert.deepEqual(remaining(db, 'notifications'), []);
    assert.deepEqual(lines, [['info', 'retention deleted old rows', { operations: 1, notifications: 1, messages: 0, calls: 0 }]]);

    days = { ...KEEP, operations: 1, notifications: 10 };
    clock += DAY_MS;
    t.mock.timers.tick(DAY_MS - 1);
    assert.deepEqual(remaining(db, 'operations'), ['failed 2']);
    t.mock.timers.tick(1);
    assert.deepEqual(remaining(db, 'operations'), []);

    days = null;
    addOperation(db, 'uncertain', clock - 3 * DAY_MS);
    t.mock.timers.tick(DAY_MS);
    assert.equal(remaining(db, 'operations').length, 1);
    assert.deepEqual(lines.slice(2).map(([level, msg, fields]) => [level, msg, /** @type {Error} */ (fields.err)?.message]), [
      ['error', 'retention failed; the next run tries again', 'registry unreadable'],
    ]);

    days = { ...KEEP, operations: 1, notifications: 1 };
    t.mock.timers.tick(DAY_MS);
    assert.deepEqual(remaining(db, 'operations'), []);
    t.mock.timers.tick(DAY_MS);
    assert.deepEqual(lines.at(-1), ['debug', 'retention found nothing to delete', {}]);

    retention.stop();
    addOperation(db, 'done', clock - 30 * DAY_MS);
    t.mock.timers.tick(3 * DAY_MS);
    assert.equal(remaining(db, 'operations').length, 1);
    assert.equal(retention.run(), null);
  });
});
