// @ts-check
// Atomic file writes (a crash leaves the old or the new content, never a partial file) and hashed reads.
// fs is called as fs.x(…) so tests can make single calls fail with mock.method.
// Usage: writeAtomic('config/asterisk/extensions.conf', text); const current = readFile(path); // null when absent
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname } from 'node:path';

/** @typedef {{ bytes: Buffer, text: string, hash: string }} FileContent */

/** sha256 of a string (UTF-8) or bytes, hex. @param {string | Uint8Array} data */
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** @param {unknown} err */
const reason = (err) => (err instanceof Error ? err.message : String(err));

/** @param {unknown} err */
const isMissing = (err) => /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT';

/**
 * The file's bytes, text (UTF-8, replacement characters for invalid sequences) and hash; null when it does not exist. Any
 * other failure throws.
 * @param {string} path
 * @returns {FileContent | null}
 */
export function readFile(path) {
  let bytes;
  try {
    bytes = fs.readFileSync(path);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return { bytes, text: bytes.toString('utf8'), hash: sha256(bytes) };
}

/**
 * sha256 of the file's bytes; null when it does not exist.
 * @param {string} path
 */
export function fileHash(path) {
  return readFile(path)?.hash ?? null;
}

/** @param {string} path @returns {number | undefined} */
function existingMode(path) {
  try {
    return fs.statSync(path).mode & 0o7777;
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/**
 * Replaces the file with `content`: <path>.tmp (the mode of the current file, else 0644) → write → fsync → close → rename over
 * <path> → fsync of the directory. Throws with "(nothing was replaced)" when the failure came before the rename — the current
 * file is untouched and no .tmp remains — and with "was replaced, but syncing its directory failed" afterwards.
 * @param {string} path
 * @param {string | Uint8Array} content
 * @returns {{ hash: string }} sha256 of the bytes written
 */
export function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  /** @type {number | undefined} */
  let fd;
  try {
    const mode = existingMode(path) ?? 0o644;
    fd = fs.openSync(tmp, 'w', mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // the original error is reported
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // the original error is reported
    }
    throw new Error(`cannot write ${path} (nothing was replaced): ${reason(err)}`, { cause: err });
  }
  try {
    const dir = fs.openSync(dirname(path), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch (err) {
    throw new Error(`${path} was replaced, but syncing its directory failed: ${reason(err)}`, { cause: err });
  }
  return { hash: sha256(content) };
}
