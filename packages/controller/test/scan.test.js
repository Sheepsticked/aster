// @ts-check
// Tests for src/config/scan.js against main/config.c of Asterisk 20: line kinds, `;` comments and `\;` escapes, block
// comments, the line limit, CRLF, BOM and control characters.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_LINE_BYTES, scan, strip } from '../src/config/scan.js';

/** @param {string[]} lines */
const text = (lines) => `${lines.join('\n')}\n`;
/**
 * The scanned lines without the fields a case does not look at.
 * @param {string[]} lines
 * @param {string[]} fields
 */
const pick = (lines, fields) =>
  scan(text(lines)).lines.map((line) => Object.fromEntries(Object.entries(line).filter(([field]) => fields.includes(field))));

describe('scan', () => {
  test('line kinds', () => {
    assert.deepEqual(pick([
      '; comment', '', '[general]', 'static = yes', '[tmpl](!)', 'exten => s,1,NoOp()', '#include "aster.d/modems.conf"', '#exec /bin/true',
      'junk',
    ], ['no', 'kind']), [
      { no: 1, kind: 'comment' }, { no: 2, kind: 'blank' }, { no: 3, kind: 'section' }, { no: 4, kind: 'kv' }, { no: 5, kind: 'template' },
      { no: 6, kind: 'arrow' }, { no: 7, kind: 'include' }, { no: 8, kind: 'exec' }, { no: 9, kind: 'other' },
    ]);
  });

  test('section headers: name up to the first ], options only right after it, (!) template, (+) append, bases in order', () => {
    assert.deepEqual(pick([
      '[a](b,c)', '[t](!,b)', '[a](+)', '[a](+type=endpoint)', '[ spaced ]', '[a]()', '[a] (b)', '[a]]', '[a](b)c',
    ], ['kind', 'name', 'inherits', 'append', 'error']), [
      { kind: 'section', name: 'a', inherits: ['b', 'c'], append: false },
      { kind: 'template', name: 't', inherits: ['b'], append: false },
      { kind: 'section', name: 'a', inherits: [], append: true },
      { kind: 'section', name: 'a', inherits: [], append: true },
      { kind: 'section', name: ' spaced ', inherits: [], append: false },
      { kind: 'section', name: 'a', inherits: [''], append: false },
      { kind: 'section', name: 'a', inherits: [], append: false, error: 'text after the section header — Asterisk ignores it' },
      { kind: 'section', name: 'a', inherits: [], append: false, error: 'text after the section header — Asterisk ignores it' },
      { kind: 'section', name: 'a', inherits: ['b'], append: false, error: 'text after the section header — Asterisk ignores it' },
    ]);
  });

  test('malformed headers are rejected but still name the section of the lines below them', () => {
    assert.deepEqual(pick(['[defaults', 'initstate = stop', '[a](b', 'x = 1'], ['kind', 'section', 'error']), [
      { kind: 'other', section: 'defaults', error: 'no closing ] — Asterisk rejects the whole file' },
      { kind: 'kv', section: 'defaults' },
      { kind: 'other', section: 'a', error: 'no closing ) in [name](…) — Asterisk rejects the whole file' },
      { kind: 'kv', section: 'a' },
    ]);
  });

  test('the section of a line is the last header above it in the file; null before the first', () => {
    assert.deepEqual(pick(['x = 1', '[a]', 'y = 2', '#include f.conf', '[b](+)', 'z = 3'], ['section', 'variable']), [
      { section: null, variable: true }, { section: 'a' }, { section: 'a', variable: true }, { section: 'a' }, { section: 'b' },
      { section: 'b', variable: true },
    ]);
    assert.deepEqual(scan(text(['[a]', '[b](!)', 'x', '[c](a,b)'])).sections, [
      { no: 1, name: 'a', template: false, inherits: [], append: false },
      { no: 2, name: 'b', template: true, inherits: [], append: false },
      { no: 4, name: 'c', template: false, inherits: ['a', 'b'], append: false },
    ]);
  });

  test('directives: the word is case-insensitive and ends at a blank; "…" or <…> around the target are removed', () => {
    assert.deepEqual(pick([
      '#INCLUDE "x.conf"', '#tryinclude <y.conf>', '#include "z.conf', '#include\tx.conf   ; comment', '#exec /bin/list "a b"', '#include',
      '#tryexec /bin/true', '# include x', '#include"x"',
    ], ['kind', 'directive', 'target', 'error']), [
      { kind: 'include', directive: 'include', target: 'x.conf' },
      { kind: 'include', directive: 'tryinclude', target: 'y.conf' },
      { kind: 'include', directive: 'include', target: '"z.conf' },
      { kind: 'include', directive: 'include', target: 'x.conf' },
      { kind: 'exec', directive: 'exec', target: '/bin/list "a b"' },
      { kind: 'include', directive: 'include', error: '#include needs an argument — Asterisk ignores this line' },
      { kind: 'other', directive: 'tryexec', error: 'unknown directive #tryexec — Asterisk ignores this line' },
      { kind: 'other', directive: '', error: 'unknown directive # — Asterisk ignores this line' },
      { kind: 'other', directive: 'include"x"', error: 'unknown directive #include"x" — Asterisk ignores this line' },
    ]);
  });

  test('key lines: = and =>, += appends, blanks around key and value are stripped, later = stay in the value', () => {
    assert.deepEqual(pick([
      'key=value', '  key   =   value  ', 'exten => s,1,Set(A=B)', 'password=>abc', 'password= >abc', 'a =>> b', 'allow += g722', 'a=', 'a+=',
    ], ['kind', 'key', 'value', 'plus']), [
      { kind: 'kv', key: 'key', value: 'value' },
      { kind: 'kv', key: 'key', value: 'value' },
      { kind: 'arrow', key: 'exten', value: 's,1,Set(A=B)' },
      { kind: 'arrow', key: 'password', value: 'abc' },
      { kind: 'kv', key: 'password', value: '>abc' },
      { kind: 'arrow', key: 'a', value: '> b' },
      { kind: 'kv', key: 'allow', value: 'g722', plus: true },
      { kind: 'kv', key: 'a', value: '' },
      { kind: 'kv', key: 'a', value: '', plus: true },
    ]);
  });

  test('malformed key lines: no =, no name, a leading \\ before a blank; \\ escapes the first character of a key', () => {
    assert.deepEqual(pick(['junk', '=b', '+=b', '\\ x=y', '\\', '\\=x=y', '\\[a]=1'], ['kind', 'key', 'value', 'error']), [
      { kind: 'other', error: 'no = in this line — Asterisk ignores it' },
      { kind: 'other', error: 'no name before = — Asterisk ignores this line' },
      { kind: 'other', error: 'no name before = — Asterisk ignores this line' },
      { kind: 'other', error: '\\ at the start of a line must be followed by a visible character — Asterisk rejects the whole file' },
      { kind: 'other', error: '\\ at the start of a line must be followed by a visible character — Asterisk rejects the whole file' },
      { kind: 'kv', key: '=x', value: 'y' },
      { kind: 'kv', key: '[a]', value: '1' },
    ]);
  });

  test('; starts a comment unless escaped; \\; is a literal ;', () => {
    assert.deepEqual(pick(['a = b ; comment', 'a = b\\;c', 'a = b\\\\;c', '; [not-a-section]', 'a = b;--- not a block', '[s] ; c'], ['kind', 'value', 'name']), [
      { kind: 'kv', value: 'b' },
      { kind: 'kv', value: 'b;c' },
      { kind: 'kv', value: 'b\\;c' },
      { kind: 'comment' },
      { kind: 'kv', value: 'b' },
      { kind: 'section', name: 's' },
    ]);
  });

  test(';-- --; comments span lines and nest; text after the closing --; is read, text before ;-- too', () => {
    assert.deepEqual(pick([
      'a = 1 ;-- start', '[not-a-section]', 'end --; b = 2', 'c = 3', ';-- outer ;-- inner --; still --;', 'd = 4', ';-- one line --; e = 5',
      'f = 6 ;-- x --; ; g', 'h ;-- x --; = 7',
    ], ['kind', 'key', 'value']), [
      { kind: 'kv', key: 'a', value: '1' },
      { kind: 'comment' },
      { kind: 'kv', key: 'b', value: '2' },
      { kind: 'kv', key: 'c', value: '3' },
      { kind: 'comment' },
      { kind: 'kv', key: 'd', value: '4' },
      { kind: 'kv', key: 'e', value: '5' },
      { kind: 'kv', key: 'f', value: '6' },
      { kind: 'kv', key: 'h', value: '7' },
    ]);
    assert.deepEqual(scan(text(['a = 1 ;-- start', 'end --;'])).problems, []);
  });

  test('a --; that closes nothing keeps its line and turns the following lines into a comment until a ;--', () => {
    const { lines, problems } = scan(text(['a = b --; c', 'd = e', ';--', 'f = g']));
    assert.deepEqual(lines.map((line) => [line.kind, line.value]), [['kv', 'b --; c'], ['comment', undefined], ['comment', undefined], ['kv', 'g']]);
    assert.deepEqual(problems, [{ no: 1, message: '--; closes no ;-- comment — Asterisk reads the lines after it as a comment' }]);
  });

  test('a ;-- that is never closed is reported at its line', () => {
    const { lines, problems } = scan(text(['x = 1', ';-- never closed', 'y = 2']));
    assert.deepEqual(lines.map((line) => line.kind), ['kv', 'comment', 'comment']);
    assert.deepEqual(problems, [{ no: 2, message: ';-- opens a comment that no --; closes — Asterisk ignores the rest of the file' }]);
  });

  test(`lines longer than ${MAX_LINE_BYTES} bytes are skipped; the limit counts UTF-8 bytes`, () => {
    const ok = `k=${'v'.repeat(MAX_LINE_BYTES - 2)}`;
    assert.deepEqual(pick(['[s]', ok, `${ok}v`, `k=${'д'.repeat(4095)}`], ['kind', 'error']), [
      { kind: 'section' },
      { kind: 'kv' },
      { kind: 'other', error: 'longer than 8190 bytes — Asterisk skips this line' },
      { kind: 'other', error: 'longer than 8190 bytes — Asterisk skips this line' },
    ]);
  });

  test('CRLF line ends, a UTF-8 BOM before line 1 and control characters around values are ignored like ast_strip does', () => {
    const control = String.fromCharCode(1);
    const scanned = scan(`${String.fromCharCode(0xfeff)}[general]\r\nstatic = yes\r\na = b\t${control}\r\n`);
    assert.deepEqual(scanned.lines.map((line) => [line.kind, line.name ?? line.key, line.value]), [
      ['section', 'general', undefined], ['kv', 'static', 'yes'], ['kv', 'a', 'b'],
    ]);
    assert.equal(strip(` ${control}x y\t\r`), 'x y');
    assert.equal(strip('ü'), 'ü');
  });

  test('line numbers: an empty text has no lines, a final LF adds none, blank lines count', () => {
    assert.deepEqual(scan('').lines, []);
    assert.equal(scan('a=b').lines.length, 1);
    assert.equal(scan('a=b\n').lines.length, 1);
    assert.deepEqual(scan('\n').lines.map((line) => line.kind), ['blank']);
    assert.deepEqual(scan('[a]\n\nx=1\n').lines.map((line) => line.no), [1, 2, 3]);
  });
});
