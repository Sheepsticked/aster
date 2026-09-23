// @ts-check
// Tests for the server itself: serving the SPA inside the UI directory, the JSON 404, body rules, handler failures, and
// that no GET route changes a row.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BODY_LIMIT, resolveUnder } from '../src/http/server.js';
import { harness, snapshot } from './http-harness.js';

/** @param {string} dir */
function buildUi(dir) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Aster</title>');
  writeFileSync(join(dir, 'assets', 'app-1234.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'assets', 'style.css'), 'body { margin: 0 }\n');
  writeFileSync(join(dir, 'assets', 'a name.txt'), 'percent-encoded\n');
  return dir;
}

describe('http server', () => {
  test('resolveUnder(): every path is rooted at the UI directory, so `..` cannot climb out of it', () => {
    assert.equal(resolveUnder('/ui', '/assets/app.js'), '/ui/assets/app.js');
    assert.equal(resolveUnder('/ui', '/'), '/ui');
    assert.equal(resolveUnder('/ui', '/a/../b'), '/ui/b');
    assert.equal(resolveUnder('/ui', '/../etc/passwd'), '/ui/etc/passwd', 'the leading .. is normalized away before the join');
    assert.equal(resolveUnder('/ui', '/a/../../etc/passwd'), '/ui/etc/passwd');
    assert.equal(resolveUnder('/ui', 'assets/app.js'), '/ui/assets/app.js');
    assert.equal(resolveUnder('/ui', '/\0.js'), null, 'a NUL never reaches the filesystem');
    for (const path of ['/x', '/../x', '/./..//x', '/%2e%2e/x']) {
      assert.equal(String(resolveUnder('/ui', path)).startsWith('/ui/'), true, path);
    }
  });

  test('the SPA is served with its fallback, without a session, and never from outside its directory', async () => {
    const h = await harness({ uiDir: buildUi(join(process.env.TMPDIR ?? '/tmp', `aster-ui-${process.pid}`)) });
    try {
      const index = await h.app.inject({ method: 'GET', url: '/' });
      assert.equal(index.statusCode, 200);
      assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(index.headers['cache-control'], 'no-store');
      assert.match(index.body, /<title>Aster<\/title>/);

      const asset = await h.app.inject({ method: 'GET', url: '/assets/app-1234.js' });
      assert.equal(asset.statusCode, 200);
      assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal(asset.headers['cache-control'], 'public, max-age=3600');
      assert.equal(asset.body, 'export const a = 1;\n');
      assert.equal((await h.app.inject({ method: 'GET', url: '/assets/style.css' })).headers['content-type'], 'text/css; charset=utf-8');
      const encoded = await h.app.inject({ method: 'GET', url: '/assets/a%20name.txt' });
      assert.equal(encoded.body, 'percent-encoded\n', 'the path is decoded before the file is looked up');

      for (const url of ['/modems', '/settings/deep/link', '/assets/missing.js']) {
        const response = await h.app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 200, url);
        assert.match(response.body, /<title>Aster<\/title>/, `${url} falls back to index.html`);
      }
      const escaped = await h.app.inject({ method: 'GET', url: '/../../etc/hostname' });
      assert.equal(escaped.statusCode, 200);
      assert.match(escaped.body, /<title>Aster<\/title>/, 'a path outside the directory is the SPA, never a file');
      const broken = await h.app.inject({ method: 'GET', url: '/%zz' });
      assert.equal(broken.statusCode, 400);
      assert.equal((await h.app.inject({ method: 'POST', url: '/modems' })).statusCode, 404, 'only GET reaches the SPA');
    } finally {
      await h.stop();
    }
    const none = await harness();
    try {
      const response = await none.app.inject({ method: 'GET', url: '/' });
      assert.equal(response.statusCode, 503);
      assert.match(response.json().error, /the web UI is not part of this build/);
    } finally {
      await none.stop();
    }
  });

  test('an unknown endpoint is a JSON 404; a body is JSON or nothing and at most 1 MB', async () => {
    const h = await harness();
    try {
      const { headers } = await h.login();
      const unknown = await h.app.inject({ method: 'GET', url: '/api/nothing/here', headers });
      assert.equal(unknown.statusCode, 404);
      assert.deepEqual(unknown.json(), { error: 'unknown endpoint: GET /api/nothing/here' });
      assert.equal((await h.app.inject({ method: 'DELETE', url: '/api/settings', headers })).statusCode, 404);

      const form = await h.app.inject({ method: 'POST', url: '/api/login', headers: { 'content-type': 'text/plain' }, payload: 'password=x' });
      assert.equal(form.statusCode, 415);
      assert.match(form.json().error, /must be application\/json/);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/logout' })).statusCode, 200, 'a POST without a body is allowed');

      const big = await h.app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { timezone: 'x'.repeat(BODY_LIMIT + 10) } });
      assert.equal(big.statusCode, 413);
      assert.equal(BODY_LIMIT, 1024 * 1024);
    } finally {
      await h.stop();
    }
  });

  test('a handler that fails is a 500 in JSON, and the failure is logged, not leaked as a stack', async () => {
    const h = await harness();
    try {
      const { headers } = await h.login();
      chmodSync(h.paths.registry, 0o000);
      const response = await h.app.inject({ method: 'GET', url: '/api/settings', headers });
      chmodSync(h.paths.registry, 0o644);
      assert.equal(response.statusCode, 500);
      assert.match(response.json().error, /^the controller failed to answer: cannot read registry /);
      assert.equal(/at .*\.js:\d+/.test(response.json().error), false, 'no stack in the answer');
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/settings', headers })).statusCode, 200, 'and the server is still up');
    } finally {
      await h.stop();
    }
  });

  test('no GET route writes a row (the session touch aside, which is at most once every 15 min)', async () => {
    const h = await harness({ devices: { states: () => new Map(), stateOf: () => 'unverified' }, scan: { latest: () => null } });
    try {
      const { headers } = await h.login();
      const before = snapshot(h.db, { sessions: true });
      for (const url of ['/api/health', '/api/me', '/api/overview', '/api/settings', '/api/modems', '/api/modems/gsm1',
        '/api/modems/gsm1/forwarding', '/api/phones', '/api/phones/596', '/api/scan/latest', '/api/messages?q=x', '/api/calls',
        '/api/notifications', '/api/operations', '/api/config/files', '/api/config/files/extensions.conf',
        '/api/logs/controller', '/api/backup']) {
        for (const method of /** @type {const} */ (['GET', 'HEAD'])) {
          const response = await h.app.inject({ method, url, headers });
          assert.ok(response.statusCode < 400, `${method} ${url} → ${response.statusCode}`);
        }
      }
      assert.equal(snapshot(h.db, { sessions: true }), before, 'not one row changed, the session row included');
    } finally {
      await h.stop();
    }
  });
});
