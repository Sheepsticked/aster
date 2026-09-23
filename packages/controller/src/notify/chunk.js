// @ts-check
// Splits a text into Telegram message parts of at most 4096 UTF-16 units, cutting at the last line feed when possible
// and never inside a surrogate pair; blank parts are dropped because Telegram refuses them.

/** Longest message text sendMessage accepts, in UTF-16 code units. */
export const TELEGRAM_TEXT_MAX = 4096;

/**
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function chunk(text, limit = TELEGRAM_TEXT_MAX) {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError(`chunk limit must be a whole number of at least 2, not ${limit}`);
  /** @type {string[]} */
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    let skip = 1;
    if (cut <= 0) {
      cut = limit;
      skip = 0;
      const last = rest.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  parts.push(rest);
  return parts.filter((part) => part.trim() !== '');
}
