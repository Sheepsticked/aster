// @ts-check
// Tests for src/notify/chunk.js: long texts are cut at a line feed or at the 4096 limit, never inside a surrogate pair, and
// the parts rebuild the text.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chunk, TELEGRAM_TEXT_MAX } from '../src/notify/chunk.js';

const EMOJI = String.fromCodePoint(0x1f44d); // two UTF-16 code units

/**
 * The text again from parts cut at line feeds (`glue` '\n') or at the limit ('').
 * @param {string[]} parts
 * @param {string[]} glue  what stood between part i and part i+1
 */
const rebuild = (parts, glue) => parts.map((part, index) => part + (glue[index] ?? '')).join('');

describe('notify chunk', () => {
  test('a text of at most 4096 code units is one part, unchanged', () => {
    assert.equal(TELEGRAM_TEXT_MAX, 4096);
    assert.deepEqual(chunk('SMS gsm1 from +1234567890\nПривет'), ['SMS gsm1 from +1234567890\nПривет']);
    const exact = 'я'.repeat(4096);
    assert.deepEqual(chunk(exact), [exact]);
    const emojis = EMOJI.repeat(2048);
    assert.equal(emojis.length, 4096);
    assert.deepEqual(chunk(emojis), [emojis]);
  });

  test('a longer text is cut at the last line feed within the limit, which is dropped', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line ${String(index).padStart(3, '0')} ${'x'.repeat(20)}`);
    const text = lines.join('\n');
    const parts = chunk(text);
    assert.ok(parts.length >= 2);
    for (const part of parts) {
      assert.ok(part.length <= 4096, `part of ${part.length}`);
      assert.ok(!part.startsWith('\n') && !part.endsWith('\n'));
    }
    assert.equal(parts.join('\n'), text);
    // the first cut is the last line feed at or before index 4096
    assert.equal(parts[0], text.slice(0, text.lastIndexOf('\n', 4096)));
  });

  test('a line feed right after the limit still makes a full first part', () => {
    const text = `${'a'.repeat(4096)}\n${'b'.repeat(10)}`;
    assert.deepEqual(chunk(text), ['a'.repeat(4096), 'b'.repeat(10)]);
    const later = `${'a'.repeat(4097)}\n${'b'.repeat(10)}`;
    assert.deepEqual(chunk(later), ['a'.repeat(4096), `a\n${'b'.repeat(10)}`]);
  });

  test('without a line feed the cut is at the limit, one earlier when it would split a surrogate pair', () => {
    const plain = 'z'.repeat(9000);
    assert.deepEqual(chunk(plain).map((part) => part.length), [4096, 4096, 808]);
    assert.equal(rebuild(chunk(plain), ['', '']), plain);
    const shifted = `z${EMOJI.repeat(3000)}`; // code unit 4095 is the high half of an emoji
    const parts = chunk(shifted);
    assert.deepEqual(parts.map((part) => part.length), [4095, 1906]);
    assert.equal(parts.join(''), shifted);
    for (const part of parts) assert.ok(!/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part), 'no lone surrogate at a cut');
  });

  test('a line feed only at the very start does not make an empty part', () => {
    const text = `\n${'q'.repeat(5000)}`;
    const parts = chunk(text);
    assert.deepEqual(parts.map((part) => part.length), [4096, 905]);
    assert.equal(parts.join(''), text);
  });

  test('blank parts are dropped (Telegram refuses an empty message); a blank text has no parts', () => {
    assert.deepEqual(chunk(''), []);
    assert.deepEqual(chunk(' \n\t '), []);
    // line feeds inside a part stay (Telegram trims them at the ends); a part made of nothing but line feeds is dropped
    const text = `${'a'.repeat(4096)}${'\n'.repeat(5000)}${'b'.repeat(10)}`;
    assert.deepEqual(chunk(text), ['a'.repeat(4096), `${'\n'.repeat(902)}${'b'.repeat(10)}`]);
  });

  test('a smaller limit works the same way and a nonsensical one is refused', () => {
    assert.deepEqual(chunk('ab\ncd\nef', 5), ['ab\ncd', 'ef']);
    assert.deepEqual(chunk('abcdefgh', 3), ['abc', 'def', 'gh']);
    assert.throws(() => chunk('abc', 1), RangeError);
    assert.throws(() => chunk('abc', 2.5), RangeError);
  });
});
