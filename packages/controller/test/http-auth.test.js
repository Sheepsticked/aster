// @ts-check
// Tests for the admin password and its cookie session: src/http/auth.js, src/http/session.js, the login/logout/me routes and
// the gate that answers 401 for every other /api route without a session.
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, test } from 'node:test';
import { checkPassword, HASH_KEY, hashPassword, parseHash, verifyPassword } from '../src/http/auth.js';
import { COOKIE, cookieSessionId, createSessions, DEFAULTS as sessionDefaults, parseCookies } from '../src/http/session.js';
import { harness, PASSWORD, WEAK } from './http-harness.js';

/**
 * Sends a raw request line over its own socket and returns the status line and body: fastify.inject() cannot construct an
 * absolute-form request target (it always sends origin-form), so the gate's handling of one needs a real socket.
 * @param {string} url  from h.server.listen()
 * @param {string} requestLine  e.g. "GET http://x/api/settings HTTP/1.1"
 */
async function rawRequest(url, requestLine) {
  const { port } = new URL(url);
  const text = await new Promise((resolvePromise, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1');
    let out = '';
    socket.on('data', (chunk) => { out += chunk; });
    socket.on('end', () => resolvePromise(out));
    socket.on('error', reject);
    socket.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });
  const [statusLine, ...rest] = text.split('\r\n');
  const body = rest.slice(rest.indexOf('') + 1).join('\r\n');
  return { status: Number(statusLine.split(' ')[1]), body };
}

