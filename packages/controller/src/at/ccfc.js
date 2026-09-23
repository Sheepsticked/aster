// @ts-check
// Aster controller — parser for `+CCFC:` lines of an `AT+CCFC=<reason>,2` query (3GPP TS 27.007 §7.11). An unreadable
// line throws SyntaxError; voiceStatus() picks the entry whose class includes voice (none: not forwarded; null: no +CCFC line).
// Usage: voiceStatus(parse(transaction.lines)) → { enabled, number, type, class, time } | null

/**
 * @typedef {object} Entry
 * @property {0 | 1} status
 * @property {number} class   bit mask
 * @property {string | null} number
 * @property {number | null} type
 * @property {number | null} time
 */
/**
 * @typedef {object} VoiceStatus
 * @property {boolean} enabled
 * @property {string | null} number
 * @property {number | null} type
 * @property {number} class  the class of the entry used (0 for an aggregate without the voice bit)
 * @property {number | null} time  the no-reply wait in seconds, when reported
 */

export const VOICE = 1;
// Subaddress, satype and time may be empty, even as bare trailing separators: `+CCFC: 0,1,"+1234567890",145,,,`.
const LINE = /^\+CCFC:\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*"([^"]*)"\s*,\s*(\d+)\s*(?:,\s*(?:"[^"]*")?\s*,\s*(?:\d+)?\s*(?:,\s*(\d+)?\s*)?)?)?$/;

/**
 * @param {string[]} lines  the AtResponse lines of the query
 * @returns {Entry[]}
 */
export function parse(lines) {
  /** @type {Entry[]} */
  const entries = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('+CCFC:')) continue;
    const match = LINE.exec(line);
    if (!match) throw new SyntaxError(`malformed +CCFC line: ${JSON.stringify(raw)}`);
    const status = Number(match[1]);
    const cls = Number(match[2]);
    if (status !== 0 && status !== 1) throw new SyntaxError(`+CCFC status must be 0 or 1: ${JSON.stringify(raw)}`);
    if (cls > 255) throw new SyntaxError(`+CCFC class must be a bit mask below 256: ${JSON.stringify(raw)}`);
    entries.push({ status, class: cls, number: match[3] ? match[3] : null, type: match[4] === undefined ? null : Number(match[4]), time: match[5] === undefined ? null : Number(match[5]) });
  }
  return entries;
}

/**
 * @param {Entry[]} entries
 * @returns {VoiceStatus | null}
 */
export function voiceStatus(entries) {
  if (entries.length === 0) return null;
  const voice = entries.find((entry) => (entry.class & VOICE) !== 0);
  if (voice) return { enabled: voice.status === 1, number: voice.number, type: voice.type, class: voice.class, time: voice.time };
  return { enabled: false, number: null, type: null, class: 0, time: null };
}
