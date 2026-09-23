// Health strip data: polls /api/health (no session needed) every 30 s, only while the tab is visible.
import { api, ApiError } from '../api.js';

const EVERY_MS = 30_000;

/** @type {Record<string, any> | null} */
let data = $state(null);
/** @type {string | null} */
let error = $state(null);
let loading = $state(false);
/** @type {ReturnType<typeof setInterval> | undefined} */
let timer;

export const health = {
  get data() {
    return data;
  },
  get error() {
    return error;
  },
  get loading() {
    return loading;
  },
  /** `ok` | `degraded` from the controller, `unknown` while it cannot be asked. */
  get status() {
    if (data === null) return 'unknown';
    return data.status === 'ok' ? 'ok' : 'degraded';
  },
  /** The reasons in the controller's own words (they name files and numbers). */
  get reasons() {
    return Array.isArray(data?.reasons) ? /** @type {string[]} */ (data.reasons) : [];
  },

  async refresh() {
    loading = true;
    try {
      data = await api.health();
      error = null;
    } catch (err) {
      // Keep the last answer on screen: it is what the controller last said, and `error` says it is no longer current.
      error = err instanceof ApiError && err.offline ? 'offline' : err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  },

  /** Starts polling; returns the function that stops it (the shell calls it when it is destroyed). */
  start() {
    void health.refresh();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void health.refresh();
    }, EVERY_MS);
    return () => {
      clearInterval(timer);
      timer = undefined;
    };
  },
};
