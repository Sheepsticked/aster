// @ts-check
// Contract tests for the configuration file and log routes: the file list, read-only generated files, the operations PUT
// and restore enqueue, and the log tails.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assertModule from 'node:assert';
import { describe, test } from 'node:test';
import { sha256 } from '../src/config/atomic.js';
import { MAX_LINES } from '../src/http/routes/logs.js';
import { harness, snapshot } from './http-harness.js';

const EXTENSIONS = '[aster-hand]\nexten => 100,1,Hangup()\n';

describe('http config routes', () => {
  test('the file list carries the hash, the status, the restore and the restart of every hand-owned and generated file', async () => {
    const h = await harness({ prev: { 'extensions.conf': '[aster-hand]\n' } });
    try {
      const { cookie } = await h.login();
      const before = snapshot(h.db);
      const body = (await h.app.inject({ method: 'GET', url: '/api/config/files', headers: { cookie } })).json();
      /** @param {string} name */
      const of = (name) => body.files.find((/** @type {any} */ file) => file.name === name);

      assert.equal(body.dir, h.paths.asteriskConfig);
      assert.deepEqual(of('extensions.conf'), { name: 'extensions.conf', kind: 'hand', editable: true, present: true,
        hash: sha256(EXTENSIONS), size: EXTENSIONS.length, modified_at: of('extensions.conf').modified_at, status: 'applied',
        applied_hash: null, matches_registry: null, restorable: true, restart_required: false, reload: ['Command: dialplan reload'] });
      assert.deepEqual([of('pjsip.conf').present, of('pjsip.conf').status, of('pjsip.conf').restorable], [false, 'missing', false]);
      assert.deepEqual([of('asterisk.conf').restart_required, of('modules.conf').restart_required], [true, true]);
      assert.deepEqual([of('aster.d/modems.conf').kind, of('aster.d/modems.conf').editable, of('aster.d/modems.conf').status],
        ['generated', false, 'missing']);
      assert.equal(of('manager.conf'), undefined, 'manager.conf is install.sh\'s and is never applied by the controller');
      assert.equal(snapshot(h.db), before, 'a GET writes nothing');

      // A generated file that is on disk says whether it is still what the registry produces.
      const { generateAll } = await import('../src/config/generators.js');
      const generated = generateAll(h.onDisk().registry);
      writeFileSync(join(h.paths.asteriskConfig, 'aster.d', 'modems.conf'), String(generated['aster.d/modems.conf']));
      let files = (await h.app.inject({ method: 'GET', url: '/api/config/files', headers: { cookie } })).json().files;
      assert.deepEqual(files.find((/** @type {any} */ f) => f.name === 'aster.d/modems.conf').matches_registry, true);
      writeFileSync(join(h.paths.asteriskConfig, 'aster.d', 'modems.conf'), '; edited by hand\n');
      files = (await h.app.inject({ method: 'GET', url: '/api/config/files', headers: { cookie } })).json().files;
      assert.deepEqual(files.find((/** @type {any} */ f) => f.name === 'aster.d/modems.conf').matches_registry, false);
    } finally {
      await h.stop();
    }
  });

  test('GET one file answers its content and hash; an unknown name is 404 and a missing file is 404 with its entry', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const file = (await h.app.inject({ method: 'GET', url: '/api/config/files/extensions.conf', headers: { cookie } })).json();
      assert.deepEqual([file.name, file.content, file.hash], ['extensions.conf', EXTENSIONS, sha256(EXTENSIONS)]);

      const generated = await h.app.inject({ method: 'GET', url: '/api/config/files/aster.d/quectel-devices.conf', headers: { cookie } });
      assert.equal(generated.statusCode, 404, 'a generated file that has not been written yet');
      assert.equal(generated.json().file.kind, 'generated');
      for (const name of ['nonsense.conf', 'manager.conf', 'aster.d/nonsense.conf']) {
        const response = await h.app.inject({ method: 'GET', url: `/api/config/files/${name}`, headers: { cookie } });
        assert.equal(response.statusCode, 404, name);
        assert.match(response.json().error, /no configuration file/);
      }
      // A name is only ever one of the reload map's; a traversal is refused by the router's own normalization before that.
      for (const name of ['../secrets.env', 'aster.d/../../secrets.env', '%2e%2e%2fsecrets.env', 'aster.d%2f..%2fextensions.conf']) {
        const response = await h.app.inject({ method: 'GET', url: `/api/config/files/${name}`, headers: { cookie } });
        assert.equal(response.statusCode, 404, name);
        assert.equal(response.json().content, undefined, name);
      }
    } finally {
      await h.stop();
    }
  });

  test('PUT enqueues config-apply with the content, the base hash and the restart flag; a generated file is refused', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const base = sha256(EXTENSIONS);
      const next = `${EXTENSIONS}exten => 101,1,Hangup()\n`;
      const response = await h.app.inject({ method: 'PUT', url: '/api/config/files/extensions.conf', headers: { cookie },
        payload: { content: next, base_hash: base } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual([response.json().ok, response.json().operation.kind, response.json().operation.status], [true, 'config-apply', 'done']);
      assert.deepEqual(h.opsOf('config-apply')[0]?.params, { name: 'extensions.conf', content: next, base_hash: base, force: false, restart: false });
      assert.equal(readFileSync(join(h.paths.asteriskConfig, 'extensions.conf'), 'utf8'), next);
      assert.equal(response.json().operation.result.hash, sha256(next));

      const restart = await h.app.inject({ method: 'PUT', url: '/api/config/files/modules.conf', headers: { cookie },
        payload: { content: '[modules]\n', base_hash: null, restart: true, force: true } });
      assert.equal(restart.statusCode, 200);
      assert.deepEqual(h.opsOf('config-apply')[1]?.params, { name: 'modules.conf', content: '[modules]\n', base_hash: null, force: true, restart: true });

      const refused = await h.app.inject({ method: 'PUT', url: '/api/config/files/aster.d/modems.conf', headers: { cookie }, payload: { content: 'x' } });
      assert.equal(refused.statusCode, 409);
      assert.match(refused.json().error, /generated from config\/aster\.yaml and cannot be edited/);
      assert.equal((await h.app.inject({ method: 'PUT', url: '/api/config/files/nonsense.conf', headers: { cookie }, payload: { content: 'x' } })).statusCode, 404);
      for (const payload of [{}, { content: 1 }, { content: 'x', base_hash: 'nope' }, { content: 'x', extra: 1 }]) {
        assert.equal((await h.app.inject({ method: 'PUT', url: '/api/config/files/extensions.conf', headers: { cookie }, payload })).statusCode, 400, JSON.stringify(payload));
      }
      assert.equal(h.opsOf('config-apply').length, 2, 'nothing invalid was enqueued');
    } finally {
      await h.stop();
    }
  });

  test('an apply that fails is 409 with the operation, and one still running is 202', async () => {
    const h = await harness({ timing: { applyWaitMs: 60 } });
    try {
      const { cookie } = await h.login();
      h.applyMode('fail', 'config-apply');
      const failed = await h.app.inject({ method: 'PUT', url: '/api/config/files/extensions.conf', headers: { cookie }, payload: { content: 'x' } });
      assert.deepEqual([failed.statusCode, failed.json().ok, failed.json().error], [409, false, 'config-apply failed']);
      assert.equal(failed.json().operation.status, 'failed');

      h.applyMode('hang', 'config-apply');
      const running = await h.app.inject({ method: 'PUT', url: '/api/config/files/extensions.conf', headers: { cookie }, payload: { content: 'y' } });
      assert.equal(running.statusCode, 202);
      assert.match(running.json().error, /extensions\.conf is still being applied after 60 ms/);
      assert.equal(h.runner.get(running.json().operation.id)?.status, 'running');
      assert.equal(readFileSync(join(h.paths.asteriskConfig, 'extensions.conf'), 'utf8'), EXTENSIONS, 'the operation writes the file, so neither of them changed it');
    } finally {
      h.release();
      await h.stop();
    }
  });

  test('restore enqueues config-restore only for a file with a previous version', async () => {
    const h = await harness({ prev: { 'extensions.conf': '[aster-hand]\n' } });
    try {
      const { cookie } = await h.login();
      const response = await h.app.inject({ method: 'POST', url: '/api/config/files/extensions.conf/restore', headers: { cookie }, payload: { base_hash: sha256(EXTENSIONS) } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(h.opsOf('config-restore')[0]?.params, { name: 'extensions.conf', base_hash: sha256(EXTENSIONS), restart: false });

      const without = await h.app.inject({ method: 'POST', url: '/api/config/files/pjsip.conf/restore', headers: { cookie } });
      assert.equal(without.statusCode, 409);
      assert.match(without.json().error, /no previous version of pjsip\.conf is stored/);
      assert.equal((await h.app.inject({ method: 'POST', url: '/api/config/files/nonsense.conf/restore', headers: { cookie } })).statusCode, 404);
      assert.equal(h.opsOf('config-restore').length, 1);

      // After an apply through the controller, "changed on disk" is what the list compares with.
      writeFileSync(join(h.paths.asteriskConfig, 'extensions.conf'), '[aster-hand]\n; by hand\n');
      const files = (await h.app.inject({ method: 'GET', url: '/api/config/files', headers: { cookie } })).json().files;
      const entry = files.find((/** @type {any} */ f) => f.name === 'extensions.conf');
      assert.deepEqual([entry.status, entry.applied_hash === entry.hash], ['modified', false]);
    } finally {
      await h.stop();
    }
  });
});

