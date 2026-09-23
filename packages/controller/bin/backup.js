// @ts-check
// Aster — write backups/aster-<ts>.tar.gz: config/ (registry, secrets.env, the hand-owned Asterisk files), state/asterisk,
// state/prev, spool/ and an online copy of state/aster.db (src/backup.js), then keep the newest ten.
// The archive is written to <name>.part and renamed when tar has finished, so a backup that fails or is interrupted never leaves a
// file that looks complete. bin/backup.sh on the host runs this through `docker exec`; --stdout streams the same archive instead,
// which is what a restore runbook or an ad-hoc copy over ssh uses.
// Usage: node bin/backup.js [--stdout] [--keep <n>]
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createArchive, KEEP } from '../src/backup.js';
import { loadEnv } from '../src/env.js';
import { createLogger } from '../src/log.js';
import { open } from '../src/store/db.js';

/** A finished archive is named like this; a `.part` file of an interrupted run is removed by the next one. */
const ARCHIVE = /^aster-\d{8}T\d{6}Z\.tar\.gz$/;

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`backup.js: ${message}\n`);
  process.exit(2);
}

/**
 * Deletes every archive but the newest `keep` (by name, which sorts by time), and any leftover .part file.
 * @param {string} dir
 * @param {number} keep
 * @returns {string[]} what was removed
 */
export function prune(dir, keep) {
  /** @type {string[]} */
  const removed = [];
  const names = readdirSync(dir).sort();
  for (const name of names.filter((entry) => entry.endsWith('.part'))) {
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }
  const archives = names.filter((name) => ARCHIVE.test(name));
  for (const name of archives.slice(0, Math.max(0, archives.length - keep))) {
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

async function main() {
  const { values } = parseArgs({ options: { stdout: { type: 'boolean', default: false }, keep: { type: 'string' } } });
  const keep = values.keep === undefined ? KEEP : Number(values.keep);
  if (!Number.isInteger(keep) || keep < 1) fail(`--keep takes a whole number of archives to keep, not ${JSON.stringify(values.keep)}`);
  const env = loadEnv();
  // Everything but the archive itself goes to stderr, so --stdout can be redirected into a file.
  const log = createLogger({ stream: process.stderr, fields: { module: 'backup' } });
  const db = open(env.paths.db);
  /** @type {Awaited<ReturnType<typeof createArchive>>} */
  let archive;
  try {
    archive = await createArchive({ home: env.home, db, log });
  } catch (err) {
    db.close();
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (values.stdout) {
    try {
      await Promise.all([pipeline(archive.stream, process.stdout), archive.done]);
    } catch (err) {
      archive.cancel();
      db.close();
      return fail(err instanceof Error ? err.message : String(err));
    }
    db.close();
    return undefined;
  }

  const dir = join(env.home, 'backups');
  mkdirSync(dir, { recursive: true });
  // The name the archive was made under, so the file and the download of the same archive carry the same moment.
  const { name } = archive;
  const part = join(dir, `${name}.part`);
  try {
    await Promise.all([pipeline(archive.stream, createWriteStream(part, { mode: 0o600 })), archive.done]);
  } catch (err) {
    archive.cancel();
    try {
      unlinkSync(part);
    } catch {
      // The partial file could not be removed; the next run's prune takes it.
    }
    db.close();
    return fail(err instanceof Error ? err.message : String(err));
  }
  renameSync(part, join(dir, name));
  const { size } = statSync(join(dir, name));
  const removed = prune(dir, keep);
  db.close();
  log.info('backup written', { file: join(dir, name), bytes: size, members: archive.members, missing: archive.missing, removed, keep });
  process.stdout.write(`${join(dir, name)}\n`);
  return undefined;
}

await main();
