// @ts-check
// Aster controller — environment: ASTER_HOME, the paths derived from it and the secrets of config/secrets.env as one frozen object.
// Secrets come only from the file (never process.env); a secrets store rewrites it atomically and keeps the object current.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './config/atomic.js';

export const DEFAULT_HOME = '/srv/aster';
export const DEFAULT_TELEGRAM_API = 'https://api.telegram.org';
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @typedef {object} AsterPaths
 * @property {string} config          config/
 * @property {string} registry        config/aster.yaml
 * @property {string} secrets         config/secrets.env
 * @property {string} asteriskConfig  config/asterisk/ (hand-owned native files, mounted at /etc/asterisk)
 * @property {string} state           state/
 * @property {string} db              state/aster.db
 * @property {string} prev            state/prev/ (one previous applied version per hand-owned file)
 * @property {string} spool           spool/ (events/, quarantine/)
 * @property {string} logs            logs/
 */
/**
 * @typedef {object} AmiTarget
 * @property {string} host      ASTER_AMI_HOST, default 127.0.0.1 (both containers share the host network)
 * @property {number} port      ASTER_AMI_PORT, default 5038
 * @property {string} username  `aster`, the user install.sh writes into manager.conf; the secret is ASTER_AMI_SECRET of secrets.env
 */
/**
 * @typedef {object} HttpTarget
 * @property {string} host  ASTER_HTTP_HOST, default 0.0.0.0 (the LAN; the controller container shares the host network)
 * @property {number} port  ASTER_HTTP_PORT, default 80 (0 asks for a free one)
 */
/**
 * @typedef {object} AsterEnv
 * @property {string} home
 * @property {Readonly<AsterPaths>} paths
 * @property {Readonly<Record<string, string>>} secrets
 * @property {Readonly<AmiTarget>} ami
 * @property {Readonly<HttpTarget>} http
 * @property {string} uiDir  ASTER_UI_DIR, default packages/ui/dist beside the controller; until it holds an
 *   index.html the server answers every non-API path 503 (http/server.js)
 * @property {string} sysfsRoot  ASTER_SYSFS_ROOT, default /sys (the host's sysfs, mounted read-only into the container)
 * @property {string} telegramApi  ASTER_TELEGRAM_API, default https://api.telegram.org: the Bot API base URL without a trailing slash
 *   (tests and the end-to-end run point it at a fake server)
 * @property {boolean} amiMock  ASTER_AMI_MOCK=1: talk to the stand-in of ami/mock.js instead of Asterisk, for developing the UI
 *   without an appliance. It replaces the AMI target, so ASTER_AMI_HOST/PORT and ASTER_AMI_SECRET are then unused.
 */

/**
 * Parses the text of a secrets.env file. One entry per line (LF or CRLF, a leading BOM is ignored):
 *   blank line | # comment | KEY=value | KEY='value' | KEY="value"
 * KEY is [A-Za-z_][A-Za-z0-9_]* followed directly by `=`. An unquoted value is the rest of the line without surrounding
 * whitespace; a quoted value is the text between its quotes. Values are literal: no escapes, no `$` expansion, no inline
 * comments. A malformed line or a repeated key throws an error that names the file and line, never the value.
 * @param {string} text
 * @param {string} [source] file name for error messages
 * @returns {Record<string, string>} null-prototype object
 */
export function parseSecrets(text, source = 'secrets.env') {
  /** @type {Record<string, string>} */
  const out = Object.create(null);
  /** @type {Map<string, number>} */
  const seenOn = new Map();
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  for (const [index, raw] of lines.entries()) {
    const n = index + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`${source}:${n}: expected KEY=value`);
    const key = line.slice(0, eq);
    if (!KEY.test(key)) throw new Error(`${source}:${n}: invalid key (letters, digits and _, not starting with a digit)`);
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || !value.endsWith(quote)) throw new Error(`${source}:${n}: ${key}: unterminated quote`);
      value = value.slice(1, -1);
    }
    const earlier = seenOn.get(key);
    if (earlier !== undefined) throw new Error(`${source}:${n}: ${key} is already set on line ${earlier}`);
    seenOn.set(key, n);
    out[key] = value;
  }
  return out;
}

/**
 * How a value is written so that parseSecrets reads it back unchanged: as it is when it has no surrounding whitespace and does
 * not begin with a quote, else in double (or, when it contains one, single) quotes. A value that cannot survive the format —
 * a line break, a control character, or both quote characters around whitespace — is refused before anything is written.
 * @param {string} key
 * @param {string} value
 */
function formatValue(key, value) {
  if (/[\r\n\0]/.test(value) || [...value].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)) {
    throw new Error(`${key}: a secret must not contain line breaks or control characters`);
  }
  if (value === value.trim() && !value.startsWith('"') && !value.startsWith("'")) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error(`${key}: a secret with surrounding whitespace cannot contain both ' and "`);
}

/**
 * The text of a secrets.env file with `changes` applied: an existing key is rewritten in place, a new one is appended, and a
 * key set to null is removed. Comments, blank lines and the order of the other lines are kept; the result ends with one LF.
 * @param {string} text
 * @param {Readonly<Record<string, string | null>>} changes
 * @returns {string}
 */
