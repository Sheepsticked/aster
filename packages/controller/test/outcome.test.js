// @ts-check
// Tests for src/calls/outcome.js: every documented DIALSTATUS with each ANSWEREDTIME and disposition, both directions,
// unexpected values, missed-call reasons, and the captured call-end events of test/fixtures/spool/calls.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { MISSED_REASONS, missedReason, outcome } from '../src/calls/outcome.js';
import { decodeFile } from '../src/spool/decode.js';

const CALLS = new URL('./fixtures/spool/calls/', import.meta.url);

/** The outcome of each DIALSTATUS when neither ANSWEREDTIME nor the disposition says answered. */
const BY_STATUS = Object.freeze({
  ANSWER: 'answered',
  NOANSWER: 'missed',
  BUSY: 'missed',
  CANCEL: 'missed',
  CONGESTION: 'missed',
  CHANUNAVAIL: 'missed',
  '': 'missed',
  DONTCALL: 'failed',
  TORTURE: 'failed',
  INVALIDARGS: 'failed',
});

describe('outcome of a call', () => {
  test('every DIALSTATUS × ANSWEREDTIME (empty, 0, positive) × disposition (NO ANSWER, ANSWERED, empty)', () => {
    let cases = 0;
    for (const [dialstatus, byStatus] of Object.entries(BY_STATUS)) {
      for (const answeredtime of ['', '0', '37']) {
        for (const disposition of ['NO ANSWER', 'ANSWERED', '']) {
          const expected = answeredtime === '37' || disposition === 'ANSWERED' ? 'answered' : byStatus;
          assert.equal(outcome({ dialstatus, answeredtime, disposition }), expected, JSON.stringify({ dialstatus, answeredtime, disposition }));
          cases += 1;
        }
      }
    }
    assert.equal(cases, 90);
  });

  test('an outgoing call is answered, unanswered (no answer, busy, cancelled) or failed, never missed', () => {
    /** @type {Record<string, string>} */
    const OUT = { ANSWER: 'answered', NOANSWER: 'unanswered', BUSY: 'unanswered', CANCEL: 'unanswered', CONGESTION: 'failed', CHANUNAVAIL: 'failed',
      '': 'failed', DONTCALL: 'failed', TORTURE: 'failed', INVALIDARGS: 'failed' };
    assert.deepEqual(Object.keys(OUT).sort(), Object.keys(BY_STATUS).sort());
    for (const [dialstatus, expected] of Object.entries(OUT)) {
      assert.equal(outcome({ dialstatus, answeredtime: '', disposition: 'NO ANSWER', direction: 'out' }), expected, dialstatus);
      assert.equal(outcome({ dialstatus, answeredtime: '37', disposition: 'NO ANSWER', direction: 'out' }), 'answered', dialstatus);
    }
    assert.equal(outcome({ dialstatus: 'busy', answeredtime: '', disposition: '', direction: 'out' }), 'unanswered');
    assert.equal(outcome({ dialstatus: 'NOANSWER', answeredtime: '', disposition: '', direction: 'in' }), 'missed');
  });

  test('the statuses app_dial documents are exactly the ones of the table', () => {
    // apps/app_dial.c of Asterisk 20.21.0, <variable name="DIALSTATUS">: the documented values, plus '' when no Dial ran
    assert.deepEqual(Object.keys(BY_STATUS).sort(), ['', 'ANSWER', 'BUSY', 'CANCEL', 'CHANUNAVAIL', 'CONGESTION', 'DONTCALL', 'INVALIDARGS', 'NOANSWER', 'TORTURE']);
  });

  test('ANSWEREDTIME counts only as a whole number above 0; the disposition only as exactly ANSWERED', () => {
    for (const answeredtime of ['1.5', ' 7', '7 ', '-1', '+3', '0x10', '00', 'abc']) {
      assert.equal(outcome({ dialstatus: 'NOANSWER', answeredtime, disposition: 'NO ANSWER' }), 'missed', answeredtime);
    }
    assert.equal(outcome({ dialstatus: 'NOANSWER', answeredtime: '01', disposition: '' }), 'answered');
    assert.equal(outcome({ dialstatus: 'NOANSWER', answeredtime: '1', disposition: '' }), 'answered');
    for (const disposition of ['answered', 'ANSWERED ', 'FAILED', 'BUSY', 'CONGESTION']) {
      assert.equal(outcome({ dialstatus: 'BUSY', answeredtime: '', disposition }), 'missed', disposition);
    }
  });

  test('DIALSTATUS is compared in upper case (a Gosub result keeps its case); unknown values fail', () => {
    assert.equal(outcome({ dialstatus: 'busy', answeredtime: '', disposition: 'NO ANSWER' }), 'missed');
    assert.equal(outcome({ dialstatus: 'Answer', answeredtime: '', disposition: 'NO ANSWER' }), 'answered');
    for (const dialstatus of ['CONTINUE', 'ABORT', 'FOO', ' BUSY', 'BUSY ']) {
      assert.equal(outcome({ dialstatus, answeredtime: '', disposition: 'NO ANSWER' }), 'failed', dialstatus);
    }
  });

  test('missed calls name their reason; other statuses have none', () => {
    assert.deepEqual({ ...MISSED_REASONS }, {
      NOANSWER: 'no answer', BUSY: 'busy', CANCEL: 'caller hung up', CONGESTION: 'congestion', CHANUNAVAIL: 'no phone reachable', '': 'nobody was dialed',
    });
    assert.equal(missedReason('chanunavail'), 'no phone reachable');
    for (const dialstatus of ['ANSWER', 'DONTCALL', 'TORTURE', 'INVALIDARGS', 'toString', '__proto__', 'constructor']) {
      assert.equal(missedReason(dialstatus), null, dialstatus);
      if (dialstatus !== 'ANSWER') assert.equal(outcome({ dialstatus, answeredtime: '', disposition: '' }), 'failed', dialstatus);
    }
  });

  test('the call-end events captured from Asterisk 20.21.0 have the outcome of their scenario', () => {
    /** @type {Record<string, string>} */
    const expected = {
      'answered.evt': 'answered',
      'answered-caller-hangs-up.evt': 'answered',
      'noanswer.evt': 'missed',
      'did-noanswer.evt': 'missed',
      'busy.evt': 'missed',
      'anonymous-busy.evt': 'missed',
      'congestion.evt': 'missed',
      'chanunavail.evt': 'missed',
      'cancel.evt': 'missed',
      'ring-empty.evt': 'missed',
      'answered-without-dial.evt': 'missed',
      'invalidargs.evt': 'failed',
    };
    assert.deepEqual(readdirSync(CALLS).filter((name) => name.endsWith('.evt')).sort(), Object.keys(expected).sort());
    for (const [name, want] of Object.entries(expected)) {
      const event = decodeFile(readFileSync(new URL(name, CALLS)));
      assert.equal(event.kind, 'call-end', name);
      if (event.kind !== 'call-end') continue;
      assert.equal(outcome(event.data), want, name);
      // Asterisk writes ANSWERED and both times only after an answered Dial
      assert.equal(event.data.disposition === 'ANSWERED', want === 'answered', name);
      assert.equal(event.data.answeredtime !== '', want === 'answered', name);
    }
  });
});
