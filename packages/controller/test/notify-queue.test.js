// @ts-check
// Tests for src/notify/queue.js against the fake Bot API (test/telegram-fake.js), ticked by hand: sending, retries and
// backoff, ordered parts, expiry, and start()/stop().
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { BACKOFF_MS, createNotifyQueue, enqueue, NotifyError } from '../src/notify/queue.js';
import { migrate, open } from '../src/store/db.js';
import { startFakeTelegram } from './telegram-fake.js';

/** @typedef {import('../src/log.js').Logger} Logger */
/** @typedef {import('../src/notify/queue.js').Notification} Notification */

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const T0 = Date.UTC(2026, 8, 11, 10, 0, 0);

const tmp = mkdtempSync(join(tmpdir(), 'aster-notify-queue-'));
/** @type {Awaited<ReturnType<typeof startFakeTelegram>>} */
let tg;
/** @type {Array<() => unknown>} */
const cleanups = [];
after(() => rmSync(tmp, { recursive: true, force: true }));

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
 * A migrated database, a bus that keeps notification.result payloads, a clock and a queue pointed at the fake server.
 * @param {{ token?: string | null, timing?: Partial<import('../src/notify/queue.js').Timing> }} [options]
 */
function setup({ token = TOKEN, timing = {} } = {}) {
  const db = open(join(mkdtempSync(join(tmp, 'case-')), 'aster.db'));
  migrate(db);
  const bus = createBus();
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  bus.subscribe((event) => {
    if (event.type === 'notification.result') results.push(event.payload);
  });
  const clock = { now: T0, token };
  const { log, lines } = capture();
  const queue = createNotifyQueue({ db, bus, log, token: () => clock.token, now: () => clock.now, host: () => 'aster-test', apiBase: tg.url, timing });
  cleanups.push(async () => {
    await queue.stop();
    db.close();
  });
  /** @returns {Notification[]} */
  const rows = () => /** @type {Notification[]} */ (db.prepare('SELECT * FROM notifications ORDER BY id').all().map((row) => ({ ...row })));
  /** @param {number} id */
  const row = (id) => {
    const found = rows().find((entry) => entry.id === id);
    assert.ok(found, `row ${id}`);
    return found;
  };
  return { db, bus, results, clock, queue, rows, row, lines };
}

/** @param {number} lines  @param {number} [width] */
const longText = (lines, width = 60) => Array.from({ length: lines }, (_, index) => `${String(index).padStart(4, '0')} ${'ж'.repeat(width)}`).join('\n');

