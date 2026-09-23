// @ts-check
// Tests for the backup archive from GET /api/backup and bin/backup.js; each archive is extracted and its files, modes and
// database copy checked.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { archiveName, createArchive, MEMBERS } from '../src/backup.js';
import { DatabaseSync } from 'node:sqlite';
import { harness, seed } from './http-harness.js';

const NODE = process.execPath;
const BIN = new URL('../bin/backup.js', import.meta.url).pathname;

/** The archive's file list (tar tzf). @param {string} file */
const list = (file) => execFileSync('tar', ['tzf', file], { encoding: 'utf8' }).split('\n').filter((line) => line !== '');

/** @param {string} file @param {string} into */
function extract(file, into) {
  mkdirSync(into, { recursive: true });
  execFileSync('tar', ['xzf', file, '-C', into]);
  return into;
}

describe('http backup routes', () => {
  test('GET /api/backup streams a tar.gz of the appliance with a readable copy of the database', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      seed(h.db, { messages: [{ sender: '+375290000001', text: 'in the backup', received_at: 1 }] });
      writeFileSync(join(h.paths.spool, 'events', 'pending.evt'), 'k=sms\n');
      mkdirSync(join(h.paths.state, 'asterisk'), { recursive: true });
      writeFileSync(join(h.paths.state, 'asterisk', 'astdb.sqlite3'), 'astdb');

      const response = await h.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/gzip');
      assert.match(String(response.headers['content-disposition']), /^attachment; filename="aster-\d{8}T\d{6}Z\.tar\.gz"$/);
      assert.equal(response.headers['cache-control'], 'no-store');

      const dir = mkdtempSync(join(tmpdir(), 'aster-tar-'));
      try {
        const file = join(dir, 'backup.tar.gz');
        writeFileSync(file, response.rawPayload);
        const entries = list(file);
        for (const path of ['config/aster.yaml', 'config/secrets.env', 'state/prev/', 'state/asterisk/astdb.sqlite3',
          'spool/events/pending.evt', 'state/aster.db']) {
          assert.ok(entries.some((entry) => entry === path || entry === `./${path}`), `${path} is in the archive: ${entries.join(' ')}`);
        }
        const out = extract(file, join(dir, 'out'));
        assert.equal(readFileSync(join(out, 'config', 'aster.yaml'), 'utf8'), readFileSync(h.paths.registry, 'utf8'));
        assert.equal(statSync(join(out, 'config', 'secrets.env')).mode & 0o777, 0o600, 'the mode of the secrets survives the archive');
        const copy = new DatabaseSync(join(out, 'state', 'aster.db'));
        try {
          assert.equal(/** @type {any} */ (copy.prepare('SELECT count(*) AS n FROM messages').get()).n, 1, 'the online copy has the rows');
          assert.ok(/** @type {any[]} */ (copy.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).length >= 11);
        } finally {
          copy.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await h.stop();
    }
  });

  test('a path that does not exist is left out and named, and the archive still opens', async () => {
    const h = await harness();
    try {
      const { cookie } = await h.login();
      rmSync(join(h.paths.state, 'prev'), { recursive: true, force: true });
      rmSync(h.paths.spool, { recursive: true, force: true });
      const response = await h.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } });
      assert.equal(response.statusCode, 200);
      assert.equal(String(response.headers['x-aster-backup-members']), 'config,state/aster.db');
      const dir = mkdtempSync(join(tmpdir(), 'aster-tar-'));
      try {
        const file = join(dir, 'backup.tar.gz');
        writeFileSync(file, response.rawPayload);
        const entries = list(file);
        assert.ok(entries.some((entry) => entry.includes('config/aster.yaml')));
        assert.equal(entries.some((entry) => entry.includes('spool')), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      assert.deepEqual(MEMBERS, ['config', 'state/asterisk', 'state/prev', 'spool']);
    } finally {
      await h.stop();
    }
  });

  test('a tar that fails rejects the archive and leaves no temporary copy of the database behind', async () => {
    const h = await harness();
    try {
      const archive = await createArchive({ home: h.dir, db: h.db, tar: 'false' }); // /bin/false: exits 1 without writing anything
      assert.equal(existsSync(join(archive.tmp, 'state', 'aster.db')), true, 'the online copy is made before tar runs');
      await assert.rejects(archive.done, /false ended with status 1/);
      assert.equal(existsSync(archive.tmp), false, 'the copy of the database is removed whether tar succeeded or not');
      await assert.rejects(createArchive({ home: h.dir, db: h.db, tar: '/nonexistent/tar' }).then((made) => made.done),
        /could not be started/);
    } finally {
      await h.stop();
    }
  });

  test('the backup needs a session like every other route', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/backup' });
      assert.deepEqual([response.statusCode, response.json().error], [401, 'not logged in']);
    } finally {
      await h.stop();
    }
  });
});

