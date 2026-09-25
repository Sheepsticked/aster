// Session state: checked once via GET /api/me; any later 401 (through api.js) returns to the login screen.
// The appliance's `ui_language` is adopted whenever a session starts.
import { api, ApiError, onUnauthorized } from '../api.js';
import { setLanguage } from '../i18n/index.js';

/** @typedef {'unknown' | 'in' | 'out'} Status */

/** @type {Status} */
let status = $state('unknown');
/** @type {{ created_at: number, last_seen_at: number, expires_at: number } | null} */
let who = $state(null);
/** @type {string | null} */
let error = $state(null);
/** The HTTP status behind `error` (0 = no answer at all), so the login screen can say "wrong password" in the user's language
 *  instead of repeating the controller's English sentence (i18n/index.js). */
let errorStatus = $state(0);
/** Seconds a 429 says to wait before the next login, else null. */
let retryAfter = $state(/** @type {number | null} */ (null));

/** The appliance's language, once there is a session to read it with. */
async function adoptLanguage() {
  try {
    const settings = await api.settings();
    if (typeof settings?.ui_language === 'string') setLanguage(settings.ui_language);
  } catch {
    // The language is a preference, not a reason to fail a login; the Settings page shows the real error later.
  }
}

export const session = {
  get status() {
    return status;
  },
  get who() {
    return who;
  },
  /** The last failure of check()/login(), as the sentence to show. */
  get error() {
    return error;
  },
  get retryAfter() {
    return retryAfter;
  },
  get errorStatus() {
    return errorStatus;
  },

  /** Is there a session? Asked once at start, and again after the controller was unreachable. */
  async check() {
    try {
      const me = await api.me();
      who = me?.session ?? null;
      status = 'in';
      error = null;
      await adoptLanguage();
    } catch (err) {
      who = null;
      if (err instanceof ApiError && err.status === 401) {
        status = 'out';
        error = null;
        errorStatus = 0;
        return;
      }
      // Controller unreachable or broken: not "logged out"; the app shows the failure and retries.
      status = 'unknown';
      error = err instanceof Error ? err.message : String(err);
      errorStatus = err instanceof ApiError ? err.status : 0;
    }
  },

  /**
   * @param {string} password
   * @returns {Promise<boolean>} whether it was the right one; `session.error` says what else went wrong
   */
  async login(password) {
    try {
      const { data } = await api.login(password);
      who = data?.session ?? null;
      status = 'in';
      error = null;
      errorStatus = 0;
      retryAfter = null;
      await adoptLanguage();
      return true;
    } catch (err) {
      status = 'out';
      error = err instanceof Error ? err.message : String(err);
      errorStatus = err instanceof ApiError ? err.status : 0;
      const seconds = err instanceof ApiError ? Number(err.body?.retry_after) : NaN;
      retryAfter = errorStatus === 429 && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
      return false;
    }
  },

  async logout() {
    try {
      await api.logout();
    } catch {
      // The cookie is gone from this browser either way; a controller that did not answer cannot keep the user in.
    }
    who = null;
    status = 'out';
    error = null;
    errorStatus = 0;
  },

  /** What api.js calls when the controller refuses a request for want of a session. */
  expired() {
    who = null;
    if (status !== 'out') {
      status = 'out';
      error = null;
      errorStatus = 401;
    }
  },
};

onUnauthorized(() => session.expired());
