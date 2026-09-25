// @ts-check
// The newest ERROR or WARNING the drivers logged for one modem (`[<id>] …` in the Asterisk full log), from the log's tail.
import { tail } from '../http/routes/logs.js';

/** `[YYYY-MM-DD HH:MM:SS] LEVEL[thread]`: logger.conf's dateformat %F %T, in the Asterisk container's time zone (UTC). */
const LINE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] (ERROR|WARNING)\[/;

/** @typedef {{ at: number, level: 'ERROR' | 'WARNING', text: string, count: number }} DriverError  count: lines with this text in the tail */

/**
 * @param {string} path  the Asterisk full log
 * @param {string} modemId
 * @returns {DriverError | null}  null when the tail names no error of that modem, or there is no log yet
 */
export function lastDriverError(path, modemId) {
  const tag = `[${modemId}] `;
  let lines;
  try {
    ({ lines } = tail(path, { limit: Number.MAX_SAFE_INTEGER, grep: tag }));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
    throw err;
  }
  /** @type {Array<{ at: number, level: 'ERROR' | 'WARNING', text: string }>} */
  const errors = [];
  for (const line of lines) {
    const match = LINE.exec(line);
    const start = line.indexOf(tag);
    if (!match || start === -1) continue;
    const [, year, month, day, hour, minute, second, level] = match;
    errors.push({
      at: Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
      level: /** @type {'ERROR' | 'WARNING'} */ (level),
      text: line.slice(start + tag.length).trim(),
    });
  }
  const newest = errors.at(-1);
  if (!newest) return null;
  return { ...newest, count: errors.filter((entry) => entry.text === newest.text).length };
}
