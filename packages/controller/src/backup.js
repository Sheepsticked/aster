// @ts-check
// Aster controller — the backup archive: one tar.gz of config/, state/asterisk, state/prev, spool/ and an online SQLite
// copy of state/aster.db. Used by both the HTTP route and bin/backup.js; tar is spawned without a shell.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';

/** Paths, relative to ASTER_HOME, in the order they are archived. */
export const MEMBERS = Object.freeze(['config', 'state/asterisk', 'state/prev', 'spool']);
/** Where the online copy of the database lands inside the archive. */
export const DB_MEMBER = 'state/aster.db';
/** Kept in backups/ by bin/backup.js. */
export const KEEP = 10;
/** Of tar's stderr, in an error message. */
const MAX_STDERR = 4_000;

/** @typedef {import('./log.js').Logger} Logger */
/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * The name of an archive: sorted by name is sorted by time, which is what the prune relies on.
 * @param {number} [at]  epoch ms
 */
export function archiveName(at = Date.now()) {
  return `aster-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.tar.gz`;
}

/**
 * @param {object} options
 * @param {string} options.home  ASTER_HOME
 * @param {import('node:sqlite').DatabaseSync} options.db  the live connection; an online copy of it is added to the archive
 * @param {Logger} [options.log]
 * @param {string} [options.tar]  the tar binary (tests)
 * @returns {Promise<{ stream: import('node:stream').Readable, members: string[], missing: string[], name: string, tmp: string,
 *   done: Promise<void>, cancel: () => void }>}
 *   `stream` is the archive; `done` resolves when tar exited 0 and rejects with its stderr otherwise. `tmp` is the directory
 *   holding the copy of the database; it is removed when either happens, so a caller that stops reading must call cancel().
 */
export async function createArchive({ home, db, log = SILENT, tar = 'tar' }) {
  const present = MEMBERS.filter((member) => exists(join(home, member)));
  const missing = MEMBERS.filter((member) => !present.includes(member));
  const tmp = mkdtempSync(join(tmpdir(), 'aster-backup-'));
  let cleaned = false;
  const clean = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(tmp, { recursive: true, force: true });
  };
  try {
    mkdirSync(join(tmp, 'state'), { recursive: true });
    await sqliteBackup(db, join(tmp, DB_MEMBER));
  } catch (err) {
    clean();
    throw new Error(`the database could not be copied for the backup: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const args = ['-czf', '-', '-C', home, ...present, '-C', tmp, DB_MEMBER];
  const child = spawn(tar, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  /** @type {Buffer[]} */
  const errors = [];
  let errorBytes = 0;
  child.stderr.on('data', (chunk) => {
    if (errorBytes >= MAX_STDERR) return;
    errors.push(chunk);
    errorBytes += chunk.length;
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', (err) => reject(new Error(`${tar} could not be started: ${err.message}`, { cause: err })));
    child.once('close', (code, signal) => {
      const text = Buffer.concat(errors).toString('utf8').trim().slice(0, MAX_STDERR);
      if (code === 0) resolve(undefined);
      else reject(new Error(`${tar} ended ${signal ? `on ${signal}` : `with status ${code}`}${text === '' ? '' : `: ${text}`}`));
    });
  }).finally(clean);
  if (missing.length > 0) log.warn('the backup leaves out paths that do not exist', { missing });

  return {
    stream: child.stdout,
    members: [...present, DB_MEMBER],
    missing,
    tmp,
    name: archiveName(),
    done: /** @type {Promise<void>} */ (done),
    cancel() {
      child.kill('SIGKILL');
      clean();
    },
  };
}

/** @param {string} path */
function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
