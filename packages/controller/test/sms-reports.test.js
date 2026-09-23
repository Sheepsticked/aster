// @ts-check
// Tests for src/sms/reports.js: payload parsing, the report state machine on stored rows, the AMI listener (report.txt and
// emitted events) and the spool path through ingestFile.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyReport, ATTEMPT_STATUSES, attemptStatus, createReportListener, failureText, packetReport, parsePayload, PAYLOAD } from '../src/sms/reports.js';
import { ingestFile } from '../src/spool/ingest.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi, packetsOf } from './devices-fake.js';

/** @typedef {import('../src/sms/reports.js').Report} Report */
/** @typedef {import('../src/sms/reports.js').Attempt} Attempt */

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const T0 = Date.UTC(2026, 8, 11, 12, 0, 0);
const tmp = mkdtempSync(join(tmpdir(), 'aster-sms-reports-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

/** A migrated database with outbox rows and attempts as given: [id, attemptNo, outboxStatus, attemptStatuses[]]. */
function setup(/** @type {Array<[number, number, string, string[]]>} */ rows = [[5, 1, 'submitted', ['submitted']]]) {
  const db = open(join(tmp, `reports-${++counter}.db`));
  migrate(db);
  for (const [id, attemptNo, status, attempts] of rows) {
    db.prepare("INSERT INTO sms_outbox (id, modem_id, number, text, status, attempt_no, created_at, updated_at) VALUES (?, 'gsm1', '+1234567890', 'hi', ?, ?, 1, 1)").run(id, status, attemptNo);
    attempts.forEach((attemptStatus, index) => {
      db.prepare('INSERT INTO sms_attempts (outbox_id, attempt_no, submitted_at, status) VALUES (?, ?, ?, ?)').run(id, index + 1, T0 - 1000, attemptStatus);
    });
  }
  /** @param {number} id */
  const outbox = (id) => /** @type {{ status: string, last_error: string | null, attempt_no: number, updated_at: number }} */ ({ ...db.prepare('SELECT status, last_error, attempt_no, updated_at FROM sms_outbox WHERE id = ?').get(id) });
  /** @param {number} id @param {number} attemptNo */
  const attempt = (id, attemptNo) => /** @type {Attempt} */ ({ ...db.prepare('SELECT * FROM sms_attempts WHERE outbox_id = ? AND attempt_no = ?').get(id, attemptNo) });
  return { db, outbox, attempt };
}

/**
 * @param {Partial<Report>} fields
 * @returns {Report}
 */
const report = (fields) => ({ payload: '5:1', type: 0, success: 1, scts: null, dt: null, raw: null, source: 'ami', modemId: 'gsm1', at: T0, ...fields });

describe('sms reports', () => {
  test('parsePayload, attemptStatus and failureText', () => {
    assert.deepEqual(parsePayload('7:2'), { outboxId: 7, attemptNo: 2 });
    for (const payload of ['', '7', '7:', ':2', '0:2', '7:0', '07:2', 'abc', '7:2:1', 'out-1', '1234567890123456:1']) assert.equal(parsePayload(payload), null, payload);
    assert.equal(PAYLOAD.test('123456789012345:123456789012345'), true, 'fifteen digits each');
    const base = { report0_at: null, report0_success: null, report1_at: null, report1_success: null, report2_at: null, status: /** @type {const} */ ('submitted') };
    assert.equal(attemptStatus(base), 'submitted');
    assert.equal(attemptStatus({ ...base, status: 'uncertain' }), 'uncertain');
    assert.equal(attemptStatus({ ...base, report0_at: 1, report0_success: 1 }), 'accepted');
    assert.equal(attemptStatus({ ...base, report0_at: 1, report0_success: 0 }), 'rejected');
    assert.equal(attemptStatus({ ...base, report0_at: 1, report0_success: 1, report1_at: 2, report1_success: 1 }), 'delivered');
    assert.equal(attemptStatus({ ...base, report1_at: 2, report1_success: 0 }), 'undelivered');
    assert.equal(attemptStatus({ ...base, report0_at: 1, report0_success: 0, report2_at: 3 }), 'undelivered_expired', 'an expiry beats the submit result');
    assert.equal(attemptStatus({ ...base, report1_at: 2, report1_success: 1, report2_at: 3 }), 'delivered', 'a status report beats an expiry');
    assert.equal(failureText('rejected', null), 'the modem or the network rejected the submission (send error)');
    assert.equal(failureText('undelivered', '064,'), 'not delivered (status report 064,)');
    assert.equal(failureText('undelivered_expired', null), 'no delivery report within the validity period');
    for (const status of ['submitted', 'accepted', 'delivered', 'uncertain', 'failed']) assert.equal(failureText(/** @type {any} */ (status), null), null, status);
    assert.deepEqual(ATTEMPT_STATUSES, ['submitting', 'submitted', 'accepted', 'rejected', 'delivered', 'undelivered', 'undelivered_expired', 'failed', 'uncertain']);
  });

  test('type 0 → accepted, type 1 → delivered with the raw part statuses; a later expiry sets its column but changes no status', () => {
    const { db, outbox, attempt } = setup();
    let applied = applyReport(db, report({ type: 0, success: 1 }), { now: () => T0 + 1 });
    assert.deepEqual(applied, { outcome: 'applied', outboxId: 5, attemptNo: 1, type: 0, attempt: 'accepted', outbox: 'accepted', current: true });
    assert.deepEqual(outbox(5), { status: 'accepted', last_error: null, attempt_no: 1, updated_at: T0 + 1 });
    applied = applyReport(db, report({ type: 1, success: 1, scts: '2026-09-11 12:00:05 +03:00', dt: '2026-09-11 12:00:07 +03:00', raw: '000,', at: T0 + 5000 }), { now: () => T0 + 2 });
    assert.equal(applied.attempt, 'delivered');
    const row = attempt(5, 1);
    assert.deepEqual([row.report0_at, row.report0_success, row.report1_at, row.report1_success, row.report2_at, row.report_raw, row.status], [T0, 1, T0 + 5000, 1, null, '000,', 'delivered']);
    assert.deepEqual(outbox(5), { status: 'delivered', last_error: null, attempt_no: 1, updated_at: T0 + 2 });
    applied = applyReport(db, report({ type: 2, success: 0, at: T0 + 9000 }), { now: () => T0 + 3 });
    assert.deepEqual([applied.outcome, applied.attempt, applied.outbox], ['applied', 'delivered', 'delivered']);
    assert.equal(attempt(5, 1).report2_at, T0 + 9000);
    assert.equal(outbox(5).updated_at, T0 + 2, 'the outbox row was not touched');
  });

  test('type 0 with Success 0 → rejected, type 1 with Success 0 → undelivered, type 2 → undelivered_expired, each with its last_error', () => {
    const { db, outbox, attempt } = setup([[1, 1, 'submitted', ['submitted']], [2, 1, 'submitted', ['submitted']], [3, 1, 'submitted', ['submitted']]]);
    assert.equal(applyReport(db, report({ payload: '1:1', type: 0, success: 0 })).attempt, 'rejected');
    assert.deepEqual([outbox(1).status, outbox(1).last_error], ['rejected', 'the modem or the network rejected the submission (send error)']);
    assert.equal(applyReport(db, report({ payload: '2:1', type: 1, success: 0, raw: '064,' })).attempt, 'undelivered');
    assert.deepEqual([outbox(2).status, outbox(2).last_error, attempt(2, 1).report_raw], ['undelivered', 'not delivered (status report 064,)', '064,']);
    assert.equal(applyReport(db, report({ payload: '3:1', type: 2, success: 0 })).attempt, 'undelivered_expired');
    assert.deepEqual([outbox(3).status, outbox(3).last_error], ['undelivered_expired', 'no delivery report within the validity period']);
  });

  test('out of order: a status report before the submit result → delivered, and the submit result afterwards changes no status', () => {
    const { db, outbox, attempt } = setup();
    assert.equal(applyReport(db, report({ type: 1, success: 1, raw: '000,' })).attempt, 'delivered');
    const applied = applyReport(db, report({ type: 0, success: 1, at: T0 + 1 }));
    assert.deepEqual([applied.outcome, applied.attempt, applied.outbox], ['applied', 'delivered', 'delivered']);
    assert.deepEqual([attempt(5, 1).report0_at, attempt(5, 1).report0_success, outbox(5).status], [T0 + 1, 1, 'delivered']);
  });

  test('the same report twice (the AMI event, then the spooled copy) is a duplicate: the first values stay', () => {
    const { db, attempt, outbox } = setup();
    assert.equal(applyReport(db, report({ type: 1, success: 1, raw: '000,', source: 'ami', at: T0 })).outcome, 'applied');
    const again = applyReport(db, report({ type: 1, success: 0, raw: '064,', source: 'spool', at: T0 + 1 }), { now: () => T0 + 50 });
    assert.deepEqual(again, { outcome: 'duplicate', outboxId: 5, attemptNo: 1, type: 1, attempt: 'delivered', outbox: 'delivered', current: true });
    assert.deepEqual([attempt(5, 1).report1_at, attempt(5, 1).report1_success, attempt(5, 1).report_raw, outbox(5).status], [T0, 1, '000,', 'delivered']);
  });

  test('a late report for an earlier attempt is stored on that attempt and never changes the outbox row', () => {
    const { db, attempt, outbox } = setup([[5, 2, 'submitted', ['rejected', 'submitted']]]);
    const applied = applyReport(db, report({ payload: '5:1', type: 1, success: 1, raw: '000,' }), { now: () => T0 + 1 });
    assert.deepEqual(applied, { outcome: 'applied', outboxId: 5, attemptNo: 1, type: 1, attempt: 'delivered', outbox: 'submitted', current: false });
    assert.equal(attempt(5, 1).status, 'delivered');
    assert.deepEqual(outbox(5), { status: 'submitted', last_error: null, attempt_no: 2, updated_at: 1 });
    // the current attempt's report moves the row
    assert.equal(applyReport(db, report({ payload: '5:2', type: 2, success: 0 })).outbox, 'undelivered_expired');
    assert.equal(outbox(5).status, 'undelivered_expired');
  });

  test('a report resolves an uncertain attempt, and one for a queued retry moves the row (its send is then refused by the outbox)', () => {
    const { db, outbox } = setup([[5, 1, 'uncertain', ['uncertain']], [6, 1, 'queued', ['undelivered_expired']]]);
    assert.equal(applyReport(db, report({ payload: '5:1', type: 1, success: 1, raw: '000,' })).attempt, 'delivered');
    assert.equal(outbox(5).status, 'delivered');
    assert.equal(applyReport(db, report({ payload: '6:1', type: 1, success: 1, raw: '000,' })).outbox, 'delivered');
    assert.equal(outbox(6).status, 'delivered');
  });

  test('foreign and unknown payloads store nothing; a report type outside 0–2 is refused; the caller\'s transaction can roll a report back', () => {
    const { db, attempt, outbox } = setup();
    assert.deepEqual(applyReport(db, report({ payload: 'out-1' })), { outcome: 'foreign', outboxId: null, attemptNo: null, type: 0, attempt: null, outbox: null, current: false });
    assert.deepEqual(applyReport(db, report({ payload: '9:1' })), { outcome: 'unknown', outboxId: 9, attemptNo: 1, type: 0, attempt: null, outbox: null, current: false });
    assert.deepEqual(applyReport(db, report({ payload: '5:2' })).outcome, 'unknown');
    assert.throws(() => applyReport(db, report({ type: /** @type {any} */ (3) })), TypeError);
    assert.equal(attempt(5, 1).status, 'submitted');
    db.exec('BEGIN IMMEDIATE');
    assert.equal(applyReport(db, report({ type: 1, success: 1 })).attempt, 'delivered');
    assert.equal(db.isTransaction, true, 'applyReport joined the open transaction');
    db.exec('ROLLBACK');
    assert.deepEqual([attempt(5, 1).status, attempt(5, 1).report1_at, outbox(5).status], ['submitted', null, 'submitted']);
  });

  test('the AMI listener: the DongleReport packets of report.txt (types 0, 1, 2), emitted events, malformed ones dropped, stop()', () => {
    const { db, attempt, outbox } = setup([[1, 1, 'submitted', ['submitted']], [2, 1, 'submitted', ['submitted']], [3, 1, 'submitted', ['submitted']], [4, 1, 'submitted', ['submitted']]]);
    const packets = packetsOf(readFileSync(join(FIXTURES, 'ami', 'report.txt'), 'latin1')).filter((packet) => packet.get('Event') === 'DongleReport');
    assert.equal(packets.length, 3);
    const parsed = packets.map((packet) => packetReport(packet, T0));
    assert.deepEqual(parsed, [
      { payload: 'out-1', type: 0, success: 1, scts: null, dt: null, raw: null, source: 'ami', modemId: 'gsm_dongle', at: T0 },
      { payload: 'out-2', type: 1, success: 1, scts: '2026-09-10 09:30:05 +03:00', dt: '2026-09-10 09:30:07 +03:00', raw: '000,', source: 'ami', modemId: 'gsm_dongle', at: T0 },
      { payload: 'out-3', type: 2, success: 0, scts: null, dt: null, raw: null, source: 'ami', modemId: 'gsm_dongle', at: T0 },
    ]);
    assert.equal(packetReport(new Map([['Event', 'DongleStatus'], ['Device', 'gsm_dongle'], ['Status', 'Free']]), T0), null);
    const ami = new FakeDriverAmi();
    ami.addDevice('gsm1', 'quectel', { state: 'Free', current: 'start', desired: 'start' });
    ami.addDevice('gsm2', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
    /** @type {Array<{ level: string, msg: string }>} */
    const lines = [];
    /** @param {string} level */
    const at = (level) => (/** @type {string} */ msg) => void lines.push({ level, msg });
    const log = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => log };
    const listener = createReportListener({ ami: /** @type {any} */ (ami), db, log, now: () => T0 + 7 });
    for (const packet of packets) {
      packet.set('Payload', `${packets.indexOf(packet) + 1}:1`);
      ami.emit('event:DongleReport', packet);
    }
    assert.deepEqual([attempt(1, 1).status, attempt(2, 1).status, attempt(3, 1).status], ['accepted', 'delivered', 'undelivered_expired']);
    assert.deepEqual([attempt(2, 1).report1_at, attempt(2, 1).report_raw, outbox(2).status], [T0 + 7, '000,', 'delivered']);
    ami.emitReport('gsm2', { payload: '4:1', type: 1, success: 0, scts: '2026-09-11 12:00:05 +03:00', dt: '2026-09-11 12:00:09 +03:00', report: '064,' });
    assert.deepEqual([attempt(4, 1).status, outbox(4).last_error], ['undelivered', 'not delivered (status report 064,)']);
    ami.emit('event:QuectelReport', new Map([['Event', 'QuectelReport'], ['Device', 'gsm1'], ['Payload', ''], ['Type', '1'], ['Success', '1']]));
    ami.emit('event:QuectelReport', new Map([['Event', 'QuectelReport'], ['Device', 'gsm1'], ['Payload', '4:1'], ['Type', '7'], ['Success', '1']]));
    assert.equal(lines.filter((line) => line.level === 'warn' && line.msg.startsWith('driver Report event without')).length, 2);
    listener.stop();
    ami.emitReport('gsm1', { payload: '1:1', type: 2, success: 0 });
    assert.equal(attempt(1, 1).report2_at, null, 'no longer listening');
  });

  test('the spool path: the aster-emit fixtures for payload 7:2 through ingestFile, the AMI copy applied first', () => {
    const { db, attempt, outbox } = setup([[7, 2, 'submitted', ['rejected', 'submitted']]]);
    const events = join(tmp, `spool-${counter}`, 'events');
    mkdirSync(events, { recursive: true });
    assert.equal(applyReport(db, report({ payload: '7:2', type: 0, success: 1, source: 'ami', at: T0 })).attempt, 'accepted');
    for (const name of ['sms-report-submitted.evt', 'sms-report-delivered.evt', 'sms-report-expired.evt']) {
      copyFileSync(join(FIXTURES, 'spool', 'valid', name), join(events, name.replace(/^.*$/, (base) => base)));
    }
    // the fixture files are named <event_id>.evt in the fixtures directory under their descriptive names: rename to their ids
    for (const name of ['sms-report-submitted.evt', 'sms-report-delivered.evt', 'sms-report-expired.evt']) {
      const line = readFileSync(join(events, name), 'utf8');
      const id = line.split('\t')[2];
      copyFileSync(join(events, name), join(events, `${id}.evt`));
      rmSync(join(events, name));
      const result = ingestFile(db, join(events, `${id}.evt`), { now: () => T0 });
      assert.equal(result.status, 'ingested', name);
    }
    const row = attempt(7, 2);
    assert.deepEqual([row.report0_at, row.report0_success, row.report1_success, row.report_raw, row.report2_at !== null, row.status],
      [T0, 1, 1, '000,', true, 'delivered'], 'the AMI copy of the type 0 report kept its time; the spooled copy was a duplicate');
    assert.deepEqual([outbox(7).status, attempt(7, 1).status], ['delivered', 'rejected']);
  });
});
