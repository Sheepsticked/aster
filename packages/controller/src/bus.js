// @ts-check
// Aster controller — in-process event bus: publish() delivers synchronously to every subscriber; an unknown type throws.
// Subscriber errors are only logged, so a listener never rolls back a publisher's transaction; nested publishes keep order.
// Usage: const bus = createBus({ log }); const unsubscribe = bus.subscribe((event) => …); bus.publish('op.progress', { … })

/** @typedef {import('./log.js').Logger} Logger */
/**
 * @typedef {object} OpProgress  an operation changed status or reported progress (ops/runner.js)
 * @property {number} id
 * @property {string} kind
 * @property {string | null} modem_id
 * @property {string} actor
 * @property {string} status                          queued | running | interrupted | done | failed | uncertain
 * @property {string | null} message                  the text of ctx.progress(); null for a status change
 * @property {Record<string, unknown> | null} result  the stored result_json of an interrupted or finished operation
 * @property {string | null} error
 * @property {number} at                              epoch ms
 */
/**
 * Payload of each event type.
 * @typedef {{
 *   'modem.state': Record<string, unknown>,
 *   'op.progress': OpProgress,
 *   'message.new': Record<string, unknown>,
 *   'call.new': Record<string, unknown>,
 *   'notification.result': Record<string, unknown>,
 *   health: Record<string, unknown>,
 *   'phone.state': { phones: string[] | null },
 * }} Payloads
 */
/** @typedef {{ [T in keyof Payloads]: Readonly<{ type: T, payload: Payloads[T] }> }[keyof Payloads]} BusEvent */
/** @typedef {(event: BusEvent) => unknown} Subscriber */
/**
 * @typedef {object} Bus
 * @property {<T extends keyof Payloads>(type: T, payload: Payloads[T]) => void} publish
 * @property {(fn: Subscriber) => () => void} subscribe  returns the function that ends this subscription
 */

export const TYPES = Object.freeze(['modem.state', 'op.progress', 'message.new', 'call.new', 'notification.result', 'health', 'phone.state']);
/** @type {Set<string>} */
const KNOWN = new Set(TYPES);

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * @param {{ log?: Logger }} [options]
 * @returns {Bus}
 */
export function createBus({ log = SILENT } = {}) {
  /** One entry per subscribe() call, so the same function can hold two subscriptions. @type {Set<{ fn: Subscriber }>} */
  const subscriptions = new Set();
  /** @type {BusEvent[]} */
  const queue = [];
  let delivering = false;

  /**
   * @param {Subscriber} fn
   * @param {BusEvent} event
   */
  function deliver(fn, event) {
    try {
      const returned = fn(event);
      if (returned instanceof Promise) {
        returned.catch((err) => log.error('bus subscriber failed', { type: event.type, err }));
      }
    } catch (err) {
      log.error('bus subscriber failed', { type: event.type, err });
    }
  }

  return {
    publish(type, payload) {
      if (!KNOWN.has(type)) throw new TypeError(`unknown bus event type: ${JSON.stringify(type)}`);
      queue.push(/** @type {BusEvent} */ (Object.freeze({ type, payload })));
      if (delivering) return;
      delivering = true;
      try {
        for (let event = queue.shift(); event; event = queue.shift()) {
          for (const subscription of [...subscriptions]) {
            if (subscriptions.has(subscription)) deliver(subscription.fn, event);
          }
        }
      } finally {
        delivering = false;
      }
    },
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('a bus subscriber must be a function');
      const subscription = { fn };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },
  };
}
