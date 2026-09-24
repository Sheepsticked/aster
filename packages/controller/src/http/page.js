// @ts-check
// Aster controller — paging and filtering for the list routes. Query strings are not coerced, so numbers are parsed here.
// `q` is a plain substring (not a LIKE pattern), matched by our own SQL function because SQLite's lower() folds ASCII only.
export const PER_PAGE = 25;
export const MAX_PER_PAGE = 200;
/** A `q` longer than this is refused: a substring search over the whole table is the one part of a list query that is not indexed. */
export const MAX_Q = 200;
/** The SQL function `q` is matched with; createServer registers it on the connection the routes read. */
export const SEARCH = 'aster_contains';

/**
 * Registers `aster_contains(haystack, needle)` → 1 when the needle is in the haystack, compared case-insensitively in full Unicode
 * (JavaScript's toLowerCase, not SQLite's ASCII-only lower()). A NULL haystack never matches.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function registerSearch(db) {
  db.function(SEARCH, { deterministic: true }, (haystack, needle) =>
    (haystack === null || haystack === undefined ? 0 : String(haystack).toLowerCase().includes(String(needle).toLowerCase()) ? 1 : 0));
}

/** Query fields every list route takes; a route adds its own (`direction`, `status`, …). */
export const PAGE_QUERY = Object.freeze({
  page: { type: 'string', pattern: '^[0-9]{1,6}$' },
  per_page: { type: 'string', pattern: '^[0-9]{1,3}$' },
  q: { type: 'string', maxLength: MAX_Q },
});

/** @typedef {{ page: number, per_page: number, q: string | null }} Query */

/**
 * @param {unknown} query  the request's querystring, already validated against PAGE_QUERY
 * @returns {Query}
 */
export function paging(query) {
  const fields = /** @type {Record<string, string | undefined>} */ (query ?? {});
  const page = Math.max(1, Number(fields.page ?? '1'));
  const asked = Number(fields.per_page ?? String(PER_PAGE));
  const per_page = Math.min(MAX_PER_PAGE, Math.max(1, asked || PER_PAGE));
  const q = typeof fields.q === 'string' && fields.q !== '' ? fields.q : null;
  return { page, per_page, q };
}

/**
 * The envelope every list route answers with: the rows of the page and where the page sits.
 * @template T
 * @param {T[]} items
 * @param {Query} query
 * @param {number} total
 */
export function page(items, query, total) {
  return { items, page: query.page, per_page: query.per_page, total, pages: Math.max(1, Math.ceil(total / query.per_page)) };
}

/** The OFFSET of a page. @param {Query} query */
export const offset = (query) => (query.page - 1) * query.per_page;

/**
 * A WHERE builder for the list routes: every clause carries its parameters, so a caller never concatenates a value into SQL.
 * Usage: const w = where(); w.eq('modem_id', modem); w.like(['sender', 'text'], q); `SELECT … ${w.sql} …`, w.params
 */
export function where() {
  /** @type {string[]} */
  const clauses = [];
  /** @type {Array<string | number>} */
  const params = [];
  return {
    /** @param {string} column @param {string | number | null | undefined} value */
    eq(column, value) {
      if (value === null || value === undefined) return;
      clauses.push(`${column} = ?`);
      params.push(value);
    },
    /** @param {string} column @param {readonly string[] | null | undefined} values */
    in(column, values) {
      if (!values || values.length === 0) return;
      clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    },
    /** @param {string} column @param {number | null | undefined} value */
    atMost(column, value) {
      if (value === null || value === undefined) return;
      clauses.push(`${column} <= ?`);
      params.push(value);
    },
    /** A plain substring in any of the columns, case-insensitively. @param {readonly string[]} columns @param {string | null} value */
    contains(columns, value) {
      if (value === null || columns.length === 0) return;
      clauses.push(`(${columns.map((column) => `${SEARCH}(${column}, ?) = 1`).join(' OR ')})`);
      params.push(...columns.map(() => value));
    },
    /** The SQL, starting with WHERE, or '' when nothing was added. */
    get sql() {
      return clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    },
    get params() {
      return [...params];
    },
  };
}