describe('notify queue', () => {
  // suite hooks, not file hooks: a --test-name-pattern that selects none of these tests must not start (and leave open) the server
  before(async () => {
    tg = await startFakeTelegram();
  });
  beforeEach(() => {
    tg.script = () => undefined;
    tg.requests.length = 0;
  });
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await tg?.close();
  });

  test('enqueue stores one pending row per recipient and part, due at once; inside a transaction the rows join it', () => {
    const { db, rows } = setup();
    const text = longText(100); // two parts
    const ids = enqueue(db, { sourceKind: 'sms', sourceId: 7, chatIds: ['111222333', '-1001234567890'], text, now: T0 });
    assert.equal(ids.length, 4);
    assert.deepEqual(rows().map((entry) => [entry.id, entry.source_kind, entry.source_id, entry.chat_id, entry.part_no, entry.part_count, entry.status, entry.attempts,
      entry.next_at, entry.created_at, entry.sent_at, entry.tg_message_id, entry.error]), [
      [ids[0], 'sms', 7, '111222333', 1, 2, 'pending', 0, T0, T0, null, null, null],
      [ids[1], 'sms', 7, '111222333', 2, 2, 'pending', 0, T0, T0, null, null, null],
      [ids[2], 'sms', 7, '-1001234567890', 1, 2, 'pending', 0, T0, T0, null, null, null],
      [ids[3], 'sms', 7, '-1001234567890', 2, 2, 'pending', 0, T0, T0, null, null, null],
    ]);
    assert.equal(`${rows()[0]?.text}\n${rows()[1]?.text}`, text);

    db.exec('BEGIN IMMEDIATE');
    enqueue(db, { sourceKind: 'call', sourceId: 3, chatIds: ['1'], text: 'Missed call', now: T0 });
    assert.ok(db.isTransaction, 'the caller\'s transaction stays open');
    db.exec('ROLLBACK');
    assert.equal(rows().length, 4, 'rolled back with the caller\'s transaction');

    assert.throws(() => enqueue(db, { sourceKind: 'sms', chatIds: ['1', '12a'], text: 'x' }), NotifyError);
    assert.throws(() => enqueue(db, { sourceKind: /** @type {any} */ ('email'), chatIds: ['1'], text: 'x' }), NotifyError);
    assert.deepEqual(enqueue(db, { sourceKind: 'alert', chatIds: ['1'], text: ' \n ' }), []);
    assert.deepEqual(enqueue(db, { sourceKind: 'alert', chatIds: [], text: 'x' }), []);
    assert.deepEqual(enqueue(db, { sourceKind: 'test', chatIds: ['5', '5'], text: 'x', now: T0 }).length, 1, 'a repeated chat id gets one row');
    assert.equal(rows().length, 5);
  });

  test('a due row is sent once: sent with the Telegram message id, sent_at, and a notification.result without the text', async () => {
    const { db, queue, row, results, clock } = setup();
    const [id] = enqueue(db, { sourceKind: 'sms', sourceId: 1, chatIds: ['111222333'], text: 'SMS gsm1 from +1234567890\nПривет', now: T0 });
    assert.ok(id !== undefined);
    clock.now = T0 + 250;
    const summary = await queue.tick();
    assert.deepEqual(summary, { expired: 0, sent: 1, retried: 0, failed: 0, waiting: 0, skipped: null });
    assert.deepEqual(tg.messages(), [{ chatId: '111222333', text: 'SMS gsm1 from +1234567890\nПривет' }]);
    const sent = row(id);
    assert.deepEqual([sent.status, sent.attempts, sent.next_at, sent.error, sent.sent_at], ['sent', 1, null, null, T0 + 250]);
    assert.ok(typeof sent.tg_message_id === 'number' && sent.tg_message_id > 1000);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, 'sent');
    assert.equal(results[0]?.id, id);
    assert.equal(results[0]?.at, T0 + 250);
    assert.ok(!('text' in (results[0] ?? {})), 'the payload carries no text');
    await queue.tick();
    assert.equal(tg.requests.length, 1, 'a sent row is never sent again');
  });

  test('429 with retry_after: the row waits exactly that long and holds its chat; other chats are sent meanwhile', async () => {
    const { db, queue, row, clock } = setup();
    const [a1] = enqueue(db, { sourceKind: 'sms', sourceId: 1, chatIds: ['111'], text: 'A1', now: T0 });
    const [b1] = enqueue(db, { sourceKind: 'sms', sourceId: 2, chatIds: ['222'], text: 'B1', now: T0 });
    const [a2] = enqueue(db, { sourceKind: 'sms', sourceId: 3, chatIds: ['111'], text: 'A2', now: T0 });
    assert.ok(a1 && b1 && a2);
    let limited = true;
    tg.script = (request) => {
      if (request.chatId === '111' && limited) {
        limited = false;
        return tg.error(429, 'Too Many Requests: retry after 7', { retry_after: 7 });
      }
      return undefined;
    };
    const first = await queue.tick();
    assert.deepEqual([first.sent, first.retried, first.waiting], [1, 1, 1]);
    assert.deepEqual([row(a1).status, row(a1).next_at, row(a1).attempts, row(a1).error], ['retry', T0 + 7000, 1, 'HTTP 429: Too Many Requests: retry after 7']);
    assert.deepEqual([row(a2).status, row(a2).attempts], ['pending', 0], 'the held chat gets no request');
    assert.equal(row(b1).status, 'sent');

    clock.now = T0 + 6999;
    await queue.tick();
    assert.equal(tg.requests.length, 2, 'nothing for the chat before retry_after has passed');
    clock.now = T0 + 7000;
    await queue.tick();
    assert.deepEqual(tg.requests.map((request) => request.text), ['A1', 'B1', 'A1', 'A2']);
    assert.deepEqual([row(a1).status, row(a2).status], ['sent', 'sent']);
  });

  test('a held chat with more due rows than a batch does not keep the other chats waiting', async () => {
    const { db, queue, row, clock } = setup({ timing: { batch: 3 } });
    const held = Array.from({ length: 5 }, (_, index) => enqueue(db, { sourceKind: 'sms', sourceId: index + 1, chatIds: ['111'], text: `A${index + 1}`, now: T0 })[0]);
    const [other] = enqueue(db, { sourceKind: 'sms', sourceId: 9, chatIds: ['222'], text: 'B', now: T0 });
    assert.ok(other);
    tg.script = (request) => (request.chatId === '111' ? tg.error(429, 'Too Many Requests: retry after 60', { retry_after: 60 }) : undefined);
    const first = await queue.tick();
    assert.deepEqual([first.retried, first.waiting, first.sent], [1, 2, 0], 'the batch held A1 (429), A2 and A3');
    const second = await queue.tick();
    assert.equal(second.sent, 1, 'the next batch leaves the held chat out');
    assert.equal(row(other).status, 'sent');
    assert.deepEqual(tg.requests.map((request) => request.text), ['A1', 'B']);
    tg.script = () => undefined;
    clock.now = T0 + 60_000;
    await queue.tick();
    await queue.tick();
    assert.deepEqual(held.map((id) => row(Number(id)).status), ['sent', 'sent', 'sent', 'sent', 'sent']);
    assert.deepEqual(tg.requests.map((request) => request.text), ['A1', 'B', 'A1', 'A2', 'A3', 'A4', 'A5']);
  });

  test('a row left sending while no request is in flight is due again at the next tick', async () => {
    const { db, queue, row, lines } = setup();
    const [id] = enqueue(db, { sourceKind: 'alert', chatIds: ['111'], text: 'stuck', now: T0 });
    assert.ok(id);
    db.prepare("UPDATE notifications SET status = 'sending', attempts = 1 WHERE id = ?").run(id);
    assert.equal((await queue.tick()).sent, 1);
    assert.deepEqual([row(id).status, row(id).attempts], ['sent', 2]);
    assert.ok(lines.some((line) => line.msg.startsWith('notifications interrupted while sending are retried')));
  });

  test('403 is permanent: failed with Telegram\'s description, never retried', async () => {
    const { db, queue, row, results, clock } = setup();
    const [id] = enqueue(db, { sourceKind: 'call', sourceId: 9, chatIds: ['403'], text: 'Missed call', now: T0 });
    assert.ok(id);
    tg.script = () => tg.error(403, 'Forbidden: bot was blocked by the user');
    assert.equal((await queue.tick()).failed, 1);
    assert.deepEqual([row(id).status, row(id).attempts, row(id).next_at, row(id).error], ['failed', 1, null, 'HTTP 403: Forbidden: bot was blocked by the user']);
    assert.equal(results.at(-1)?.status, 'failed');
    clock.now = T0 + 2 * 3_600_000;
    await queue.tick();
    assert.equal(tg.requests.length, 1);
  });

  test('a 5xx is retried after 5 s and then sent; a 5xx or no answer ends the tick, the next tick goes on', async () => {
    const { db, queue, row, clock } = setup({ timing: { timeoutMs: 200 } });
    const [a] = enqueue(db, { sourceKind: 'sms', sourceId: 1, chatIds: ['111'], text: 'A', now: T0 });
    const [b] = enqueue(db, { sourceKind: 'sms', sourceId: 2, chatIds: ['222'], text: 'B', now: T0 });
    const [c] = enqueue(db, { sourceKind: 'sms', sourceId: 3, chatIds: ['333'], text: 'C', now: T0 });
    assert.ok(a && b && c);
    tg.script = (request) => (request.index === 0 ? tg.error(502, 'Bad Gateway') : request.index === 1 ? 'hang' : undefined);
    const first = await queue.tick();
    assert.deepEqual([first.retried, first.sent], [1, 0]);
    assert.deepEqual([row(a).status, row(a).next_at, row(b).status], ['retry', T0 + 5000, 'pending']);
    const second = await queue.tick();
    assert.deepEqual([second.retried, second.sent], [1, 0], 'no answer within the timeout ends the tick too');
    assert.deepEqual([row(b).status, row(b).error, row(c).status], ['retry', 'no answer within 0.2 s', 'pending']);
    await queue.tick();
    assert.equal(row(c).status, 'sent');
    clock.now = T0 + 5000;
    await queue.tick();
    assert.deepEqual([row(a).status, row(a).attempts, row(b).status], ['sent', 2, 'sent']);
  });

  test('the backoff ladder by attempt: 5 s, 30 s, 2 min, 10 min, 30 min, then hourly', async () => {
    const { db, queue, row, clock } = setup();
    assert.deepEqual([...BACKOFF_MS], [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000]);
    const [id] = enqueue(db, { sourceKind: 'alert', chatIds: ['1'], text: 'Alert', now: T0 });
    assert.ok(id);
    tg.script = () => tg.error(500, 'Internal Server Error');
    /** @type {number[]} */
    const delays = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      assert.equal((await queue.tick()).retried, 1, `attempt ${attempt}`);
      const next = row(id).next_at ?? 0;
      delays.push(next - clock.now);
      clock.now = next - 1;
      assert.equal((await queue.tick()).retried, 0, 'not before next_at');
      clock.now = next;
    }
    assert.deepEqual(delays, [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000]);
    assert.equal(row(id).attempts, 8);
  });

  test('a long text is split on line boundaries and its parts arrive in order', async () => {
    const { db, queue, rows } = setup();
    const text = longText(160); // three parts of at most 4096
    const ids = enqueue(db, { sourceKind: 'sms', sourceId: 4, chatIds: ['111222333'], text, now: T0 });
    assert.equal(ids.length, 3);
    await queue.tick();
    const texts = tg.messages().map((message) => message.text ?? '');
    assert.equal(texts.length, 3);
    for (const part of texts) assert.ok(part.length <= 4096);
    assert.equal(texts.join('\n'), text);
    assert.deepEqual(rows().map((entry) => [entry.part_no, entry.part_count, entry.status]), [[1, 3, 'sent'], [2, 3, 'sent'], [3, 3, 'sent']]);
  });

  test('part n+1 waits until part n is sent, even when it is due; a part that failed fails the parts after it', async () => {
    const { db, queue, row, clock } = setup();
    const [p1, p2] = enqueue(db, { sourceKind: 'sms', sourceId: 5, chatIds: ['111'], text: longText(100), now: T0 });
    assert.ok(p1 && p2);
    tg.script = (request) => (request.index === 0 ? tg.error(500, 'Internal Server Error') : undefined);
    await queue.tick();
    const waiting = await queue.tick();
    assert.deepEqual([row(p1).status, row(p2).status, row(p2).attempts, waiting.waiting], ['retry', 'pending', 0, 1]);
    assert.equal(tg.requests.length, 1, 'part 2 is not sent while part 1 waits for its retry');
    clock.now = T0 + 5000;
    await queue.tick();
    assert.deepEqual([row(p1).status, row(p2).status], ['sent', 'sent']);
    assert.deepEqual(tg.requests.map((request) => request.text), [row(p1).text, row(p1).text, row(p2).text]);

    const [q1, q2, q3] = enqueue(db, { sourceKind: 'sms', sourceId: 6, chatIds: ['222'], text: longText(160), now: clock.now });
    assert.ok(q1 && q2 && q3);
    tg.script = () => tg.error(400, 'Bad Request: message is too long');
    const failed = await queue.tick();
    assert.equal(failed.failed, 3);
    assert.deepEqual([row(q1).error, row(q2).error, row(q3).error], ['HTTP 400: Bad Request: message is too long', 'part 1 of 3 was not sent', 'part 2 of 3 was not sent']);
    assert.deepEqual([row(q2).attempts, row(q3).attempts], [0, 0]);
    assert.equal(tg.requests.length, 4, 'only part 1 was requested');
  });

  test('partial success across recipients: every chat has its own rows and result', async () => {
    const { db, queue, rows, results } = setup();
    enqueue(db, { sourceKind: 'sms', sourceId: 8, chatIds: ['111', '403', '333'], text: 'SMS gsm2 from MTS\nКод 4821', now: T0 });
    tg.script = (request) => (request.chatId === '403' ? tg.error(403, 'Forbidden: bot was kicked from the group chat') : undefined);
    const summary = await queue.tick();
    assert.deepEqual([summary.sent, summary.failed], [2, 1]);
    assert.deepEqual(rows().map((entry) => [entry.chat_id, entry.status, entry.error]), [['111', 'sent', null], ['403', 'failed', 'HTTP 403: Forbidden: bot was kicked from the group chat'], ['333', 'sent', null]]);
    assert.deepEqual(tg.messages().map((message) => message.chatId), ['111', '333']);
    assert.deepEqual(results.map((result) => [result.chat_id, result.status]).sort(), [['111', 'sent'], ['333', 'sent'], ['403', 'failed']]);
  });

  test('rows not sent within 24 h of their creation fail with their last error', async () => {
    const { db, queue, row, clock } = setup();
    const [retried] = enqueue(db, { sourceKind: 'sms', sourceId: 1, chatIds: ['111'], text: 'A', now: T0 });
    assert.ok(retried);
    tg.script = () => tg.error(503, 'Service Unavailable');
    await queue.tick();
    clock.token = null;
    const [waiting] = enqueue(db, { sourceKind: 'sms', sourceId: 2, chatIds: ['222'], text: 'B', now: T0 + 1000 });
    assert.ok(waiting);
    clock.now = T0 + 86_400_000 - 1;
    assert.equal((await queue.tick()).expired, 0);
    clock.now = T0 + 86_400_000;
    const summary = await queue.tick();
    assert.equal(summary.expired, 1);
    assert.deepEqual([row(retried).status, row(retried).error, row(retried).next_at], ['failed', 'not sent within 24 h: HTTP 503: Service Unavailable', null]);
    clock.now = T0 + 1000 + 86_400_000;
    assert.equal((await queue.tick()).expired, 1);
    assert.deepEqual([row(waiting).status, row(waiting).error, row(waiting).attempts], ['failed', 'not sent within 24 h', 0]);
  });

  test('without a usable token nothing is sent and it is logged once; the test probe is refused, then sent once a token exists', async () => {
    const { db, queue, row, rows, clock, lines } = setup({ token: null });
    const [id] = enqueue(db, { sourceKind: 'sms', sourceId: 1, chatIds: ['111'], text: 'A', now: T0 });
    assert.ok(id);
    assert.deepEqual(await queue.tick(), { expired: 0, sent: 0, retried: 0, failed: 0, waiting: 1, skipped: 'token missing' });
    await queue.tick();
    assert.throws(() => queue.enqueueTest('111222333'), NotifyError);
    clock.token = 'not a token';
    assert.equal((await queue.tick()).skipped, 'token malformed');
    await queue.tick();
    assert.equal(tg.requests.length, 0);
    assert.deepEqual(lines.filter((line) => line.level === 'warn' || line.level === 'error').map((line) => line.msg), [
      'no Telegram bot token (TELEGRAM_BOT_TOKEN): notifications stay queued and fail 24 h after they were created',
      'the Telegram bot token is malformed (expected <digits>:<letters, digits, _ or ->): notifications stay queued',
    ]);
    assert.equal(row(id).status, 'pending');
    assert.throws(() => queue.enqueueTest('111222333'), NotifyError);

    clock.token = TOKEN;
    clock.now = T0 + 60_000;
    assert.throws(() => queue.enqueueTest('12a'), NotifyError);
    const probe = queue.enqueueTest('111222333');
    const stored = rows().find((entry) => entry.id === probe);
    assert.deepEqual([stored?.source_kind, stored?.source_id, stored?.chat_id, stored?.text], ['test', null, '111222333', '[aster-test] Aster test notification [2026-09-11 10:01:00 +00:00]']);
    assert.equal((await queue.tick()).sent, 2);
    assert.deepEqual(tg.messages(), [{ chatId: '111', text: 'A' }, { chatId: '111222333', text: '[aster-test] Aster test notification [2026-09-11 10:01:00 +00:00]' }]);
    assert.ok(lines.some((line) => line.msg === 'Telegram bot token configured; sending queued notifications'));
  });

  test('a success makes the chat\'s waiting retries due at once, so the backlog arrives right after the chat recovers', async () => {
    const { db, queue, row, clock } = setup();
    const [first] = enqueue(db, { sourceKind: 'sms', sourceId: 1, chatIds: ['111'], text: 'first', now: T0 });
    assert.ok(first);
    tg.script = (request) => (request.index < 2 ? tg.error(500, 'Internal Server Error') : undefined);
    await queue.tick();
    clock.now = T0 + 5000;
    await queue.tick();
    assert.deepEqual([row(first).status, row(first).next_at], ['retry', T0 + 5000 + 30_000]);
    clock.now = T0 + 10_000;
    const [second] = enqueue(db, { sourceKind: 'sms', sourceId: 2, chatIds: ['111'], text: 'second', now: clock.now });
    assert.ok(second);
    await queue.tick();
    assert.deepEqual([row(second).status, row(first).next_at], ['sent', T0 + 10_000]);
    await queue.tick();
    assert.equal(row(first).status, 'sent');
    assert.deepEqual(tg.requests.map((request) => request.text), ['first', 'first', 'second', 'first']);
  });

  test('start() makes rows a stopped controller left sending due again; stop() aborts a request in flight and leaves its row due', async () => {
    const { db, queue, row, clock, lines } = setup({ timing: { tickMs: 60_000 } });
    const [left] = enqueue(db, { sourceKind: 'sms', sourceId: 1, chatIds: ['111'], text: 'interrupted', now: T0 - 5000 });
    assert.ok(left);
    db.prepare("UPDATE notifications SET status = 'sending', attempts = 1, next_at = ? WHERE id = ?").run(T0 - 5000, left);
    const [hung] = enqueue(db, { sourceKind: 'sms', sourceId: 2, chatIds: ['222'], text: 'hangs', now: T0 });
    assert.ok(hung);
    tg.script = (request) => (request.text === 'hangs' ? 'hang' : undefined);
    queue.start();
    assert.throws(() => queue.start(), /already started/);
    assert.ok(lines.some((line) => line.msg.startsWith('notifications interrupted while sending are retried') && JSON.stringify(line.fields.ids) === JSON.stringify([left])));
    const deadline = Date.now() + 5000;
    while (!tg.requests.some((request) => request.text === 'hangs')) {
      assert.ok(Date.now() < deadline, 'the start tick sends');
      await sleep(10);
    }
    assert.equal(row(left).status, 'sent');
    assert.equal(row(left).attempts, 2);
    const stopping = Date.now();
    await queue.stop();
    assert.ok(Date.now() - stopping < 2000, 'stop does not wait for the request timeout');
    assert.deepEqual([row(hung).status, row(hung).next_at, row(hung).attempts, row(hung).error], ['retry', clock.now, 1, 'request aborted']);
    assert.deepEqual(await queue.tick(), { expired: 0, sent: 0, retried: 0, failed: 0, waiting: 0, skipped: 'stopped' });
  });
});
