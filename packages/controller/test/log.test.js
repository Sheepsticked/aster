// @ts-check
// Tests for src/log.js: one JSON object per line, reserved keys, Error/bigint/circular values, level threshold, child loggers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLogger } from '../src/log.js';

/** @param {{ level?: 'debug' | 'info' | 'warn' | 'error', fields?: Record<string, unknown> }} [options] */
function capture(options = {}) {
  /** @type {string[]} */
  const lines = [];
  const log = createLogger({ ...options, stream: { write: (text) => lines.push(text) } });
  return { log, lines, parsed: () => lines.map((line) => JSON.parse(line)) };
}

test('each call writes one line of JSON: ts, level, msg, then the fields', () => {
  const { log, lines } = capture();
  log.info('modem ready', { modem: 'gsm1', rssi: 23 });
  assert.equal(lines.length, 1);
  const line = lines[0] ?? '';
  assert.equal(line.indexOf('\n'), line.length - 1);
  const entry = JSON.parse(line);
  assert.deepEqual(Object.keys(entry), ['ts', 'level', 'msg', 'modem', 'rssi']);
  assert.equal(entry.level, 'info');
  assert.equal(entry.msg, 'modem ready');
  assert.match(entry.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('fields cannot overwrite ts, level or msg', () => {
  const { log, parsed } = capture();
  log.warn('real', { msg: 'fake', level: 'error', ts: 0 });
  const [entry] = parsed();
  assert.deepEqual(entry, { ts: entry.ts, level: 'warn', msg: 'real', field_msg: 'fake', field_level: 'error', field_ts: 0 });
});

test('an Error keeps its message, own properties and stack; a bigint becomes a string; a circular field does not throw', () => {
  const { log, parsed } = capture();
  /** @type {unknown} */
  let fsError;
  try {
    readFileSync('/nonexistent/aster-log-test');
  } catch (err) {
    fsError = err;
  }
  log.error('read failed', { err: fsError, big: 2n ** 70n });
  /** @type {Record<string, unknown>} */
  const loop = {};
  loop.self = loop;
  log.info('loop', { loop });
  const [first, second] = parsed();
  assert.equal(first.err.name, 'Error');
  assert.equal(first.err.code, 'ENOENT');
  assert.match(first.err.message, /no such file or directory/);
  assert.match(first.err.stack, /\n\s+at /);
  assert.equal(first.big, '1180591620717411303424');
  assert.equal(second.msg, 'loop');
  assert.match(second.log_error, /^unserializable fields: /);
});

test('level threshold, fields of the logger and of a child, unknown levels', () => {
  const { log, parsed } = capture({ level: 'warn', fields: { svc: 'controller' } });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.child({ module: 'store' }).error('e', { step: 1 });
  assert.deepEqual(
    parsed().map((entry) => [entry.level, entry.msg, entry.svc, entry.module, entry.step]),
    [['warn', 'w', 'controller', undefined, undefined], ['error', 'e', 'controller', 'store', 1]],
  );
  assert.throws(() => createLogger({ level: /** @type {any} */ ('verbose') }), { message: 'unknown log level: verbose' });
  assert.throws(() => createLogger({ level: /** @type {any} */ ('toString') }), { message: 'unknown log level: toString' });
});
