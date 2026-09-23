// @ts-check
// Aster controller — the admin password, an scrypt hash in PHC format in config/secrets.env
// ($scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>). Verified with the stored parameters; an unreadable hash throws.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** The secrets.env key install.sh, bin/passwd.js and the settings API write. */
export const HASH_KEY = 'ASTER_ADMIN_PASSWORD_HASH';
/** Parameters of a hash created here; a stored hash is verified with its own. */
export const PARAMS = Object.freeze({ ln: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
/** Password rules: the admin chooses it, so any password is accepted that is not empty, not too long and free of control characters. */
export const MAX_PASSWORD = 256;
/** Bounds that keep a hash from someone else's file from asking for gigabytes of memory. */
const LIMITS = Object.freeze({ ln: { min: 1, max: 20 }, r: { min: 1, max: 32 }, p: { min: 1, max: 16 } });
const HASH = /^\$scrypt\$ln=([0-9]{1,2}),r=([0-9]{1,3}),p=([0-9]{1,3})\$([A-Za-z0-9+/]{1,128})\$([A-Za-z0-9+/]{1,128})$/;

/** @typedef {{ ln: number, r: number, p: number, salt: Buffer, key: Buffer }} Hash */

/** Unpadded standard base64, as the PHC string format writes it. @param {Buffer} bytes */
const b64 = (bytes) => bytes.toString('base64').replace(/=+$/, '');

/**
 * Why this password cannot be used, or null. The text is shown to the admin.
 * @param {unknown} password
 * @returns {string | null}
 */
export function checkPassword(password) {
  if (typeof password !== 'string') return 'the password must be a string';
  if (password === '') return 'the password must not be empty';
  if (password.length > MAX_PASSWORD) return `the password must be at most ${MAX_PASSWORD} characters`;
  for (const ch of password) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return 'the password must not contain control characters';
  }
  return null;
}

/**
 * Reads a stored hash string.
 * @param {unknown} text
 * @returns {Hash}
 */
export function parseHash(text) {
  if (typeof text !== 'string') throw new TypeError(`${HASH_KEY} must be a string`);
  const match = HASH.exec(text);
  if (!match) throw new TypeError(`${HASH_KEY} is not a scrypt hash ($scrypt$ln=<n>,r=<n>,p=<n>$<salt>$<key>)`);
  const [ln, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [name, value] of /** @type {const} */ ([['ln', ln], ['r', r], ['p', p]])) {
    const { min, max } = LIMITS[name];
    if (value < min || value > max) throw new TypeError(`${HASH_KEY}: ${name}=${value} is outside ${min}…${max}`);
  }
  const salt = Buffer.from(String(match[4]), 'base64');
  const key = Buffer.from(String(match[5]), 'base64');
  if (salt.length === 0 || key.length === 0) throw new TypeError(`${HASH_KEY}: the salt and the key must not be empty`);
  return { ln, r, p, salt, key };
}

/**
 * Derives `keyBytes` from the password with the given parameters.
 * @param {string} password
 * @param {{ ln: number, r: number, p: number, salt: Buffer, keyBytes: number }} params
 * @returns {Promise<Buffer>}
 */
function derive(password, { ln, r, p, salt, keyBytes }) {
  const N = 2 ** ln;
  const maxmem = 256 * N * r + 1024 * 1024; // twice what scrypt needs, so the default 32 MiB limit never decides
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(password, 'utf8'), salt, keyBytes, { N, r, p, maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * A new hash string for a password (a fresh random salt each time).
 * @param {string} password
 * @param {{ ln?: number, r?: number, p?: number }} [params]  weaker parameters make tests fast; production uses PARAMS
 * @returns {Promise<string>}
 */
export async function hashPassword(password, params = {}) {
  const problem = checkPassword(password);
  if (problem) throw new Error(problem);
  const { ln = PARAMS.ln, r = PARAMS.r, p = PARAMS.p } = params;
  const salt = randomBytes(PARAMS.saltBytes);
  const key = await derive(password, { ln, r, p, salt, keyBytes: PARAMS.keyBytes });
  return `$scrypt$ln=${ln},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
}

/**
 * Whether the password matches the stored hash; the comparison is constant time for keys of the same length.
 * Throws when the hash string cannot be read — a broken secrets.env is a configuration problem, not a wrong password.
 * @param {unknown} password
 * @param {unknown} text
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, text) {
  const { ln, r, p, salt, key } = parseHash(text);
  if (typeof password !== 'string' || password.length > MAX_PASSWORD) return false;
  const derived = await derive(password, { ln, r, p, salt, keyBytes: key.length });
  return derived.length === key.length && timingSafeEqual(derived, key);
}
