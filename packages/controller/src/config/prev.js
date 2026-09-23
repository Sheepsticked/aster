// @ts-check
// The previous applied version of each hand-owned file (state/prev/<name>, no history): saved by config-apply,
// swapped back by config-restore in atomic steps so an interrupted swap can be resumed.
// Usage: savePrev(prevDir, 'extensions.conf', bytes); readPrev(prevDir, 'extensions.conf'); swapPrev(prevDir, configDir, 'extensions.conf')
import fs from 'node:fs';
import { join } from 'node:path';
import { readFile, writeAtomic } from './atomic.js';

/** A hand-owned file name: one path segment, `<name>.conf`, as in the reload map. */
const NAME = /^[A-Za-z0-9_-]+\.conf$/;

/** @param {string} name */
export function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`not a hand-owned configuration file name: ${JSON.stringify(name)}`);
  return name;
}

/** @param {string} prevDir @param {string} name */
export const prevPath = (prevDir, name) => join(prevDir, checkName(name));

/** The staging file of a swap in progress. @param {string} prevDir @param {string} name */
export const stagedPath = (prevDir, name) => `${prevPath(prevDir, name)}.new`;

/**
 * The previous applied version; null when there is none.
 * @param {string} prevDir
 * @param {string} name
 */
export function readPrev(prevDir, name) {
  return readFile(prevPath(prevDir, name));
}

/**
 * Stores `bytes` as the previous applied version of `name` (creating state/prev when needed).
 * @param {string} prevDir
 * @param {string} name
 * @param {string | Uint8Array} bytes
 * @returns {{ hash: string }}
 */
export function savePrev(prevDir, name, bytes) {
  const path = prevPath(prevDir, name);
  fs.mkdirSync(prevDir, { recursive: true });
  return writeAtomic(path, bytes);
}

/**
 * Swaps the current file and its previous version. Steps, each an atomic replace: (1) current → state/prev/<name>.new,
 * (2) previous → config/asterisk/<name>, (3) <name>.new → state/prev/<name>. `resume` finishes a swap that was interrupted:
 * a staged file whose content is still the current file means step 2 has not run; a staged file with other content means it
 * has. Without a previous version the swap is refused.
 * @param {string} prevDir
 * @param {string} configDir
 * @param {string} name
 * @param {{ resume?: boolean }} [options]
 * @returns {{ hash: string, previousHash: string }} hash: the file now current; previousHash: the file now previous
 */
export function swapPrev(prevDir, configDir, name, { resume = false } = {}) {
  const current = join(configDir, checkName(name));
  const previous = prevPath(prevDir, name);
  const staged = stagedPath(prevDir, name);
  const now = readFile(current);
  if (now === null) throw new Error(`${name} does not exist in the configuration directory`);
  let stagedContent = resume ? readFile(staged) : null;
  if (stagedContent === null) {
    const prev = readFile(previous);
    if (prev === null) throw new Error(`${name} has no previous applied version to restore`);
    fs.mkdirSync(prevDir, { recursive: true });
    writeAtomic(staged, now.bytes);
    stagedContent = readFile(staged);
    if (stagedContent === null) throw new Error(`${staged} vanished during the swap`);
    writeAtomic(current, prev.bytes);
  } else if (stagedContent.hash === now.hash) {
    // interrupted after step 1: the previous version has not replaced the current file yet
    const prev = readFile(previous);
    if (prev === null) throw new Error(`${name} has no previous applied version to restore`);
    writeAtomic(current, prev.bytes);
  }
  const restored = readFile(current);
  fs.renameSync(staged, previous);
  return { hash: restored?.hash ?? '', previousHash: stagedContent.hash };
}
