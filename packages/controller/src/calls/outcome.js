// @ts-check
// Call outcome from the fields the hangup handler spools: `answered`, `missed` (the Dial did not connect, or nothing was
// dialed) or `failed`. DIALSTATUS is compared in upper case, as app_dial ignores its case.

/** @typedef {'answered' | 'missed' | 'failed'} Outcome */
/** @typedef {{ dialstatus: string, answeredtime: string, disposition: string }} CallFacts  the decoded spool fields ('' when empty) */

export const OUTCOMES = Object.freeze(/** @type {const} */ (['answered', 'missed', 'failed']));
/** DIALSTATUS values of a missed call → the reason a missed-call notification names. */
export const MISSED_REASONS = Object.freeze(/** @type {Readonly<Record<string, string>>} */ ({
  NOANSWER: 'no answer',
  BUSY: 'busy',
  CANCEL: 'caller hung up',
  CONGESTION: 'congestion',
  CHANUNAVAIL: 'no phone reachable',
  '': 'nobody was dialed',
}));
const WHOLE_NUMBER = /^[0-9]{1,15}$/;

/**
 * @param {CallFacts} facts
 * @returns {Outcome}
 */
export function outcome({ dialstatus, answeredtime, disposition }) {
  const status = dialstatus.toUpperCase();
  if (status === 'ANSWER' || disposition === 'ANSWERED' || (WHOLE_NUMBER.test(answeredtime) && Number(answeredtime) > 0)) return 'answered';
  return Object.hasOwn(MISSED_REASONS, status) ? 'missed' : 'failed';
}

/**
 * The reason of a missed call, or null when the DIALSTATUS is not one of a missed call.
 * @param {string} dialstatus
 * @returns {string | null}
 */
export function missedReason(dialstatus) {
  const status = dialstatus.toUpperCase();
  return Object.hasOwn(MISSED_REASONS, status) ? MISSED_REASONS[status] ?? null : null;
}
