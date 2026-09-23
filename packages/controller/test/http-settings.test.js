// @ts-check
// Tests for GET and PUT /api/settings: secrets never shown, registry fields via registry-apply, the Telegram token and
// password in secrets.env, and nothing written unless the whole request is valid.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { verifyPassword } from '../src/http/auth.js';
import { harness, PASSWORD, snapshot } from './http-harness.js';

const TOKEN = '123456789:AAE-bb_cc-dd_ee-ff';

describe('http settings routes', () => {
  test('GET answers the registry settings and whether a token and a password are set, never their values', async () => {
    const h = await harness({ secrets: { TELEGRAM_BOT_TOKEN: TOKEN } });
    try {
      const { cookie } = await h.login();
      const body = (await h.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json();
      assert.deepEqual(body, {
        ui_language: 'ru',
        timezone: 'Europe/Istanbul',
        retention_days: { operations: 90, notifications: 45 },
        default_recipients: ['100200300'],
        alerts: false,
        telegram_token_set: true,
        password_set: true,
        registry: { present: true, hash: h.onDisk().hash },
      });
      assert.equal(JSON.stringify(body).includes(TOKEN), false, 'the token value never leaves the controller');
      assert.equal(JSON.stringify(body).includes('scrypt'), false);
    } finally {
      await h.stop();
    }
    const fresh = await harness({ registry: null, password: null });
    try {
      const { cookie } = await fresh.login();
      assert.equal((await fresh.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } })).statusCode, 503);
      assert.equal(cookie, '', 'without a password nobody can log in');
      const body = (await fresh.app.inject({ method: 'GET', url: '/api/settings' })).json();
      assert.deepEqual(body, { error: 'not logged in' }, 'and the settings stay behind the gate');
    } finally {
      await fresh.stop();
    }
  });

  test('PUT applies the registry fields as one registry-apply with the file hash; unchanged values apply nothing', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const before = h.onDisk().hash;
      const response = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie },
        payload: { ui_language: 'en', timezone: 'UTC', retention_days: { operations: 30 }, default_recipients: ['-100200300', '42'], alerts: true } });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual(body.changed, ['ui_language', 'timezone', 'retention_days', 'default_recipients', 'alerts']);
      assert.deepEqual([body.ok, body.operation.status, body.sessions_cleared], [true, 'done', 0]);
      assert.equal(h.applies.length, 1);
      const params = /** @type {any} */ (h.applies[0]);
      assert.deepEqual([params.base_hash, params.force], [before, false]);
      assert.deepEqual(params.registry.settings, { ui_language: 'en', timezone: 'UTC', retention_days: { operations: 30, notifications: 45 } },
        'a partial retention_days keeps the other span, which is not the default either');
      assert.deepEqual(params.registry.telegram, { default_recipients: ['-100200300', '42'], alerts: true });
      assert.equal(params.registry.modems.length, 1, 'the rest of the registry is carried through unchanged');
      const disk = h.onDisk().registry;
      assert.deepEqual([disk.settings.ui_language, disk.telegram.alerts], ['en', true]);
      assert.deepEqual(body.settings.registry.hash, h.onDisk().hash);

      const again = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { ui_language: 'en', alerts: true } });
      assert.equal(again.statusCode, 200);
      assert.deepEqual([again.json().changed, again.json().operation], [[], null], 'nothing to apply, so no operation');
      assert.equal(h.applies.length, 1);
    } finally {
      await h.stop();
    }
  });

  test('the Telegram token is written to and cleared from secrets.env; a token that is not one is refused', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      let response = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { telegram_token: TOKEN } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().changed, ['telegram_token']);
      assert.equal(response.json().settings.telegram_token_set, true);
      assert.match(h.secretsText(), /^TELEGRAM_BOT_TOKEN=123456789:AAE-bb_cc-dd_ee-ff$/m);
      assert.match(h.secretsText(), /^# Aster secrets$/m, 'the comments and the other keys of the file are kept');
      assert.equal(h.secrets.get().TELEGRAM_BOT_TOKEN, TOKEN, 'the store the notification queue reads is current');
      assert.equal(h.applies.length, 0, 'a token is not a registry change');

      response = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { telegram_token: null } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().settings.telegram_token_set, false);
      assert.equal(/TELEGRAM_BOT_TOKEN/.test(h.secretsText()), false, 'the line is removed, not emptied');
      assert.equal(h.secrets.get().TELEGRAM_BOT_TOKEN, undefined);
      assert.match(h.secretsText(), /^ASTER_AMI_SECRET=ami-secret$/m);

      response = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { telegram_token: 'nonsense' } });
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /telegram_token must be a bot token/);
    } finally {
      await h.stop();
    }
  });

  test('a password change needs the current password and ends every session, the caller\'s included', async () => {
    const h = await harness();
    try {
      const first = await h.login();
      const second = await h.login();
      assert.equal(h.server.sessions.count(), 2);

      const wrong = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: first.headers,
        payload: { password: { current: 'not it', next: 'a new long password' } } });
      assert.equal(wrong.statusCode, 401);
      assert.equal(wrong.json().error, 'the current password is wrong');
      assert.equal(h.server.sessions.count(), 2, 'a refused change ends nothing');

      const empty = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: first.headers,
        payload: { password: { current: PASSWORD, next: '' } } });
      assert.equal(empty.statusCode, 400);

      // One character is a password like any other.
      const response = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: first.headers,
        payload: { password: { current: PASSWORD, next: 'z' }, ui_language: 'en' } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual([response.json().changed, response.json().sessions_cleared], [['ui_language', 'password'], 2]);
      assert.match(String(response.headers['set-cookie']), /Max-Age=0/);
      assert.equal(h.server.sessions.count(), 0);
      for (const cookie of [first.cookie, second.cookie]) {
        assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
      }
      assert.equal(await verifyPassword('z', String(h.secrets.get().ASTER_ADMIN_PASSWORD_HASH)), true);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } })).statusCode, 401);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'z' } })).statusCode, 200);
    } finally {
      await h.stop();
    }
  });

  test('an invalid request writes nothing at all; a failed apply leaves the secrets untouched', async () => {
    const h = await harness();
    try {
      const { cookie, headers } = await h.login();
      const before = { rows: snapshot(h.db), secrets: h.secretsText(), registry: h.onDisk().hash };
      for (const [payload, status] of /** @type {const} */ ([
        [{}, 400], [{ unknown: 1 }, 400], [{ ui_language: 'de' }, 400], [{ retention_days: { operations: 0 } }, 400],
        [{ default_recipients: ['not a chat id'] }, 400], [{ alerts: 'yes' }, 400], [{ timezone: 'Mars/Olympus Mons' }, 400],
        [{ password: { current: PASSWORD } }, 400],
      ])) {
        const response = await h.app.inject({ method: 'PUT', url: '/api/settings', headers, payload });
        assert.equal(response.statusCode, status, JSON.stringify(payload));
        assert.ok(response.json().error, JSON.stringify(payload));
      }
      const invalid = await h.app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { timezone: 'Mars/Olympus Mons' } });
      assert.match(invalid.json().error, /the settings are invalid: 1 problem/);
      assert.equal(invalid.json().problems[0].path, 'settings.timezone');
      assert.deepEqual([h.applies.length, snapshot(h.db), h.secretsText(), h.onDisk().hash],
        [0, before.rows, before.secrets, before.registry], 'nothing was written by any of them');

      h.applyMode('fail');
      const failed = await h.app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { alerts: true, telegram_token: TOKEN } });
      assert.equal(failed.statusCode, 409);
      assert.deepEqual([failed.json().ok, failed.json().error, failed.json().changed], [false, 'the reload failed', []]);
      assert.equal(failed.json().operation.status, 'failed');
      assert.equal(h.secretsText(), before.secrets, 'the token was not written after the apply failed');
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json().telegram_token_set, false);
    } finally {
      await h.stop();
    }
  });

  test('an apply that has not finished is 202 with the operation, and the secrets stay untouched', async () => {
    const h = await harness({ timing: { applyWaitMs: 60 } });
    try {
      const { headers } = await h.login();
      h.applyMode('hang');
      const response = await h.app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { alerts: true, telegram_token: TOKEN } });
      assert.equal(response.statusCode, 202);
      assert.match(response.json().error, /still being applied after 60 ms/);
      assert.deepEqual([response.json().operation.status, response.json().changed], ['running', []]);
      assert.equal(/TELEGRAM_BOT_TOKEN/.test(h.secretsText()), false);
      const op = h.runner.get(response.json().operation.id);
      assert.equal(op?.status, 'running');
    } finally {
      h.release();
      await h.stop();
    }
  });
});