describe('http auth routes', () => {
  test('a hash carries its own parameters; verification is exact; a broken hash throws instead of failing open', async () => {
    const hash = await hashPassword('correct horse battery', WEAK);
    assert.match(hash, /^\$scrypt\$ln=4,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/, hash);
    const parsed = parseHash(hash);
    assert.deepEqual([parsed.ln, parsed.r, parsed.p, parsed.salt.length, parsed.key.length], [4, 8, 1, 16, 32]);
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('correct horse batteru', hash), false);
    assert.equal(await verifyPassword('', hash), false);
    assert.notEqual(await hashPassword('correct horse battery', WEAK), hash, 'a fresh salt each time');
    // A hash written with the production parameters verifies with them, whatever the caller's defaults are.
    const strong = `$scrypt$ln=5,r=8,p=1$${parsed.salt.toString('base64').replace(/=+$/, '')}$`;
    assert.throws(() => parseHash(strong), /not a scrypt hash/);
    for (const bad of ['', 'plain', '$scrypt$ln=15,r=8$c2FsdA$aGFzaA', '$scrypt$ln=99,r=8,p=1$c2FsdA$aGFzaA', '$scrypt$ln=15,r=0,p=1$c2FsdA$aGFzaA', 42, null]) {
      assert.throws(() => parseHash(/** @type {any} */ (bad)), { name: 'TypeError' }, JSON.stringify(bad));
    }
    assert.equal(checkPassword('1'), null);
    assert.match(String(checkPassword('')), /must not be empty/);
    assert.match(String(checkPassword('x'.repeat(257))), /at most 256 characters/);
    assert.match(String(checkPassword('abc\tdefgh')), /control characters/);
    assert.match(String(checkPassword(/** @type {any} */ (7))), /must be a string/);
    await assert.rejects(hashPassword(''), /must not be empty/);
  });

  test('cookies: the session id is read from the header, and only a well-formed one reaches the database', async () => {
    assert.deepEqual([...parseCookies(`a=1; ${COOKIE}="xyz"; b=2`)], [['a', '1'], [COOKIE, 'xyz'], ['b', '2']]);
    assert.deepEqual([...parseCookies(undefined)], []);
    assert.deepEqual([...parseCookies('novalue; =empty; a=1; a=2')], [['a', '1']], 'the first value of a name wins; a nameless part is skipped');
    assert.equal(cookieSessionId(`${COOKIE}=${'a'.repeat(43)}`), 'a'.repeat(43));
    for (const bad of [`${COOKIE}=short`, `${COOKIE}=${'a'.repeat(44)}`, `${COOKIE}=${'a'.repeat(42)}$`, 'other=x', '']) {
      assert.equal(cookieSessionId(bad), null, bad);
    }
  });

  test('sessions expire after 30 days, last_seen_at is written at most once every 15 min, clear() ends every one', async () => {
    const h = await harness();
    try {
      // Limits SD card writes: a browser left open on a polling page must not write a row every minute.
      assert.equal(sessionDefaults.touchMs, 900_000);
      let at = 1_700_000_000_000;
      const sessions = createSessions({ db: h.db, now: () => at, timing: { maxAgeMs: 1000, touchMs: 100 } });
      const session = sessions.create();
      assert.match(session.id, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(sessions.get(session.id)?.created_at, at);
      at += 50;
      assert.equal(sessions.touch(session), false, 'too soon to write');
      at += 60;
      assert.equal(sessions.touch(session), true);
      assert.equal(sessions.get(session.id)?.last_seen_at, at);
      assert.equal(sessions.count(), 1);
      at += 1001;
      assert.equal(sessions.get(session.id), null, 'expired: 30 days after it was created, whatever last_seen_at says');
      assert.equal(sessions.count(), 0, 'and the row is gone');
      const other = sessions.create();
      assert.equal(sessions.destroy(other.id), true);
      assert.equal(sessions.destroy(other.id), false);
      sessions.create();
      at += 5000;
      assert.equal(sessions.purge(), 1);
      assert.equal(sessions.clear(), 0);
      assert.match(sessions.cookie('x'), /^aster_sid=x; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1$/);
      assert.match(sessions.expiredCookie(), /^aster_sid=; .*Max-Age=0$/);
    } finally {
      await h.stop();
    }
  });

  test('login sets the cookie, me answers with it, logout ends the session and expires the cookie', async () => {
    const h = await harness();
    try {
      const { response, cookie } = await h.login();
      assert.equal(response.statusCode, 200);
      const setCookie = String(response.headers['set-cookie']);
      assert.match(setCookie, /^aster_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
      assert.ok(!/Secure/.test(setCookie), 'plain HTTP on the LAN');
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.session.expires_at, body.session.created_at + 30 * 24 * 3600 * 1000);
      assert.equal(body.session.id, undefined, 'the id stays in the cookie');
      assert.equal(h.server.sessions.count(), 1);

      const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().authenticated, true);

      const out = await h.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
      assert.equal(out.statusCode, 200);
      assert.match(String(out.headers['set-cookie']), /^aster_sid=; .*Max-Age=0/);
      assert.equal(h.server.sessions.count(), 0);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401, 'the cookie is worthless now');
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/logout' })).statusCode, 200, 'logout works without a session, so a stale cookie can always be dropped');
    } finally {
      await h.stop();
    }
  });

  test('a wrong password is 401 and creates nothing; a missing or unreadable hash is 503, never a login', async () => {
    const h = await harness();
    try {
      const wrong = await h.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'not it' } });
      assert.equal(wrong.statusCode, 401);
      assert.deepEqual(wrong.json(), { error: 'wrong password' });
      assert.equal(wrong.headers['set-cookie'], undefined);
      assert.equal(h.server.sessions.count(), 0);
      for (const payload of [{}, { password: '' }, { password: 'x', extra: 1 }, { password: 7 }]) {
        const bad = await h.app.inject({ method: 'POST', url: '/api/login', payload });
        assert.equal(bad.statusCode, 400, JSON.stringify(payload));
        assert.match(bad.json().error, /invalid request/);
      }
      h.secrets.set({ [HASH_KEY]: 'not-a-hash' });
      const broken = await h.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
      assert.equal(broken.statusCode, 503);
      assert.match(broken.json().error, /not a usable scrypt hash/);
    } finally {
      await h.stop();
    }
    const empty = await harness({ password: null });
    try {
      const response = await empty.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
      assert.equal(response.statusCode, 503);
      assert.match(response.json().error, /no admin password is set/);
    } finally {
      await empty.stop();
    }
  });

  test('every /api route needs a session; health, login and logout do not; an unknown cookie is dropped', async () => {
    const h = await harness();
    try {
      for (const [method, url] of /** @type {const} */ ([['GET', '/api/me'], ['GET', '/api/overview'], ['GET', '/api/settings'],
        ['PUT', '/api/settings'], ['GET', '/api/events'], ['POST', '/api/anything'],
        ['GET', '/api/modems'], ['POST', '/api/modems'], ['GET', '/api/modems/gsm1'], ['PUT', '/api/modems/gsm1'],
        ['DELETE', '/api/modems/gsm1'], ['POST', '/api/modems/gsm1/start'], ['POST', '/api/modems/gsm1/stop'],
        ['POST', '/api/modems/gsm1/restart'], ['POST', '/api/modems/gsm1/reset'], ['POST', '/api/modems/gsm1/remap'],
        ['GET', '/api/modems/gsm1/forwarding'], ['POST', '/api/modems/gsm1/forwarding'], ['POST', '/api/modems/gsm1/at'],
        ['POST', '/api/modems/gsm1/ussd'], ['POST', '/api/modems/gsm1/ussd/cancel'], ['GET', '/api/phones'], ['POST', '/api/phones'], ['GET', '/api/phones/596'],
        ['PUT', '/api/phones/596'], ['DELETE', '/api/phones/596'], ['POST', '/api/scan'], ['GET', '/api/scan/latest'],
        ['GET', '/api/messages'], ['POST', '/api/sms'], ['GET', '/api/sms/1'], ['POST', '/api/sms/1/retry'], ['DELETE', '/api/sms/1'], ['POST', '/api/sms/purge'], ['GET', '/api/calls'],
        ['GET', '/api/notifications'], ['POST', '/api/notify/test'], ['GET', '/api/config/files'],
        ['GET', '/api/config/files/extensions.conf'], ['PUT', '/api/config/files/extensions.conf'],
        ['POST', '/api/config/files/extensions.conf/restore'], ['GET', '/api/operations'], ['GET', '/api/operations/1'],
        ['GET', '/api/logs/asterisk'], ['GET', '/api/logs/controller'], ['GET', '/api/backup']])) {
        const response = await h.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
        assert.equal(response.statusCode, 401, `${method} ${url}`);
        assert.deepEqual(response.json(), { error: 'not logged in' });
      }
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
      const stale = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${COOKIE}=${'a'.repeat(43)}` } });
      assert.equal(stale.statusCode, 401);
      assert.match(String(stale.headers['set-cookie']), /Max-Age=0/, 'the browser is told to drop a session that no longer exists');
      const { cookie } = await h.login();
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).statusCode, 200);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/settings/', headers: { cookie } })).statusCode, 200, 'a trailing slash is the same route');
    } finally {
      await h.stop();
    }
  });

  test('an absolute-form request target cannot skip the session gate', async () => {
    // The router strips scheme+authority from "GET http://x/api/settings" but the gate sees the raw URL, so without the
    // guard in server.js the request would reach the protected handler unauthenticated.
    const h = await harness();
    try {
      const url = await h.server.listen();
      const control = await rawRequest(url, 'GET /api/settings HTTP/1.1');
      assert.equal(control.status, 401, 'a plain, unauthenticated request is refused as before');
      const bypass = await rawRequest(url, 'GET http://x/api/settings HTTP/1.1');
      assert.equal(bypass.status, 400, 'the absolute-form target itself is refused, not routed');
      assert.doesNotMatch(bypass.body, /ui_language/, 'no settings leaked');
    } finally {
      await h.stop();
    }
  });
});
