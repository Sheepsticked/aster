// @ts-check
// Login throttle: after MAX_FAILURES wrong passwords from one address within WINDOW_MS, that address is refused until the
// oldest of them leaves the window. Attempts still being verified count, so parallel guesses are held too. Memory only.

export const MAX_FAILURES = 5;
export const WINDOW_MS = 10 * 60_000;
/** Addresses remembered at most; the one seen longest ago is forgotten first. */
export const MAX_ADDRESSES = 1000;
/** How long an address waits while its attempts are still being verified. */
const PENDING_WAIT_MS = 1000;

/** @typedef {{ failures: number[], pending: number }} Entry  failures: times of the newest wrong passwords, oldest first */

/**
 * @param {{ now?: () => number }} [options]
 */
export function createLoginThrottle({ now = Date.now } = {}) {
  /** @type {Map<string, Entry>} */
  const byAddress = new Map();

  /** The entry of an address with the failures that left the window dropped; null when there is nothing to remember. */
  function current(/** @type {string} */ address) {
    const entry = byAddress.get(address);
    if (!entry) return null;
    const since = now() - WINDOW_MS;
    entry.failures = entry.failures.filter((at) => at > since);
    if (entry.failures.length === 0 && entry.pending === 0) {
      byAddress.delete(address);
      return null;
    }
    return entry;
  }

  return {
    /**
     * Starts an attempt. Returns null when it may go on (finish() must follow), else the milliseconds to wait.
     * @param {string} address
     * @returns {number | null}
     */
    start(address) {
      const entry = current(address) ?? { failures: [], pending: 0 };
      if (entry.failures.length >= MAX_FAILURES) {
        return Math.max(1, (entry.failures[entry.failures.length - MAX_FAILURES] ?? 0) + WINDOW_MS - now());
      }
      if (entry.failures.length + entry.pending >= MAX_FAILURES) return PENDING_WAIT_MS;
      entry.pending += 1;
      // Seen now: moves to the end of the map's order, so the oldest address is the first one dropped.
      byAddress.delete(address);
      byAddress.set(address, entry);
      if (byAddress.size > MAX_ADDRESSES) byAddress.delete(/** @type {string} */ (byAddress.keys().next().value));
      return null;
    },
    /**
     * Ends an attempt start() let through: a right password forgets the address, a wrong one is counted, and one that
     * could not be checked (`unknown`) only ends.
     * @param {string} address
     * @param {'right' | 'wrong' | 'unknown'} outcome
     */
    finish(address, outcome) {
      const entry = byAddress.get(address);
      if (!entry) return;
      entry.pending = Math.max(0, entry.pending - 1);
      if (outcome === 'right') {
        byAddress.delete(address);
        return;
      }
      if (outcome === 'unknown') return;
      entry.failures.push(now());
      if (entry.failures.length > MAX_FAILURES) entry.failures.splice(0, entry.failures.length - MAX_FAILURES);
    },
  };
}
