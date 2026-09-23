// @ts-check
// Contract tests for the history lists (rows and totals with filters and paging), the operations routes, the SMS
// outbox routes and the Telegram test probe.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_PER_PAGE, PER_PAGE } from '../src/http/page.js';
import { harness, snapshot } from './http-harness.js';

const T = 1_700_000_000_000;

/** Inbox messages, outbox rows, calls and notifications shaped so that every filter has something to pick out. */
const ROWS = {
  messages: [
    { sender: '+375290000001', text: 'Ваш код 1234', received_at: T + 10 },
    { sender: '+375290000002', text: 'hello there', received_at: T + 30 },
    { sender: null, text: 'from nobody', received_at: T + 20, modem_id: 'gsm2' },
  ],
  outbox: [
    { number: '+375290000003', text: 'sent to three', status: 'delivered', attempt_no: 1, created_at: T + 40 },
    { number: '+375290000004', text: 'hello outbound', status: 'failed', attempt_no: 2, created_at: T + 5, last_error: 'Device disconnected' },
  ],
  calls: [
    { caller: '+375290000005', did: '100', outcome: 'missed', dialstatus: 'NOANSWER', ended_at: T + 1 },
    { caller: '+375290000006', did: '200', outcome: 'answered', answered_sec: 37, ended_at: T + 2, modem_id: 'gsm2' },
  ],
  notifications: [
    { source_kind: 'sms', chat_id: '100200300', text: 'SMS GSM1', status: 'sent', created_at: T + 1, sent_at: T + 2, tg_message_id: 9 },
    { source_kind: 'alert', chat_id: '-100200300', text: 'Alert: …', status: 'failed', attempts: 5, error: 'chat not found', created_at: T + 3 },
  ],
};