describe('bin/backup.js', () => {
  test('writes backups/aster-<ts>.tar.gz, keeps the newest ten and removes a leftover part file', async () => {
    const h = await harness();
    try {
      writeFileSync(join(h.paths.spool, 'events', 'pending.evt'), 'k=sms\n');
      const backups = join(h.dir, 'backups');
      mkdirSync(backups, { recursive: true });
      // Eleven older archives and the leftovers of a run that was interrupted.
      for (let i = 0; i < 11; i += 1) writeFileSync(join(backups, archiveName(Date.UTC(2026, 0, 1 + i))), 'old');
      writeFileSync(join(backups, `${archiveName(Date.UTC(2026, 5, 1))}.part`), 'interrupted');

      const out = execFileSync(NODE, [BIN], { encoding: 'utf8', env: { ...process.env, ASTER_HOME: h.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      const written = out.trim();
      assert.match(written, /\/backups\/aster-\d{8}T\d{6}Z\.tar\.gz$/);
      const names = readdirSync(backups).sort();
      assert.equal(names.length, 10, `ten are kept, got ${names.join(' ')}`);
      assert.equal(names.includes(written.split('/').pop() ?? ''), true, 'the new one is among them');
      assert.equal(names.some((name) => name.endsWith('.part')), false, 'the leftover part file is gone');
      assert.equal(names.includes(archiveName(Date.UTC(2026, 0, 1))), false, 'the oldest were removed');
      assert.equal(statSync(written).mode & 0o777, 0o600);
      assert.ok(list(written).some((entry) => entry.includes('spool/events/pending.evt')));

      const fewer = execFileSync(NODE, [BIN, '--keep', '2'], { encoding: 'utf8', env: { ...process.env, ASTER_HOME: h.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(readdirSync(backups).length, 2);
      assert.ok(readdirSync(backups).includes(fewer.trim().split('/').pop() ?? ''));
    } finally {
      await h.stop();
    }
  });

  test('--stdout writes the archive to stdout and nothing to backups/', async () => {
    const h = await harness();
    try {
      const bytes = execFileSync(NODE, [BIN, '--stdout'], { env: { ...process.env, ASTER_HOME: h.dir }, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.ok(bytes.length > 100);
      assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], 'gzip');
      const dir = mkdtempSync(join(tmpdir(), 'aster-tar-'));
      try {
        const file = join(dir, 'backup.tar.gz');
        writeFileSync(file, bytes);
        assert.ok(list(file).some((entry) => entry.includes('state/aster.db')));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      assert.equal(readdirSync(h.dir).includes('backups'), false, 'nothing was written to backups/');
    } finally {
      await h.stop();
    }
  });

  test('an invalid --keep is refused before anything is written', async () => {
    const h = await harness();
    try {
      assert.throws(() => execFileSync(NODE, [BIN, '--keep', 'lots'], { env: { ...process.env, ASTER_HOME: h.dir }, stdio: 'pipe' }),
        (/** @type {any} */ err) => err.status === 2 && String(err.stderr).includes('--keep takes a whole number'));
      assert.equal(readdirSync(h.dir).includes('backups'), false);
    } finally {
      await h.stop();
    }
  });
});
