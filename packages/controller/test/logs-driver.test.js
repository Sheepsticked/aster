// @ts-check
// Tests for src/logs/driver.js: the newest ERROR/WARNING line of one modem from the Asterisk full log, in both line formats.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { lastDriverError } from '../src/logs/driver.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-driver-log-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** @param {string} name @param {string[]} lines */
function logFile(name, lines) {
  const path = join(tmp, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

describe('driver errors from the Asterisk log', () => {
  test('the newest ERROR or WARNING naming the modem, with how often its text is in the log; other modems and levels are left out', () => {
    const path = logFile('full', [
      '[2026-09-24 19:12:21] ERROR[1294] at_response.c: [gsm1] Getting IMSI number failed',
      '[2026-09-24 19:12:21] ERROR[1295] at_response.c: [gsm3] Getting IMSI number failed',
      '[2026-09-24 19:12:30] WARNING[975][C-00000003]: channel.c:223 channel_request: [gsm1] Request to call on device which can not make call at this moment',
      '[2026-09-24 19:12:36] ERROR[1296] at_response.c: [gsm1] Getting IMSI number failed',
      '[2026-09-24 19:12:36] ERROR[1297] at_response.c: [gsm10] Something else',
      '[2026-09-24 19:12:51] VERBOSE[1298] chan_dongle.c: [gsm1] Error initializing Dongle',
      '[2026-09-24 19:12:52] NOTICE[1298] chan_dongle.c: [gsm1] Dongle has disconnected',
    ]);
    assert.deepEqual(lastDriverError(path, 'gsm1'),
      { at: Date.UTC(2026, 8, 24, 19, 12, 36), level: 'ERROR', text: 'Getting IMSI number failed', count: 2 });
    assert.deepEqual(lastDriverError(path, 'gsm3'),
      { at: Date.UTC(2026, 8, 24, 19, 12, 21), level: 'ERROR', text: 'Getting IMSI number failed', count: 1 });
    assert.equal(lastDriverError(path, 'gsm2'), null, 'no line of gsm2');
    assert.equal(lastDriverError(join(tmp, 'missing'), 'gsm1'), null, 'no log yet');
  });

  test('a WARNING that comes last wins, and a line without the log time is skipped', () => {
    const path = logFile('warning', [
      '[2026-09-24 19:12:36] ERROR[1296] at_response.c: [gsm1] Getting IMSI number failed',
      'Asterisk 20.21.0 built by root: [gsm1] a line without a time',
      '[2026-09-24 19:13:00] WARNING[975][C-00000004]: channel.c:223 channel_request: [gsm1] Request to call on device which can not make call at this moment',
    ]);
    assert.deepEqual(lastDriverError(path, 'gsm1'), { at: Date.UTC(2026, 8, 24, 19, 13, 0), level: 'WARNING',
      text: 'Request to call on device which can not make call at this moment', count: 1 });
  });
});
