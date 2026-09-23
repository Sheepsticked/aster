// @ts-check
// Tests for GET /api/health: `ok`, one degraded reason per cause, and that it needs no session, writes nothing and caches
// the CLI probe.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createHealth, REQUIRED_MODULES, runningModules, THRESHOLDS } from '../src/http/routes/health.js';
import { migrate, open } from '../src/store/db.js';
import { harness, snapshot } from './http-harness.js';

const SHOW = ['Module                         Description                              Use Count  Status      Support Level',
  'chan_pjsip.so                  PJSIP Channel Driver                     0          Running      core',
  'chan_quectel.so                Quectel/Simcom channel driver            0          Running      extended',
  'app_dial.so                    Dialing Application                      0          Not Running  core',
  '3 modules loaded'];

describe('http health routes', () => {
  test('runningModules(): only the modules `module show` marks Running; the thresholds are the documented ones', () => {
    assert.deepEqual([...runningModules(SHOW)], ['chan_pjsip.so', 'chan_quectel.so']);
    assert.deepEqual([...runningModules([])], []);
    assert.deepEqual(THRESHOLDS, { spoolBacklog: 100, diskFreeMb: 500 });
    assert.ok(REQUIRED_MODULES.includes('chan_quectel.so') && REQUIRED_MODULES.includes('chan_dongle.so'));
  });

  test('ok with AMI up and every module running; no session needed and nothing is written', async () => {
    const h = await harness();
    try {
      const before = snapshot(h.db, { sessions: true });
      const response = await h.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual([body.status, body.reasons], ['ok', []]);
      assert.deepEqual(body.versions, { controller: '1.2.3', node: process.version, asterisk: '20.15.2' });
      assert.deepEqual([body.ami.configured, body.ami.connected, body.ami.state, body.fully_booted], [true, true, 'up', true]);
      assert.deepEqual([body.modules.checked, body.modules.missing, body.modules.error], [true, [], null]);
      assert.deepEqual([body.spool_backlog, body.quarantine, body.database.ok], [0, null, true]);
      assert.equal(typeof body.disk_free_mb, 'number');
      assert.equal(snapshot(h.db, { sessions: true }), before, 'a GET writes nothing at all');
    } finally {
      await h.stop();
    }
  });

  test('one reason per cause: no AMI, not up, no FullyBooted, a module missing, a spool backlog, too little disk', async () => {
    const without = await harness({ ami: false });
    try {
      const body = (await without.app.inject({ method: 'GET', url: '/api/health' })).json();
      assert.equal(body.status, 'degraded');
      assert.deepEqual(body.reasons, ['AMI is not configured (ASTER_AMI_SECRET is not set), so nothing can be changed in Asterisk']);
      assert.deepEqual([body.ami.configured, body.ami.state, body.modules.checked, body.versions.asterisk], [false, null, false, null]);
    } finally {
      await without.stop();
    }

    const h = await harness({ thresholds: { diskFreeMb: 0, spoolBacklog: 2 }, timing: { probeMs: 0, filesMs: 0 } });
    try {
      const ami = /** @type {import('./devices-fake.js').FakeDriverAmi} */ (h.ami);
      ami.up = false;
      let body = (await h.app.inject({ method: 'GET', url: '/api/health' })).json();
      assert.deepEqual(body.reasons, ['Asterisk is not reachable over AMI (connecting)']);
      assert.equal(body.fully_booted, false);

      ami.up = true;
      ami.forcedState = 'booting';
      body = (await h.app.inject({ method: 'GET', url: '/api/health' })).json();
      assert.deepEqual(body.reasons, ['Asterisk accepted the AMI login but has not reported FullyBooted yet']);

      ami.forcedState = null;
      h.stopModules(['chan_dongle.so', 'func_cdr.so']);
      body = (await h.app.inject({ method: 'GET', url: '/api/health' })).json();
      assert.deepEqual(body.reasons, ['required Asterisk modules are not running: chan_dongle.so, func_cdr.so']);
      assert.deepEqual(body.modules, { checked: true, missing: ['chan_dongle.so', 'func_cdr.so'], error: null });

      h.stopModules([]);
      for (const n of [1, 2, 3]) writeFileSync(join(h.paths.spool, 'events', `${n}.evt`), 'x');
      writeFileSync(join(h.paths.spool, 'events', 'partial.tmp'), 'x');
      body = (await h.app.inject({ method: 'GET', url: '/api/health' })).json();
      assert.deepEqual(body.reasons, ['3 spool files are waiting to be ingested (more than 2)'], 'the half-written .tmp does not count');
      assert.equal(body.spool_backlog, 3);
    } finally {
      await h.stop();
    }
  });

  test('a database that cannot be read, and an AMI probe that fails, are reasons and not failures', async () => {
    const h = await harness({ thresholds: { diskFreeMb: 10 ** 9 } });
    try {
      const body = (await h.app.inject({ method: 'GET', url: '/api/health' })).json();
      assert.equal(body.status, 'degraded');
      assert.match(body.reasons[0], /^\d+ MB free on the disk \(less than 1000000000 MB\)$/);

      const ami = /** @type {import('./devices-fake.js').FakeDriverAmi} */ (h.ami);
      ami.onCommand = () => {
        throw new Error('AMI timeout');
      };
      const health = createHealth({ db: h.db, ami: /** @type {any} */ (ami), paths: h.paths, version: 'x', startedAt: 0, timing: { probeMs: 0 } });
      const failed = await health.check();
      assert.deepEqual(failed.modules, { checked: false, missing: [], error: 'AMI timeout' });
      assert.equal(failed.reasons.includes('required Asterisk modules are not running: '), false, 'an unrun probe is not a missing module');
    } finally {
      await h.stop();
    }
    const path = join(process.env.TMPDIR ?? '/tmp', `aster-health-${process.pid}.db`);
    const db = open(path);
    migrate(db);
    db.close();
    const broken = createHealth({ db, ami: null, paths: { spool: '/nonexistent', state: '/nonexistent' }, version: 'x', startedAt: 0 });
    const body = /** @type {any} */ (await broken.check());
    assert.equal(body.status, 'degraded');
    assert.equal(body.database.ok, false);
    assert.match(body.reasons[0] ?? '', /^the database cannot be read: /);
    assert.deepEqual([body.spool_backlog, body.disk_free_mb], [null, null], 'unreadable paths are unknown, not zero');
  });

  test('the CLI probe is cached; the AMI state is read live', async () => {
    const h = await harness({ timing: { probeMs: 60_000 } });
    try {
      await h.app.inject({ method: 'GET', url: '/api/health' });
      const after = h.commands();
      assert.equal(after, 2, 'module show and core show version');
      await h.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(h.commands(), after, 'the second request runs no command');
      const ami = /** @type {import('./devices-fake.js').FakeDriverAmi} */ (h.ami);
      ami.up = false;
      const body = (await h.app.inject({ method: 'GET', url: '/api/health' })).json();
      assert.equal(body.status, 'degraded', 'the state is not cached');
      assert.equal(body.versions.asterisk, '20.15.2', 'the cached probe still answers');
    } finally {
      await h.stop();
    }
  });

  test('the summary is for a session only, and counts what is still in flight', async () => {
    const h = await harness();
    try {
      const anon = (await h.app.inject({ method: 'GET', url: '/api/health' })).json();
      assert.equal('summary' in anon, false, 'an unauthenticated caller gets nothing about the modems or the queues');

      const { headers } = await h.login();
      const empty = (await h.app.inject({ method: 'GET', url: '/api/health', headers })).json();
      assert.deepEqual([empty.summary.sms, empty.summary.notifications, empty.summary.operations],
        [{ waiting: 0, failed: 0 }, { waiting: 0, failed: 0 }, { running: 0, waiting: 0 }]);
      assert.ok(Array.isArray(empty.summary.modems));
      for (const modem of empty.summary.modems) {
        assert.deepEqual(Object.keys(modem).sort(), ['enabled', 'id', 'provider', 'rssi', 'state']);
      }

      // The clock the route reads, so the rows below are placed against it rather than against this process's own time.
      const at = Number(empty.checked_at);
      const hour = 60 * 60 * 1000;
      const sms = h.db.prepare('INSERT INTO sms_outbox (modem_id, number, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      sms.run('gsm1', '+1234567890', 'waiting', 'queued', at, at);
      sms.run('gsm1', '+1234567890', 'gone to the driver', 'submitted', at, at);
      sms.run('gsm1', '+1234567890', 'sent', 'delivered', at, at);
      sms.run('gsm1', '+1234567890', 'refused', 'rejected', at - hour, at - hour);
      sms.run('gsm1', '+1234567890', 'old news', 'failed', at - 40 * hour, at - 30 * hour);
      const notify = h.db.prepare(`INSERT INTO notifications (source_kind, chat_id, part_no, part_count, text, status, created_at)
        VALUES (?, ?, 1, 1, ?, ?, ?)`);
      notify.run('sms', '123', 'waiting', 'pending', at);
      notify.run('sms', '123', 'nobody could send it', 'failed', at - 30 * hour);
      notify.run('sms', '123', 'failed long ago', 'failed', at - 80 * hour);

      // Without the sessions table: a request that carries one may write its last_seen_at, which is not domain state.
      const before = snapshot(h.db);
      const body = (await h.app.inject({ method: 'GET', url: '/api/health', headers })).json();
      assert.deepEqual(body.summary.sms, { waiting: 2, failed: 1 }, 'a delivered SMS is done, and one that failed yesterday is history');
      // A notification becomes `failed` 24 h after it was created, so the window has to reach past that or it would count none.
      assert.deepEqual(body.summary.notifications, { waiting: 1, failed: 1 });
      assert.equal(snapshot(h.db), before, 'counting writes nothing');
    } finally {
      await h.stop();
    }
  });
});
