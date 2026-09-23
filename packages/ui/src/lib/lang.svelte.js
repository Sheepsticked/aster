// The current UI language as reactive state (a .svelte.js module so `$state` compiles); every t() call follows it.
// The appliance setting wins at login; localStorage remembers the last choice for the login screen and reloads.
const KEY = 'aster.language';
/** The catalogs i18n/index.js ships; the registry's `ui_language` is one of these. */
export const LANGUAGES = Object.freeze(['en', 'ru']);
/** English is the appliance's default. */
export const DEFAULT = 'en';

/** @param {unknown} value */
export const known = (value) => typeof value === 'string' && LANGUAGES.includes(value);

function stored() {
  try {
    const saved = localStorage.getItem(KEY);
    return known(saved) ? saved : null;
  } catch {
    return null; // storage disabled: the default, and nothing is remembered
  }
}

let current = $state(stored() ?? DEFAULT);

export const lang = {
  get current() {
    return current;
  },
  /**
   * Switches the language of this browser. Persisting it on the appliance is the caller's job (PUT /api/settings), because that
   * needs a session and must not happen on the login screen.
   * @param {string} next
   */
  set(next) {
    if (!known(next) || next === current) return;
    current = next;
    document.documentElement.lang = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // nothing to do: the language still changed for this page load
    }
  },
};
