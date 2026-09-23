// @ts-check
// Log sink that passes each line to stdout and keeps the last lines in memory for GET /api/logs/controller;
// long lines are cut so memory stays bounded.

/** @typedef {{ write(text: string): unknown }} Sink */

export const DEFAULTS = Object.freeze({ lines: 1_000, maxLineChars: 4_000 });

/**
 * @param {object} [options]
 * @param {Sink | null} [options.stream]  where the lines also go (default process.stdout; null keeps them only in memory)
 * @param {number} [options.lines]        how many are kept
 * @param {number} [options.maxLineChars] a longer line is cut and marked with an ellipsis
 */
export function createRing({ stream = process.stdout, lines = DEFAULTS.lines, maxLineChars = DEFAULTS.maxLineChars } = {}) {
  const size = Math.max(1, Math.floor(lines));
  /** @type {string[]} */
  const kept = [];
  let dropped = 0;

  return {
    /** The sink the logger writes to: `text` is one line with its trailing newline. @param {string} text */
    write(text) {
      stream?.write(text);
      for (const line of String(text).split('\n')) {
        if (line === '') continue;
        kept.push(line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line);
      }
      while (kept.length > size) {
        kept.shift();
        dropped += 1;
      }
      return true;
    },
    /**
     * The newest lines, oldest first; `grep` is a plain substring, matched case-insensitively before the limit is applied.
     * @param {{ limit?: number, grep?: string | null }} [query]
     */
    lines({ limit = size, grep = null } = {}) {
      const wanted = grep === null || grep === '' ? kept : kept.filter((line) => line.toLowerCase().includes(grep.toLowerCase()));
      return wanted.slice(Math.max(0, wanted.length - Math.max(1, Math.floor(limit))));
    },
    /** How many lines are held and how many have already been pushed out (the UI says the log starts there). */
    stats: () => ({ kept: kept.length, capacity: size, dropped }),
  };
}

/** @typedef {ReturnType<typeof createRing>} Ring */
