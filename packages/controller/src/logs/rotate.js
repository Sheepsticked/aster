// @ts-check
// Rotates the Asterisk `full` log over AMI (`logger rotate`) when it grows past a size limit, then deletes all but the
// newest rotated files. Without an AMI connection the check is skipped until the next tick.
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../log.js').Logger} Logger */
/**
 * @typedef {object} RotationOptions
 * @property {Pick<AmiClient, 'connected' | 'command'> | null} ami
 * @property {string} path         the live log file (logs/asterisk/full)
 * @property {Logger} [log]
 * @property {number} [maxBytes]   rotate above this size (default 20 MB)
 * @property {number} [keep]       rotated files kept (default 5)
 * @property {number} [intervalMs] check period (default 5 min)
 */
/** @typedef {{ size: number | null, rotated: boolean, removed: string[], skipped: string | null }} RotationCheck */

export const DEFAULTS = Object.freeze({ maxBytes: 20 * 1024 * 1024, keep: 5, intervalMs: 5 * 60_000 });

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * The rotated files of `path` (`<name>.<suffix>` next to it), newest first by modification time.
 * @param {string} path
 * @returns {{ name: string, mtimeMs: number }[]}
 */
export function rotatedFiles(path) {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  /** @type {{ name: string, mtimeMs: number }[]} */
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || entry.name.length === prefix.length) continue;
    try {
      files.push({ name: entry.name, mtimeMs: fs.statSync(join(dir, entry.name)).mtimeMs });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err; // rotated away meanwhile
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
}

/**
 * Deletes the rotated files of `path` beyond the newest `keep`.
 * @param {string} path
 * @param {number} keep
 * @returns {string[]} the names removed
 */
export function pruneRotated(path, keep) {
  const removed = [];
  for (const { name } of rotatedFiles(path).slice(keep)) {
    fs.rmSync(join(dirname(path), name), { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * One check: stat the log, rotate over AMI when it is above maxBytes, prune the rotated files. A missing log, a missing AMI
 * connection or a failing command is reported in `skipped` (and logged once per distinct reason), never thrown.
 * @param {RotationOptions} options
 * @returns {Promise<RotationCheck>}
 */
export async function checkLog({ ami, path, maxBytes = DEFAULTS.maxBytes, keep = DEFAULTS.keep }) {
  /** @type {RotationCheck} */
  const result = { size: null, rotated: false, removed: [], skipped: null };
  try {
    result.size = fs.statSync(path).size;
  } catch (err) {
    result.skipped = `cannot stat ${path}: ${errorText(err)}`;
    return result;
  }
  if (result.size > maxBytes) {
    if (!ami || !ami.connected) {
      result.skipped = `${path} is ${result.size} bytes, but Asterisk is not connected over AMI`;
    } else {
      try {
        await ami.command('logger rotate');
        result.rotated = true;
      } catch (err) {
        result.skipped = `logger rotate failed: ${errorText(err)}`;
      }
    }
  }
  try {
    result.removed = pruneRotated(path, keep);
  } catch (err) {
    result.skipped = `cannot prune the rotated files of ${path}: ${errorText(err)}`;
  }
  return result;
}

/**
 * Checks the log a moment after the start and then every intervalMs.
 * @param {RotationOptions} options
 * @returns {{ check: () => Promise<RotationCheck>, stop: () => void }}
 */
export function startLogRotation(options) {
  const { log = SILENT, intervalMs = DEFAULTS.intervalMs } = options;
  /** @type {string | null} */
  let lastSkipped = null;
  let stopped = false;
  /** @type {Promise<RotationCheck> | null} */
  let running = null;

  async function check() {
    const result = await checkLog(options);
    if (result.rotated || result.removed.length > 0) log.info('asterisk log rotated', { path: options.path, size: result.size, rotated: result.rotated, removed: result.removed });
    if (result.skipped !== lastSkipped) {
      if (result.skipped !== null) log.warn('asterisk log rotation skipped', { path: options.path, reason: result.skipped });
      lastSkipped = result.skipped;
    }
    return result;
  }

  const tick = () => {
    if (stopped || running) return;
    running = check().catch((err) => {
      log.error('asterisk log rotation failed', { path: options.path, err });
      return /** @type {RotationCheck} */ ({ size: null, rotated: false, removed: [], skipped: errorText(err) });
    }).finally(() => {
      running = null;
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const first = setTimeout(tick, Math.min(intervalMs, 5_000));
  first.unref();
  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