describe('http history routes', () => {
  test('GET /api/messages merges the inbox and the outbox newest first, with direction, modem, status and q filters', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      h.seed(ROWS);
      const before = snapshot(h.db);
      /** @param {string} query */
      const get = async (query) => (await h.app.inject({ method: 'GET', url: `/api/messages${query}`, headers: { cookie } })).json();

      const all = await get('');
      assert.deepEqual([all.total, all.page, all.per_page, all.pages], [5, 1, 50, 1]);
      assert.deepEqual(all.items.map((/** @type {any} */ item) => [item.direction, item.at]),
        [['out', T + 40], ['in', T + 30], ['in', T + 20], ['in', T + 10], ['out', T + 5]]);
      assert.deepEqual(all.items[0], { direction: 'out', id: 1, modem_id: 'gsm1', number: '+375290000003', text: 'sent to three',
        status: 'delivered', at: T + 40, updated_at: T + 40, attempt_no: 1, last_error: null, scts: null });

      assert.deepEqual((await get('?direction=in')).items.map((/** @type {any} */ i) => i.direction), ['in', 'in', 'in']);
      assert.deepEqual((await get('?direction=out')).total, 2);
      assert.deepEqual((await get('?modem=gsm2')).items.map((/** @type {any} */ i) => i.text), ['from nobody']);
      assert.deepEqual((await get('?status=failed')).items.map((/** @type {any} */ i) => i.text), ['hello outbound'],
        'a status is an outbox column, so asking for one narrows the list to sent messages');
      assert.deepEqual((await get('?q=hello')).items.map((/** @type {any} */ i) => i.text), ['hello there', 'hello outbound'],
        'q searches the text of both halves and the sender or the number');
      assert.deepEqual((await get('?q=0000002')).items.map((/** @type {any} */ i) => i.text), ['hello there']);
      assert.deepEqual((await get('?q=ВАШ КОД')).items.map((/** @type {any} */ i) => i.text), ['Ваш код 1234'], 'case-insensitively');
      assert.deepEqual((await get('?q=100%')).total, 0, 'q is a substring, not a LIKE pattern');

      const paged = await get('?per_page=2&page=2');
      assert.deepEqual([paged.total, paged.pages, paged.items.map((/** @type {any} */ i) => i.at)], [5, 3, [T + 20, T + 10]]);
      assert.deepEqual((await get('?per_page=2&page=9')).items, [], 'a page past the end is empty, not an error');
      assert.deepEqual([(await get('?per_page=999')).per_page, (await get('?per_page=0')).per_page], [MAX_PER_PAGE, PER_PAGE],
        'a page size outside the limits is clamped rather than refused');
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/messages?direction=sideways', headers: { cookie } })).statusCode, 400);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/messages?page=-1', headers: { cookie } })).statusCode, 400);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/messages?nonsense=1', headers: { cookie } })).statusCode, 400);
      assert.equal(snapshot(h.db), before, 'a GET writes nothing');
    } finally {
      await h.stop();
    }
  });

  test('GET /api/calls and /api/notifications answer their rows with the filters the pages offer', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      h.seed(ROWS);
      /** @param {string} url */
      const get = async (url) => (await h.app.inject({ method: 'GET', url, headers: { cookie } })).json();

      const calls = await get('/api/calls');
      assert.deepEqual([calls.total, calls.items.map((/** @type {any} */ c) => c.caller)], [2, ['+375290000006', '+375290000005']]);
      assert.deepEqual([calls.items[0].outcome, calls.items[0].answered_sec, calls.items[0].modem_id], ['answered', 37, 'gsm2']);
      assert.deepEqual((await get('/api/calls?outcome=missed')).items.map((/** @type {any} */ c) => c.did), ['100']);
      assert.deepEqual((await get('/api/calls?modem=gsm2')).total, 1);
      assert.deepEqual((await get('/api/calls?q=0000005')).items.map((/** @type {any} */ c) => c.did), ['100']);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/calls?outcome=maybe', headers: { cookie } })).statusCode, 400);

      const notifications = await get('/api/notifications');
      assert.deepEqual([notifications.total, notifications.items[0].source_kind], [2, 'alert']);
      assert.deepEqual([notifications.items[0].status, notifications.items[0].error, notifications.items[0].attempts], ['failed', 'chat not found', 5]);
      assert.deepEqual((await get('/api/notifications?status=sent')).items.map((/** @type {any} */ n) => n.tg_message_id), [9]);
      assert.deepEqual((await get('/api/notifications?kind=alert')).total, 1);
      assert.deepEqual((await get('/api/notifications?chat_id=-100200300')).total, 1);
      assert.deepEqual((await get('/api/notifications?q=not found')).total, 1, 'q also searches the error');
    } finally {
      await h.stop();
    }
  });

  test('GET /api/operations lists the rows with filters; one by id carries its params and result', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/at', headers: { cookie }, payload: { command: 'AT+CSQ' } });
      const restart = await h.app.inject({ method: 'POST', url: '/api/modems/gsm1/restart', headers: { cookie } });
      const id = restart.json().operation.id;
      await h.runner.wait(id);

      const list = (await h.app.inject({ method: 'GET', url: '/api/operations', headers: { cookie } })).json();
      assert.deepEqual([list.total, list.items.map((/** @type {any} */ op) => op.kind)], [2, ['modem-restart', 'at']]);
      assert.deepEqual([list.items[0].modem_id, list.items[0].actor, list.items[0].status], ['gsm1', 'admin', 'done']);
      assert.deepEqual([list.items[0].params_bytes, list.items[1].params_bytes], [2, 20], 'a list row says how big the params are instead of carrying them');
      assert.equal(list.items[0].params, undefined, 'the list never carries params or results; one operation does');
      assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/operations?kind=at', headers: { cookie } })).json().total, 1);
      assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/operations?status=done&modem=gsm1', headers: { cookie } })).json().total, 2);
      assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/operations?actor=cli', headers: { cookie } })).json().total, 0);

      const one = (await h.app.inject({ method: 'GET', url: `/api/operations/${id}`, headers: { cookie } })).json();
      assert.deepEqual([one.operation.id, one.operation.kind, one.operation.status, one.operation.actor], [id, 'modem-restart', 'done', 'admin']);
      assert.deepEqual(one.operation.params, {});
      assert.equal(typeof one.operation.result.observed_at, 'number');
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/operations/99999', headers: { cookie } })).statusCode, 404);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/operations/abc', headers: { cookie } })).statusCode, 400);
    } finally {
      await h.stop();
    }
  });
});

