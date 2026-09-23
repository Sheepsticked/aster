// Toast store for background events; a toast never is the only place a result appears.
// Failures stay until dismissed; other toasts time out.
const LIMIT = 4;
const TIMEOUT_MS = 6000;

/** @typedef {{ id: number, kind: 'info' | 'success' | 'error', text: string, at: number }} Toast */

/** @type {Toast[]} */
let items = $state([]);
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const timers = new Map();
let seq = 0;

function forget(/** @type {number} */ id) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

export const toasts = {
  get items() {
    return items;
  },

  /**
   * @param {{ kind?: Toast['kind'], text: string, timeoutMs?: number }} toast
   * @returns {number} its id, for dismissing it before its time
   */
  push({ kind = 'info', text, timeoutMs }) {
    const id = ++seq;
    items = [...items, { id, kind, text, at: Date.now() }];
    // Drop the oldest when many arrive at once (e.g. a flapping modem).
    for (const gone of items.slice(0, Math.max(0, items.length - LIMIT))) forget(gone.id);
    items = items.slice(-LIMIT);
    const ms = timeoutMs ?? (kind === 'error' ? 0 : TIMEOUT_MS);
    if (ms > 0) timers.set(id, setTimeout(() => toasts.dismiss(id), ms));
    return id;
  },

  /** @param {number} id */
  dismiss(id) {
    forget(id);
    items = items.filter((toast) => toast.id !== id);
  },

  clear() {
    for (const toast of items) forget(toast.id);
    items = [];
  },
};
