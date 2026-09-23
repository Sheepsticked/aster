// @ts-check
// Tests for bin/passwd.js run as a process: --hash, writing secrets.env and ending sessions, and the password read from
// ASTER_ADMIN_PASSWORD or stdin (never an argument, which the process list would show).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSecrets } from '../src/env.js';
import { verifyPassword } from '../src/http/auth.js';
import { migrate, open } from '../src/store/db.js';

const PASSWD = fileURLToPath(new URL('../bin/passwd.js', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'aster-passwd-'));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * An ASTER_HOME with a secrets file and, when asked, a database holding two sessions.
 * @param {string} name
 * @param {{ sessions?: number }} [options]
 */
function makeHome(name, { sessions = 0 } = {}) {
  const home = join(root, name);
  mkdirSync(join(home, 'config'), { recursive: true });
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'config', 'secrets.env'), '# Aster secrets\nASTER_AMI_SECRET=ami\n', { mode: 0o600 });
  if (sessions > 0) {
    const db = open(join(home, 'state', 'aster.db'));
    migrate(db);
    for (let i = 0; i < sessions; i += 1) db.prepare('INSERT INTO sessions (id, created_at, last_seen_at) VALUES (?, 1, 1)').run(`session-${i}`);
    db.close();
  }
  return home;
}

/**
 * @param {string} home
 * @param {string[]} args
 * @param {{ password?: string, stdin?: string }} [options]
 */
const run = (home, args, { password, stdin = '' } = {}) => spawnSync(process.execPath, [PASSWD, ...args], {
  env: { ...process.env, ASTER_HOME: home, ...(password === undefined ? {} : { ASTER_ADMIN_PASSWORD: password }) },
  input: stdin, encoding: 'utf8', timeout: 30_000,
});

describe('http passwd', () => {
  test('--hash prints a hash for the password of the environment and writes nothing', async () => {
    const home = makeHome('hash');
    const before = readFileSync(join(home, 'config', 'secrets.env'), 'utf8');
    const result = run(home, ['--hash'], { password: 'a long enough password' });
    assert.equal(result.status, 0, result.stderr);
    const hash = result.stdout.trim();
    assert.match(hash, /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    assert.equal(await verifyPassword('a long enough password', hash), true);
    assert.equal(readFileSync(join(home, 'config', 'secrets.env'), 'utf8'), before);
  });

  test('a normal run writes the hash, keeps the rest of the file and its mode, and ends every session', async () => {
    const home = makeHome('set', { sessions: 2 });
    const result = run(home, [], { password: 'a long enough password' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /the admin password is set in .*secrets\.env; 2 session\(s\) ended\n$/);
    const path = join(home, 'config', 'secrets.env');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^# Aster secrets\nASTER_AMI_SECRET=ami\nASTER_ADMIN_PASSWORD_HASH=\$scrypt\$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(await verifyPassword('a long enough password', String(parseSecrets(text).ASTER_ADMIN_PASSWORD_HASH)), true);
    const db = open(join(home, 'state', 'aster.db'));
    assert.equal(/** @type {any} */ (db.prepare('SELECT count(*) AS n FROM sessions').get()).n, 0);
    db.close();

    // Run again: the line is replaced, not repeated.
    assert.equal(run(home, [], { password: 'another long password' }).status, 0);
    const second = readFileSync(path, 'utf8');
    assert.equal(second.split('\n').filter((line) => line.startsWith('ASTER_ADMIN_PASSWORD_HASH=')).length, 1);
    assert.equal(await verifyPassword('another long password', String(parseSecrets(second).ASTER_ADMIN_PASSWORD_HASH)), true);
  });

  test('the password may come from stdin; a refused one writes nothing and exits 2', async () => {
    const home = makeHome('stdin');
    const before = readFileSync(join(home, 'config', 'secrets.env'), 'utf8');
    const piped = run(home, ['--hash'], { stdin: 'from a pipe, long enough\nignored second line\n' });
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(await verifyPassword('from a pipe, long enough', piped.stdout.trim()), true);

    const single = run(home, ['--hash'], { password: '1' });
    assert.equal(single.status, 0, single.stderr);
    assert.equal(await verifyPassword('1', single.stdout.trim()), true);

    const long = run(home, [], { password: 'x'.repeat(257) });
    assert.equal(long.status, 2);
    assert.match(long.stderr, /passwd\.js: the password must be at most 256 characters; nothing was written/);
    const empty = run(home, [], { stdin: '' });
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /no password on stdin/);
    assert.equal(readFileSync(join(home, 'config', 'secrets.env'), 'utf8'), before);
  });

  test('without a secrets file it says which file install.sh creates, and writes nothing', () => {
    const home = join(root, 'bare');
    mkdirSync(home, { recursive: true });
    const result = run(home, [], { password: 'a long enough password' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^passwd\.js: secrets file not found: .*config\/secrets\.env \(install\.sh creates it;/);
  });
});