describe('http sms routes', () => {
  test('POST stores the SMS with its sms-send operation; the outbox refusals become 400, 404 and 409', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const response = await h.app.inject({ method: 'POST', url: '/api/sms', headers: { cookie },
        payload: { modem_id: 'gsm1', number: '+375290000001', text: 'hello' } });
      assert.equal(response.statusCode, 202);
      assert.deepEqual([response.json().attempt_no, response.json().operation.kind], [1, 'sms-send']);
      const stored = /** @type {any} */ (h.db.prepare('SELECT * FROM sms_outbox WHERE id = ?').get(response.json().id));
      assert.deepEqual([stored.modem_id, stored.number, stored.text, stored.status], ['gsm1', '+375290000001', 'hello', 'queued']);
      const one = await h.app.inject({ method: 'GET', url: `/api/sms/${response.json().id}`, headers: { cookie } });
      assert.deepEqual([one.statusCode, one.json().sms.number, Array.isArray(one.json().sms.attempts)], [200, '+375290000001', true]);

      const unknown = await h.app.inject({ method: 'POST', url: '/api/sms', headers: { cookie }, payload: { modem_id: 'gsm9', number: '+375290000001', text: 'x' } });
      assert.deepEqual([unknown.statusCode, unknown.json().code], [400, 'invalid']);
      assert.match(unknown.json().error, /modem gsm9 is not in the registry/);
      for (const payload of [{ modem_id: 'gsm1', number: '+375290000001' }, { modem_id: 'gsm1', number: 'nonsense', text: 'x' },
        { modem_id: 'gsm1', number: '+375290000001', text: '' }, { modem_id: 'gsm1', number: '+375290000001', text: 'x', extra: 1 }]) {
        assert.equal((await h.app.inject({ method: 'POST', url: '/api/sms', headers: { cookie }, payload })).statusCode, 400, JSON.stringify(payload));
      }
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/sms/9999', headers: { cookie } })).statusCode, 404);
    } finally {
      await h.stop();
    }
  });

  test('a retry needs confirm for a status that may already have arrived, and 404s for a row that is not there', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      h.seed({ outbox: [{ status: 'failed', attempt_no: 1, created_at: T }, { status: 'uncertain', attempt_no: 1, created_at: T }] });
      const failed = await h.app.inject({ method: 'POST', url: '/api/sms/1/retry', headers: { cookie } });
      assert.equal(failed.statusCode, 202);
      assert.deepEqual([failed.json().id, failed.json().attempt_no], [1, 2]);

      const needsConfirm = await h.app.inject({ method: 'POST', url: '/api/sms/2/retry', headers: { cookie } });
      assert.deepEqual([needsConfirm.statusCode, needsConfirm.json().code], [409, 'confirm-required']);
      assert.match(needsConfirm.json().error, /it may have reached the recipient/);
      const confirmed = await h.app.inject({ method: 'POST', url: '/api/sms/2/retry', headers: { cookie }, payload: { confirm: true } });
      assert.equal(confirmed.statusCode, 202);

      const missing = await h.app.inject({ method: 'POST', url: '/api/sms/77/retry', headers: { cookie }, payload: { confirm: true } });
      assert.deepEqual([missing.statusCode, missing.json().code], [404, 'not-found']);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/sms/1/retry', headers: { cookie }, payload: { confirm: 'yes' } })).statusCode, 400);
    } finally {
      await h.stop();
    }
  });

  test('DELETE removes an SMS whose sending has ended, POST /api/sms/purge the failed ones or one modem\'s; one being sent is 409', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      h.seed({ outbox: [
        { status: 'failed', attempt_no: 1, created_at: T }, { status: 'delivered', attempt_no: 1, created_at: T },
        { status: 'uncertain', attempt_no: 1, created_at: T }, { status: 'undelivered_expired', attempt_no: 1, created_at: T, modem_id: 'gsm2' },
        { status: 'rejected', attempt_no: 1, created_at: T }, { status: 'submitted', attempt_no: 1, created_at: T },
      ] });
      const one = await h.app.inject({ method: 'DELETE', url: '/api/sms/1', headers: { cookie } });
      assert.deepEqual([one.statusCode, one.json()], [200, { deleted: 1, status: 'failed' }]);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/sms/1', headers: { cookie } })).statusCode, 404);
      const again = await h.app.inject({ method: 'DELETE', url: '/api/sms/1', headers: { cookie } });
      assert.deepEqual([again.statusCode, again.json().code], [404, 'not-found']);
      const sending = await h.app.inject({ method: 'DELETE', url: '/api/sms/6', headers: { cookie } });
      assert.deepEqual([sending.statusCode, sending.json().code], [409, 'not-removable']);
      assert.match(sending.json().error, /SMS 6 is submitted/);
      assert.equal((await h.app.inject({ method: 'DELETE', url: '/api/sms/x', headers: { cookie } })).statusCode, 400);

      const gsm2 = await h.app.inject({ method: 'POST', url: '/api/sms/purge', headers: { cookie }, payload: { modem_id: 'gsm2' } });
      assert.deepEqual([gsm2.statusCode, gsm2.json()], [200, { deleted: 1 }]);
      const all = await h.app.inject({ method: 'POST', url: '/api/sms/purge', headers: { cookie } });
      assert.deepEqual([all.statusCode, all.json()], [200, { deleted: 2 }]);
      const stays = /** @type {any[]} */ (h.db.prepare('SELECT id, status FROM sms_outbox ORDER BY id').all()).map((row) => [row.id, row.status]);
      assert.deepEqual(stays, [[2, 'delivered'], [6, 'submitted']], 'the purge takes only the ones that ended without success');
      const delivered = await h.app.inject({ method: 'DELETE', url: '/api/sms/2', headers: { cookie } });
      assert.deepEqual([delivered.statusCode, delivered.json()], [200, { deleted: 2, status: 'delivered' }]);
      for (const payload of [{ modem_id: 'GSM 1' }, { modem_id: 'gsm1', extra: 1 }]) {
        assert.equal((await h.app.inject({ method: 'POST', url: '/api/sms/purge', headers: { cookie }, payload })).statusCode, 400, JSON.stringify(payload));
      }
    } finally {
      await h.stop();
    }
  });

  test('DELETE /api/messages/in/:id and POST /api/messages/purge delete what the list shows, with their events; one being sent stays', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const pending = { number: '+375290000007', text: 'hello pending', status: 'submitted', attempt_no: 1, created_at: T + 50 };
      h.seed({ messages: ROWS.messages, outbox: [...ROWS.outbox, pending], calls: ROWS.calls, notifications: ROWS.notifications });
      /** @param {'DELETE' | 'POST'} method @param {string} url @param {object} [payload] */
      const send = async (method, url, payload) => {
        const response = await h.app.inject({ method, url, headers: { cookie }, payload });
        return [response.statusCode, response.json()];
      };
      const events = () => /** @type {any[]} */ (h.db.prepare('SELECT id FROM events ORDER BY id').all()).map((row) => row.id);
      const texts = async () => (await h.app.inject({ method: 'GET', url: '/api/messages', headers: { cookie } })).json()
        .items.map((/** @type {any} */ item) => item.text);

      assert.deepEqual(await send('DELETE', '/api/messages/in/1'), [200, { deleted: 1 }]);
      assert.deepEqual(events(), ['c4', 'c5', 'm2', 'm3'], 'the spool event of the SMS goes with it');
      assert.deepEqual((await send('DELETE', '/api/messages/in/1'))[0], 404);
      assert.equal((await h.app.inject({ method: 'DELETE', url: '/api/messages/in/x', headers: { cookie } })).statusCode, 400);

      assert.deepEqual(await send('POST', '/api/messages/purge', { q: 'hello', before: T + 40 }), [200, { deleted: 2, kept: 0 }],
        'both halves by the filters, and nothing newer than `before`');
      assert.deepEqual(await texts(), ['hello pending', 'sent to three', 'from nobody']);
      assert.deepEqual(await send('POST', '/api/messages/purge', { status: 'submitted' }), [200, { deleted: 0, kept: 1 }],
        'a status reads only the outbox, and an SMS being sent is counted, not deleted');
      assert.deepEqual(await send('POST', '/api/messages/purge', { direction: 'out', modem: 'gsm1' }), [200, { deleted: 1, kept: 1 }]);
      assert.deepEqual(await send('POST', '/api/messages/purge', {}), [200, { deleted: 1, kept: 1 }]);
      assert.deepEqual(await texts(), ['hello pending']);
      assert.deepEqual(events(), ['c4', 'c5'], 'call events are not touched');
      assert.equal(Number(/** @type {any} */ (h.db.prepare('SELECT count(*) AS n FROM notifications').get()).n), 2, 'nor the Telegram log');

      for (const payload of [{ direction: 'sideways' }, { before: -1 }, { before: String(T) }, { modem: 'GSM 1' }, { extra: 1 }]) {
        assert.equal((await send('POST', '/api/messages/purge', payload))[0], 400, JSON.stringify(payload));
      }
    } finally {
      await h.stop();
    }
  });

  test('DELETE /api/calls/:id and POST /api/calls/purge delete calls by the list filters, with every event of the call', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      h.seed({ messages: ROWS.messages.slice(0, 1), calls: [...ROWS.calls, { caller: '+375290000008', outcome: 'missed', ended_at: T + 3 }] });
      // A repeated call-end of the first call: its event is stored, but it added no calls row.
      h.db.prepare("INSERT INTO events (id, kind, modem_id, uniqueid, emitted_at, received_at, fields_json) VALUES ('c2-again', 'call-end', 'gsm1', 'c2', 0, 0, '{}')").run();
      /** @param {'DELETE' | 'POST'} method @param {string} url @param {object} [payload] */
      const send = async (method, url, payload) => {
        const response = await h.app.inject({ method, url, headers: { cookie }, payload });
        return [response.statusCode, response.json()];
      };
      const events = () => /** @type {any[]} */ (h.db.prepare('SELECT id FROM events ORDER BY id').all()).map((row) => row.id);

      assert.deepEqual(await send('DELETE', '/api/calls/1'), [200, { deleted: 1 }]);
      assert.deepEqual(events(), ['c3', 'c4', 'm1'], 'both events of the call go with it');
      assert.deepEqual((await send('DELETE', '/api/calls/1'))[0], 404);
      assert.deepEqual(await send('POST', '/api/calls/purge', { outcome: 'missed', before: T + 2 }), [200, { deleted: 0 }]);
      assert.deepEqual(await send('POST', '/api/calls/purge', { q: '0000008' }), [200, { deleted: 1 }]);
      assert.deepEqual(await send('POST', '/api/calls/purge', {}), [200, { deleted: 1 }]);
      assert.deepEqual(events(), ['m1'], 'an SMS event is not touched');
      for (const payload of [{ outcome: 'maybe' }, { before: 1.5 }, { extra: 1 }]) {
        assert.equal((await send('POST', '/api/calls/purge', payload))[0], 400, JSON.stringify(payload));
      }
    } finally {
      await h.stop();
    }
  });

  test('POST /api/notify/test queues one test notification, and is refused without a usable token', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const without = await h.app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie }, payload: { chat_id: '100200300' } });
      assert.equal(without.statusCode, 400);
      assert.match(without.json().error, /no usable Telegram bot token/);

      h.secrets.set({ TELEGRAM_BOT_TOKEN: '123456789:AAE-bb_cc-dd_ee-ff' });
      const queued = await h.app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie }, payload: { chat_id: '-100200300' } });
      assert.equal(queued.statusCode, 202);
      const row = /** @type {any} */ (h.db.prepare('SELECT * FROM notifications WHERE id = ?').get(queued.json().id));
      assert.deepEqual([row.source_kind, row.chat_id, row.status, row.part_no], ['test', '-100200300', 'pending', 1]);
      assert.match(row.text, /^\[aster-test\] Aster test notification \[/);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie }, payload: { chat_id: 'me' } })).statusCode, 400);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie }, payload: {} })).statusCode, 400);

      // Only the queue's own refusals are the caller's fault; a store that cannot be written is a failure, not a bad request.
      h.db.exec('DROP TABLE notifications');
      const broken = await h.app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie }, payload: { chat_id: '100200300' } });
      assert.equal(broken.statusCode, 500);
      assert.match(broken.json().error, /^the controller failed to answer: /);
    } finally {
      await h.stop();
    }
  });
});
