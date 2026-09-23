// The event stream as app state (one connection per session): latest modem states, operation toasts,
// refetch counters (`resume`, `phones`), `follow(id)` for a started operation, and per-modem state history.
import { api, createEventStream } from '../api.js';
import { t } from '../i18n/index.js';
import { toasts } from './toasts.svelte.js';

const FINAL = new Set(['done', 'failed', 'uncertain']);
/** How many state changes of a modem the detail page's history strip can show. */
const HISTORY = 20;
/** How long a page waits for an operation it started, and how often it asks the controller when no event came. */
const FOLLOW = Object.freeze({ timeoutMs: 180_000, pollMs: 5_000 });

let connected = $state(false);
let resume = $state(0);
let finished = $state(0);
let phones = $state(0);
/** @type {Record<string, any>} */
let modems = $state({});
/** @type {Record<string, { state: string, at: number }[]>} */
let history = $state({});
/** Last payload per operation, so `follow` sees an event that raced ahead of the request's answer. */
/** @type {Map<number, any>} */
const ops = new Map();
/** @type {Map<number, Set<(payload: any) => void>>} */
const waiters = new Map();
/** @type {{ close: () => void } | null} */
let stream = null;

/** @param {number} id @param {any} payload */
function settle(id, payload) {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const resolve of set) resolve(payload);
}

/** @param {{ type: string, payload: any }} event */
function handle({ type, payload }) {
  if (payload === null || typeof payload !== 'object') return;
  if (type === 'modem.state' && typeof payload.modem_id === 'string') {
    const id = payload.modem_id;
    const before = modems[id];
    modems = { ...modems, [id]: payload };
    // Record state changes only, not repeats of the same state.
    if (typeof payload.state === 'string' && payload.state !== before?.state) {
      const at = typeof payload.observed_at === 'number' ? payload.observed_at : Date.now();
      history = { ...history, [id]: [...(history[id] ?? []), { state: payload.state, at }].slice(-HISTORY) };
    }
    return;
  }
  if (type === 'op.progress') {
    if (typeof payload.id === 'number') {
      ops.set(payload.id, payload);
      if (ops.size > 100) ops.delete(/** @type {number} */ (ops.keys().next().value));
      if (FINAL.has(payload.status)) settle(payload.id, payload);
    }
    if (!FINAL.has(payload.status)) return;
    // A finished operation may have changed what pages show; they refetch on this.
    finished += 1;
    const op = t(`op.${payload.kind}`);
    if (payload.status === 'failed') toasts.push({ kind: 'error', text: t('toast.op_failed', { op, error: payload.error ?? '' }) });
    else if (payload.status === 'uncertain') toasts.push({ kind: 'error', text: t('toast.op_uncertain', { op }) });
    else if (payload.actor === 'admin') toasts.push({ kind: 'success', text: t('toast.op_done', { op }) });
    return;
  }
  if (type === 'phone.state') {
    phones += 1;
    return;
  }
  // Surface undelivered notifications; nothing else in the UI would show them unprompted.
  if (type === 'notification.result' && payload.status === 'failed') {
    toasts.push({ kind: 'error', text: t('toast.notify_failed', { error: payload.error ?? '' }) });
  }
}

export const live = {
  /** Whether the stream is up; the shell shows a dot when it is not, because then nothing on screen is live. */
  get connected() {
    return connected;
  },
  /** Goes up when events may have been missed. A page does `live.resume; refetch()` in an effect. */
  get resume() {
    return resume;
  },
  /** Goes up when an operation reached a final status; a page that shows what operations change refetches on it too. */
  get finished() {
    return finished;
  },
  /** Goes up when a phone's registration or calls changed. */
  get phones() {
    return phones;
  },
  /** The last state each modem published, by modem id. */
  get modems() {
    return modems;
  },

  /**
   * The state changes of one modem since this browser opened the stream (the modem page's history strip).
   * @param {string} id
   */
  historyOf(id) {
    return history[id] ?? [];
  },

  /**
   * Waits for an operation's end from the stream, also polling in case the event was missed.
   * `null` means it did not finish in time.
   * @param {number} id
   * @param {{ timeoutMs?: number, pollMs?: number }} [options]
   * @returns {Promise<any | null>}
   */
  follow(id, { timeoutMs = FOLLOW.timeoutMs, pollMs = FOLLOW.pollMs } = {}) {
    const seen = ops.get(id);
    if (seen && FINAL.has(seen.status)) return Promise.resolve(seen);
    return new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout>} */
      let deadline;
      /** @type {ReturnType<typeof setInterval>} */
      let poll;
      const done = (/** @type {any} */ payload) => {
        clearTimeout(deadline);
        clearInterval(poll);
        waiters.get(id)?.delete(done);
        resolve(payload);
      };
      const set = waiters.get(id) ?? new Set();
      set.add(done);
      waiters.set(id, set);
      deadline = setTimeout(() => done(null), timeoutMs);
      poll = setInterval(async () => {
        try {
          const { operation } = await api.operation(id);
          if (operation && FINAL.has(operation.status)) done(operation);
        } catch {
          // The controller is unreachable or forgot the operation: the deadline decides, not a failed poll.
        }
      }, pollMs);
    });
  },

  start() {
    if (stream) return;
    stream = createEventStream({
      onEvent: handle,
      onResume: () => {
        resume += 1;
      },
      onStatus: (up) => {
        connected = up;
      },
    });
  },

  stop() {
    stream?.close();
    stream = null;
    connected = false;
    modems = {};
    history = {};
    ops.clear();
    // Waiters of an ended session resolve as "not finished" instead of hanging.
    for (const id of [...waiters.keys()]) settle(id, null);
  },
};
