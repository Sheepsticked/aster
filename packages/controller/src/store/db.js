// @ts-check
// Aster controller — SQLite store (node:sqlite): opens state/aster.db (WAL) and applies the numbered migrations in ./migrations,
// each in its own transaction with the new schema_version (so migration files have no BEGIN/COMMIT).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE = /^(\d{3})\.sql$/;

/** @param {unknown} err */
const reason = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Opens a database file (created if absent; its directory must exist) and applies the connection settings.
 * @param {string} path
 * @returns {DatabaseSync}
 */
export function open(path) {
  let db;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    throw new Error(`cannot open database ${path}: ${reason(err)}`, { cause: err });
  }
  try {
    const mode = db.prepare('PRAGMA journal_mode = WAL').get();
    if (mode?.journal_mode !== 'wal') throw new Error(`journal_mode is ${String(mode?.journal_mode)}, expected wal`);
    // NORMAL limits SD-card fsyncs; a power loss may lose the last commits but never corrupts the WAL database.
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    // Keep temporary data and a larger page cache in RAM to limit SD-card writes.
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA cache_size = -32000');
  } catch (err) {
    db.close();
    throw new Error(`cannot configure database ${path}: ${reason(err)}`, { cause: err });
  }
  return db;
}

/**
 * @typedef {object} Migration
 * @property {number} version
 * @property {string} file
 */

/**
 * Lists the migrations of a directory. Every file must be named NNN.sql, numbered from 001 without gaps.
 * @param {string} [dir]
 * @returns {Migration[]}
 */
export function listMigrations(dir = MIGRATIONS_DIR) {
  const migrations = readdirSync(dir).sort().map((name) => {
    const match = MIGRATION_FILE.exec(name);
    if (!match) throw new Error(`unexpected file in migrations directory ${dir}: ${name} (expected NNN.sql)`);
    return { version: Number(match[1]), file: join(dir, name) };
  });
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      const last = String(migrations.length).padStart(3, '0');
      throw new Error(`migrations in ${dir} must be numbered 001..${last} without gaps; found ${migration.file}`);
    }
  }
  return migrations;
}

/**
 * Reads settings.schema_version: 0 while the settings table or the row does not exist.
 * @param {DatabaseSync} db
 * @returns {number}
 */
export function schemaVersion(db) {
  const table = db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'settings'").get();
  if (!table) return 0;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
  if (!row) return 0;
  const value = row.value;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`settings.schema_version is not a version number: ${String(value)}`);
  }
  return Number(value);
}

/** @param {DatabaseSync} db */
function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite has already rolled the transaction back itself (e.g. after SQLITE_FULL); the original error is rethrown.
  }
}

/**
 * Runs fn inside BEGIN IMMEDIATE … COMMIT and returns its result; a throw rolls back and is rethrown.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    rollback(db);
    throw err;
  }
}

/**
 * Applies every migration above the database's schema_version in order. Each step runs inside BEGIN IMMEDIATE … COMMIT
 * together with its schema_version row; the version is read again inside that write transaction, so a step another
 * process committed in the meantime is skipped. A failed step is rolled back and thrown; the steps before it stay.
 * A database whose schema_version is above the newest migration of this build is refused.
 * @param {DatabaseSync} db
 * @param {{ dir?: string }} [options]  dir: migrations directory (tests)
 * @returns {{ from: number, to: number, applied: number[] }}
 */
export function migrate(db, { dir = MIGRATIONS_DIR } = {}) {
  const migrations = listMigrations(dir);
  const latest = migrations.length;
  const from = schemaVersion(db);
  if (from > latest) {
    throw new Error(`database schema_version ${from} is newer than this controller (latest migration ${latest}); refusing to use it`);
  }
  /** @type {number[]} */
  const applied = [];
  for (const { version, file } of migrations) {
    if (version <= from) continue;
    const sql = readFileSync(file, 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (schemaVersion(db) < version) {
        db.exec(sql);
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        ).run(String(version));
        applied.push(version);
      }
      db.exec('COMMIT');
    } catch (err) {
      rollback(db);
      throw new Error(`migration ${file} failed: ${reason(err)}`, { cause: err });
    }
  }
  return { from, to: schemaVersion(db), applied };
}

/**
 * Names of the user tables (without SQLite's internal sqlite_* tables), sorted.
 * @param {DatabaseSync} db
 * @returns {string[]}
 */
export function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}