describe('http log routes', () => {
  test('the Asterisk log answers its newest lines with lines and grep; a log that is not there is 503', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const missing = await h.app.inject({ method: 'GET', url: '/api/logs/asterisk', headers: { cookie } });
      assert.equal(missing.statusCode, 503);
      assert.match(missing.json().error, /does not exist; the Asterisk container writes it/);

      const lines = Array.from({ length: 500 }, (_, i) => `[2026-09-12 10:00:00] ${i % 5 === 0 ? 'WARNING' : 'NOTICE'}[1] chan_quectel.c: line ${i}`);
      writeFileSync(h.paths.asteriskLog, `${lines.join('\n')}\n`);
      const body = (await h.app.inject({ method: 'GET', url: '/api/logs/asterisk', headers: { cookie } })).json();
      assert.deepEqual([body.lines.length, body.file, body.truncated], [200, h.paths.asteriskLog, false]);
      assert.equal(body.lines[199], lines[499], 'the newest line is last');
      assert.equal(body.lines[0], lines[300]);

      const few = (await h.app.inject({ method: 'GET', url: '/api/logs/asterisk?lines=3', headers: { cookie } })).json();
      assert.deepEqual(few.lines, lines.slice(-3));
      const grepped = (await h.app.inject({ method: 'GET', url: '/api/logs/asterisk?lines=4&grep=WARNING', headers: { cookie } })).json();
      assert.deepEqual(grepped.lines, [lines[480], lines[485], lines[490], lines[495]]);
      assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/logs/asterisk?grep=nothing here', headers: { cookie } })).json().lines, []);
      const capped = (await h.app.inject({ method: 'GET', url: '/api/logs/asterisk?lines=9999', headers: { cookie } })).json();
      assert.deepEqual([capped.lines.length, capped.limit], [500, MAX_LINES], `the file has 500 lines and at most ${MAX_LINES} are read`);
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/logs/asterisk?lines=abc', headers: { cookie } })).statusCode, 400);
    } finally {
      await h.stop();
    }
  });

  test('a log longer than the tail window is read from its end, and the half line at the start is dropped', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      const filler = 'x'.repeat(1000);
      const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${filler}`); // ~2 MB, more than the 1 MB window
      writeFileSync(h.paths.asteriskLog, `${lines.join('\n')}\n`);
      const body = (await h.app.inject({ method: 'GET', url: '/api/logs/asterisk?lines=2000', headers: { cookie } })).json();
      assert.equal(body.truncated, true);
      assert.ok(body.lines.length > 900 && body.lines.length < 1100, `about a megabyte of lines, got ${body.lines.length}`);
      assert.equal(body.lines[body.lines.length - 1], lines[1999]);
      assert.ok(body.lines.every((/** @type {string} */ line) => line.startsWith('line ')), 'no half line is returned');
      assert.equal(body.size, `${lines.join('\n')}\n`.length);
    } finally {
      await h.stop();
    }
  });

  test('the controller log answers the ring buffer the logger writes to', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      for (let i = 0; i < 60; i += 1) h.logRing.write(`${JSON.stringify({ ts: 'now', level: i % 2 === 0 ? 'info' : 'warn', msg: `line ${i}` })}\n`);
      const body = (await h.app.inject({ method: 'GET', url: '/api/logs/controller', headers: { cookie } })).json();
      assert.deepEqual([body.kept, body.capacity, body.dropped], [50, 50, 10], 'the ring keeps the newest lines and says how many it dropped');
      assert.equal(body.lines.length, 50);
      assert.match(body.lines[49], /line 59/);
      h.logRing.write(`${JSON.stringify({ ts: 'now', level: 'info', msg: 'x'.repeat(8000) })}\n`);
      const long = (await h.app.inject({ method: 'GET', url: '/api/logs/controller?lines=1', headers: { cookie } })).json();
      assert.ok(long.lines[0].length < 4100 && long.lines[0].endsWith('…'), 'a very long line is cut, so the ring stays bounded');
      const warns = (await h.app.inject({ method: 'GET', url: '/api/logs/controller?grep=warn&lines=2', headers: { cookie } })).json();
      assert.deepEqual(warns.lines.map((/** @type {string} */ line) => JSON.parse(line).msg), ['line 57', 'line 59']);
      assertModule.ok(warns.lines.every((/** @type {string} */ line) => JSON.parse(line).level === 'warn'));
    } finally {
      await h.stop();
    }
  });
});
