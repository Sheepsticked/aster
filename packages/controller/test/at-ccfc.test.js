// @ts-check
// Tests for src/at/ccfc.js: parsing +CCFC answers (disabled, enabled with a number and time, spacing variants, no voice line),
// malformed lines and an empty answer.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parse, voiceStatus, VOICE } from '../src/at/ccfc.js';

describe('at ccfc', () => {
  test('parse(): status, class mask, quoted number and type, optional subaddress/satype/time; other lines are skipped', () => {
    assert.deepEqual(parse(['+CCFC: 0,255']), [{ status: 0, class: 255, number: null, type: null, time: null }]);
    assert.deepEqual(parse(['+CCFC: 0,7', 'OK']), [{ status: 0, class: 7, number: null, type: null, time: null }]);
    assert.deepEqual(parse(['+CCFC: 1,1,"+1234567890",145']), [{ status: 1, class: 1, number: '+1234567890', type: 145, time: null }]);
    assert.deepEqual(parse(['+CCFC: 1,1,"+1234567890",145', '+CCFC: 1,2,"+1234567890",145', '+CCFC: 0,4']), [
      { status: 1, class: 1, number: '+1234567890', type: 145, time: null },
      { status: 1, class: 2, number: '+1234567890', type: 145, time: null },
      { status: 0, class: 4, number: null, type: null, time: null },
    ]);
    assert.deepEqual(parse(['+CCFC: 1,1,"291234567",129,"",128,20']), [{ status: 1, class: 1, number: '291234567', type: 129, time: 20 }]);
    assert.deepEqual(parse(['+CCFC: 1,1,"291234567",129,,,25']), [{ status: 1, class: 1, number: '291234567', type: 129, time: 25 }]);
    assert.deepEqual(parse(['+CCFC: 0,1,"+48123456789",145,,,']), [{ status: 0, class: 1, number: '+48123456789', type: 145, time: null }],
      'a Huawei E173 prints every separator with an empty time');
    assert.deepEqual(parse(['+CCFC: 0,1,"+48123456789",145,,']), [{ status: 0, class: 1, number: '+48123456789', type: 145, time: null }]);
    assert.deepEqual(parse(['  +CCFC:1 , 1 , "+1" , 145  ']), [{ status: 1, class: 1, number: '+1', type: 145, time: null }]);
    assert.deepEqual(parse(['+CCFC: 1,1,"",145']), [{ status: 1, class: 1, number: null, type: 145, time: null }], 'an empty quoted number is none');
    assert.deepEqual(parse(['+CSQ: 20,99', '', 'garbage']), []);
    assert.deepEqual(parse([]), []);
  });

  test('parse(): a +CCFC line that does not read throws SyntaxError (the state would not be verified)', () => {
    assert.throws(() => parse(['+CCFC: x']), /malformed \+CCFC line: "\+CCFC: x"/);
    assert.throws(() => parse(['+CCFC: 1']), /malformed/);
    assert.throws(() => parse(['+CCFC: 1,1,+1234567890,145']), /malformed/, 'the number must be quoted');
    assert.throws(() => parse(['+CCFC: 2,1']), /status must be 0 or 1/);
    assert.throws(() => parse(['+CCFC: 0,256']), /bit mask below 256/);
    assert.throws(() => parse(['+CCFC: 0,255', '+CCFC:']), /malformed/, 'one bad line spoils the answer');
  });

  test('voiceStatus(): the entry whose class includes voice; without one voice is not forwarded; null without any line', () => {
    assert.equal(VOICE, 1);
    assert.deepEqual(voiceStatus(parse(['+CCFC: 0,255'])), { enabled: false, number: null, type: null, class: 255, time: null });
    assert.deepEqual(voiceStatus(parse(['+CCFC: 0,7'])), { enabled: false, number: null, type: null, class: 7, time: null });
    assert.deepEqual(voiceStatus(parse(['+CCFC: 1,1,"+1234567890",145'])), { enabled: true, number: '+1234567890', type: 145, class: 1, time: null });
    assert.deepEqual(voiceStatus(parse(['+CCFC: 0,2', '+CCFC: 1,1,"+1234567890",145', '+CCFC: 1,4,"+375290000000",145'])),
      { enabled: true, number: '+1234567890', type: 145, class: 1, time: null }, 'the voice entry wins over the others');
    assert.deepEqual(voiceStatus(parse(['+CCFC: 1,2,"+1234567890",145', '+CCFC: 1,4,"+1234567890",145'])),
      { enabled: false, number: null, type: null, class: 0, time: null }, 'no voice bit: voice is not forwarded');
    assert.deepEqual(voiceStatus(parse(['+CCFC: 1,16,"+1234567890",145,,,'])), { enabled: false, number: null, type: null, class: 0, time: null },
      'forwarded for synchronous data only, as an operator answered for not reachable');
    assert.deepEqual(voiceStatus(parse(['+CCFC: 0,2', '+CCFC: 0,4'])), { enabled: false, number: null, type: null, class: 0, time: null });
    assert.deepEqual(voiceStatus(parse(['+CCFC: 1,2,"+1",145', '+CCFC: 0,4'])), { enabled: false, number: null, type: null, class: 0, time: null });
    assert.deepEqual(voiceStatus(parse(['+CCFC: 1,1,"+1234567890",145,,,20'])), { enabled: true, number: '+1234567890', type: 145, class: 1, time: 20 }, 'the no-reply wait');
    assert.equal(voiceStatus([]), null);
  });
});