export function updateSecretsText(text, changes) {
  const entries = Object.entries(changes);
  for (const [key] of entries) if (!KEY.test(key)) throw new Error(`invalid key (letters, digits and _, not starting with a digit): ${JSON.stringify(key)}`);
  const done = new Set();
  const lines = text.replace(/^﻿/, '').split('\n');
  /** @type {string[]} */
  const out = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    if (index === lines.length - 1 && line === '') continue; // the trailing LF is added back at the end
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    const key = trimmed === '' || trimmed.startsWith('#') || eq < 0 ? null : trimmed.slice(0, eq);
    if (key === null || !KEY.test(key) || !(key in changes)) {
      out.push(line);
      continue;
    }
    done.add(key);
    const value = changes[key];
    if (value !== null && value !== undefined) out.push(`${key}=${formatValue(key, value)}`);
  }
  for (const [key, value] of entries) {
    if (done.has(key) || value === null || value === undefined) continue;
    out.push(`${key}=${formatValue(key, value)}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * The secrets of a file as one object that stays current: `get()` is the frozen object every module reads, `set(changes)`
 * rewrites the file atomically (keeping its mode, so a 0600 secrets.env stays 0600), re-parses what was written and returns
 * the new object. The file is read once here; nothing else writes it while the controller runs.
 * @param {string} path  config/secrets.env
 * @param {Readonly<Record<string, string>>} [initial]  the secrets already read by loadEnv (read from the file when absent)
 */
export function createSecretsStore(path, initial) {
  let current = initial ?? Object.freeze(parseSecrets(readFileSync(path, 'utf8'), path));
  return {
    path,
    /** @returns {Readonly<Record<string, string>>} */
    get: () => current,
    /**
     * @param {Readonly<Record<string, string | null>>} changes  a null value removes the key
     * @returns {Readonly<Record<string, string>>} the secrets after the write
     */
    set(changes) {
      const text = updateSecretsText(readFileSync(path, 'utf8'), changes);
      writeAtomic(path, text);
      current = Object.freeze(parseSecrets(text, path));
      return current;
    },
  };
}

/** @typedef {ReturnType<typeof createSecretsStore>} SecretsStore */

/**
 * ASTER_TELEGRAM_API → an http(s) base URL without credentials, query, fragment or trailing slash.
 * @param {string | undefined} text
 */
function telegramApiOf(text) {
  if (text === undefined || text === '') return DEFAULT_TELEGRAM_API;
  /** @type {URL | null} */
  let url = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error(`ASTER_TELEGRAM_API must be an http or https URL without credentials, query or fragment, not ${JSON.stringify(text)}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Resolves ASTER_HOME and its paths, reads the secrets file, the AMI target (ASTER_AMI_HOST/ASTER_AMI_PORT), the sysfs root
 * (ASTER_SYSFS_ROOT) and the Telegram Bot API base (ASTER_TELEGRAM_API). A missing or unreadable secrets file is an error that
 * names the path; which secrets must be present is checked by the modules that use them.
 * @param {NodeJS.ProcessEnv} [environ]
 * @returns {Readonly<AsterEnv>}
 */
export function loadEnv(environ = process.env) {
  const home = resolve(environ.ASTER_HOME || DEFAULT_HOME);
  const config = join(home, 'config');
  const state = join(home, 'state');
  /** @type {Readonly<AsterPaths>} */
  const paths = Object.freeze({
    config,
    registry: join(config, 'aster.yaml'),
    secrets: join(config, 'secrets.env'),
    asteriskConfig: join(config, 'asterisk'),
    state,
    db: join(state, 'aster.db'),
    prev: join(state, 'prev'),
    spool: join(home, 'spool'),
    logs: join(home, 'logs'),
  });
  let text;
  try {
    text = readFileSync(paths.secrets, 'utf8');
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      throw new Error(`secrets file not found: ${paths.secrets} (install.sh creates it; ASTER_HOME=${home})`, { cause: err });
    }
    if (code === 'EACCES') {
      throw new Error(`secrets file is not readable by uid ${process.getuid?.() ?? '?'}: ${paths.secrets}`, { cause: err });
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read secrets file ${paths.secrets}: ${reason}`, { cause: err });
  }
  const secrets = Object.freeze(parseSecrets(text, paths.secrets));
  const portText = environ.ASTER_AMI_PORT;
  const port = portText === undefined || portText === '' ? 5038 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ASTER_AMI_PORT must be a port number (1–65535), not ${JSON.stringify(portText)}`);
  const ami = Object.freeze({ host: environ.ASTER_AMI_HOST || '127.0.0.1', port, username: 'aster' });
  const httpText = environ.ASTER_HTTP_PORT;
  const httpPort = httpText === undefined || httpText === '' ? 80 : Number(httpText);
  if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
    throw new Error(`ASTER_HTTP_PORT must be a port number (0–65535; 0 asks for a free one), not ${JSON.stringify(httpText)}`);
  }
  const http = Object.freeze({ host: environ.ASTER_HTTP_HOST || '0.0.0.0', port: httpPort });
  const uiDir = resolve(environ.ASTER_UI_DIR || fileURLToPath(new URL('../../ui/dist', import.meta.url)));
  const sysfsRoot = resolve(environ.ASTER_SYSFS_ROOT || '/sys');
  const telegramApi = telegramApiOf(environ.ASTER_TELEGRAM_API);
  // Only `1` enables the stand-in, so a stray value never disconnects a real appliance from Asterisk.
  const amiMock = environ.ASTER_AMI_MOCK === '1';
  return Object.freeze({ home, paths, secrets, ami, http, uiDir, sysfsRoot, telegramApi, amiMock });
}
