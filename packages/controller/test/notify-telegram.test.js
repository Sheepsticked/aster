// @ts-check
// Tests for src/notify/telegram.js against the fake Bot API (test/telegram-fake.js): the request, and which failures are
// permanent or transient; the token never appears in an error text.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { after, before, describe, test } from 'node:test';
import { isToken, PERMANENT_STATUSES, sendMessage } from '../src/notify/telegram.js';
import { startFakeTelegram } from './telegram-fake.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

/** @type {Awaited<ReturnType<typeof startFakeTelegram>>} */
let tg;

describe('notify telegram client', () => {
  // suite hooks, not file hooks: a --test-name-pattern that selects none of these tests must not start (and leave open) the server
  before(async () => {
    tg = await startFakeTelegram();
  });
  after(async () => {
    await tg?.close();
  });

  test('a message is a POST of JSON {chat_id, text} to /bot<token>/sendMessage without parse_mode; success returns message_id', async () => {
    tg.script = () => undefined;
    const text = 'SMS gsm1 from <b>+375</b> [x]\n*не* разметка _ `code`';
    const result = await sendMessage(TOKEN, '-1001234567890123', text, { apiBase: tg.url });
    assert.equal(result.ok, true);
    assert.ok(result.ok && Number.isInteger(result.messageId) && result.messageId !== null && result.messageId > 1000);
    const request = tg.requests.at(-1);
    assert.equal(request?.token, TOKEN);
    assert.equal(request?.method, 'sendMessage');
    assert.equal(request?.contentType, 'application/json');
    assert.deepEqual(request?.body, { chat_id: '-1001234567890123', text });
  });

  test('429 is transient with retry_after from parameters, else from the Retry-After header', async () => {
    tg.script = () => tg.error(429, 'Too Many Requests: retry after 17', { retry_after: 17 });
    assert.deepEqual(await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url }),
      { ok: false, permanent: false, retryAfter: 17, status: 429, error: 'HTTP 429: Too Many Requests: retry after 17' });
    tg.script = () => ({ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests' }, headers: { 'retry-after': '4' } });
    const header = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url });
    assert.equal(!header.ok && header.retryAfter, 4);
    tg.script = () => tg.error(429, 'Too Many Requests', { retry_after: 'soon' });
    const none = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url });
    assert.deepEqual(!none.ok && [none.permanent, none.retryAfter], [false, null]);
  });

  test('400, 401, 403 and 404 are permanent and carry Telegram\'s description', async () => {
    assert.deepEqual([...PERMANENT_STATUSES], [400, 401, 403, 404]);
    const cases = [
      [400, 'Bad Request: chat not found'],
      [401, 'Unauthorized'],
      [403, 'Forbidden: bot was blocked by the user'],
      [404, 'Not Found'],
    ];
    for (const [status, description] of /** @type {Array<[number, string]>} */ (cases)) {
      tg.script = () => tg.error(status, description);
      assert.deepEqual(await sendMessage(TOKEN, '42', 'x', { apiBase: tg.url }),
        { ok: false, permanent: true, retryAfter: null, status, error: `HTTP ${status}: ${description}` });
    }
    tg.script = () => tg.error(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: -1009876543210 });
    const moved = await sendMessage(TOKEN, '-42', 'x', { apiBase: tg.url });
    assert.equal(!moved.ok && moved.error, 'HTTP 400: Bad Request: group chat was upgraded to a supergroup chat (the chat moved to -1009876543210)');
  });

  test('5xx, other statuses and answers that are not the Bot API are transient', async () => {
    for (const status of [500, 502, 503, 409, 413, 420]) {
      tg.script = () => tg.error(status, `status ${status}`);
      const result = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url });
      assert.deepEqual(!result.ok && [result.permanent, result.status, result.retryAfter], [false, status, null], String(status));
    }
    tg.script = () => ({ status: 502, body: '<html>Bad Gateway</html>' });
    const html = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url });
    assert.deepEqual(html, { ok: false, permanent: false, retryAfter: null, status: 502, error: 'HTTP 502: Bad Gateway (not a Bot API answer)' });
    tg.script = () => ({ status: 200, body: { ok: false, description: 'odd' } });
    const odd = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url });
    assert.deepEqual(!odd.ok && [odd.permanent, odd.error], [false, 'HTTP 200: odd']);
    tg.script = () => ({ status: 400, body: 'not json' });
    const plain400 = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url });
    assert.deepEqual(!plain400.ok && [plain400.permanent, plain400.error], [true, 'HTTP 400: Bad Request (not a Bot API answer)']);
  });

  test('a reset connection, a refused port, the timeout and an abort are transient; the request never hangs past the timeout', async () => {
    tg.script = () => 'destroy';
    const reset = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url });
    assert.deepEqual(!reset.ok && [reset.permanent, reset.status], [false, null]);
    assert.match(!reset.ok ? reset.error : '', /^fetch failed: /);

    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    probe.close();
    await once(probe, 'close');
    const refused = await sendMessage(TOKEN, '1', 'x', { apiBase: `http://127.0.0.1:${port}` });
    assert.match(!refused.ok ? refused.error : '', /^fetch failed: .*ECONNREFUSED/);

    tg.script = () => 'hang';
    const started = Date.now();
    const slow = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url, timeoutMs: 300 });
    assert.deepEqual(slow, { ok: false, permanent: false, retryAfter: null, status: null, error: 'no answer within 0.3 s' });
    assert.ok(Date.now() - started < 3000);

    const controller = new AbortController();
    const pending = sendMessage(TOKEN, '1', 'x', { apiBase: tg.url, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    assert.deepEqual(await pending, { ok: false, permanent: false, retryAfter: null, status: null, error: 'request aborted' });
  });

  test('the token never appears in an error text, even when an answer or a network error repeats it', async () => {
    tg.script = (request) => tg.error(500, `internal error at /bot${request.token}/sendMessage`);
    const echoed = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url });
    assert.equal(!echoed.ok && echoed.error, 'HTTP 500: internal error at /bot<token>/sendMessage');
    /** @type {typeof fetch} */
    const failing = async (input) => {
      throw new TypeError(`Failed to parse URL from ${String(input)}`);
    };
    const thrown = await sendMessage(TOKEN, '1', 'x', { apiBase: tg.url, fetch: failing });
    assert.ok(!thrown.ok && !thrown.error.includes(TOKEN) && thrown.error.includes('<token>'), !thrown.ok ? thrown.error : '');
  });

  test('a malformed token throws before any request; a malformed chat id is a permanent failure without a request', async () => {
    const before = tg.requests.length;
    for (const token of ['', 'abc', '123456:AA bb', '123:abc/../getMe', '123:abc?x=1', `123:${'a'.repeat(129)}`]) {
      assert.equal(isToken(token), false, token);
      await assert.rejects(sendMessage(token, '1', 'x', { apiBase: tg.url }), TypeError, token);
    }
    assert.equal(isToken(TOKEN), true);
    for (const chatId of ['', '12a', '+1', '1 ', `1${'0'.repeat(32)}`]) {
      assert.deepEqual(await sendMessage(TOKEN, chatId, 'x', { apiBase: tg.url }),
        { ok: false, permanent: true, retryAfter: null, status: null, error: 'the chat id is not digits with an optional leading -' }, chatId);
    }
    assert.equal(tg.requests.length, before);
  });
});
