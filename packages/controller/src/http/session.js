// @ts-check
// Aster controller — cookie sessions: one row per random id (the only secret), cookie `aster_sid`, never Secure
// (plain HTTP on the LAN). A session expires 30 days after creation; all are cleared when the password changes.
import { randomBytes } from 'node:crypto';

export const COOKIE = 'aster_sid';
export const DEFAULTS = Object.freeze(/** @type {Readonly<{ maxAgeMs: number, touchMs: number }>} */ ({
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days, the cookie's Max-Age
  touchMs: 900_000,                   // last_seen_at is written at most once every 15 min to limit SD-card writes
}));
const ID_BYTES = 32;
/** What a cookie value must look like to be worth a database lookup (what create() produces). */
const ID = /^[A-Za-z0-9_-]{43}$/;

/** @typedef {{ id: string, created_at: number, last_seen_at: number }} Session */
/** @typedef {import('node:sqlite').DatabaseSync} Database */

const INSERT = 'INSERT INTO sessions (id, created_at, last_seen_at) VALUES (?, ?, ?)';
const SELECT = 'SELECT id, created_at, last_seen_at FROM sessions WHERE id = ?';
const TOUCH = 'UPDATE sessions SET last_seen_at = ? WHERE id = ?';
const DELETE = 'DELETE FROM sessions WHERE id = ?';
const PURGE = 'DELETE FROM sessions WHERE created_at <= ?';
const CLEAR = 'DELETE FROM sessions';
const COUNT = 'SELECT count(*) AS n FROM sessions';

/**
 * The cookies of a request header, last value per name (a duplicated name is a client mistake; the first is kept).
 * @param {string | string[] | undefined} header
 * @returns {Map<string, string>}
 */
export function parseCookies(header) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const text = Array.isArray(header) ? header.join('; ') : header;
  if (typeof text !== 'string') return out;
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || out.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out.set(name, value);
  }
  return out;
}

/**
 * The session id of a request's Cookie header, or null when there is none that could be one.
 * @param {string | string[] | undefined} header
 * @returns {string | null}
 */
export function cookieSessionId(header) {
  const value = parseCookies(header).get(COOKIE);
  return value !== undefined && ID.test(value) ? value : null;
}

/**
 * @param {{ db: Database, now?: () => number, timing?: Partial<typeof DEFAULTS> }} options
 */
export function createSessions({ db, now = Date.now, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };
  const insert = db.prepare(INSERT);
  const select = db.prepare(SELECT);
  const touchRow = db.prepare(TOUCH);
  const remove = db.prepare(DELETE);
  const purgeRows = db.prepare(PURGE);
  const clearRows = db.prepare(CLEAR);
  const countRows = db.prepare(COUNT);

  /** @param {unknown} raw @returns {Session} */
  const toSession = (raw) => {
    const row = /** @type {{ id: string, created_at: number, last_seen_at: number }} */ (raw);
    return { id: String(row.id), created_at: Number(row.created_at), last_seen_at: Number(row.last_seen_at) };
  };

  return {
    maxAgeMs: t.maxAgeMs,

    /** A new session row. @returns {Session} */
    create() {
      const at = now();
      const id = randomBytes(ID_BYTES).toString('base64url');
      insert.run(id, at, at);
      return { id, created_at: at, last_seen_at: at };
    },

    /**
     * The session of an id, or null when it is unknown or older than maxAgeMs (an expired row is deleted here).
     * @param {string | null} id
     * @returns {Session | null}
     */
    get(id) {
      if (id === null || !ID.test(id)) return null;
      const raw = select.get(id);
      if (!raw) return null;
      const session = toSession(raw);
      if (now() - session.created_at > t.maxAgeMs) {
        remove.run(session.id);
        return null;
      }
      return session;
    },

    /**
     * Records that the session was used; writes at most once per touchMs, so a GET that follows another one writes nothing.
     * @param {Session} session
     * @returns {boolean} whether the row was written
     */
    touch(session) {
      const at = now();
      if (at - session.last_seen_at < t.touchMs) return false;
      touchRow.run(at, session.id);
      return true;
    },

    /** @param {string} id */
    destroy(id) {
      return remove.run(id).changes > 0;
    },

    /** Deletes every session (a password change). @returns {number} rows deleted */
    clear() {
      return Number(clearRows.run().changes);
    },

    /** Deletes expired rows. @returns {number} rows deleted */
    purge() {
      return Number(purgeRows.run(now() - t.maxAgeMs).changes);
    },

    count() {
      return Number(/** @type {{ n: number }} */ (countRows.get()).n);
    },

    /** The Set-Cookie value that starts the session. @param {string} id */
    cookie(id) {
      return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(t.maxAgeMs / 1000)}`;
    },

    /** The Set-Cookie value that ends it (logout, and a request with a session that no longer exists). */
    expiredCookie() {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    },
  };
}

/** @typedef {ReturnType<typeof createSessions>} Sessions */
