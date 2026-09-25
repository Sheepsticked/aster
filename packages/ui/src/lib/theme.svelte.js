// The colour theme as reactive state: `system` follows the device's setting, `light` and `dark` pin one (the data-theme
// attribute app.css reads); localStorage remembers the choice in this browser.
const KEY = 'aster.theme';
export const THEMES = Object.freeze(['system', 'light', 'dark']);

function stored() {
  try {
    const saved = localStorage.getItem(KEY);
    return saved !== null && THEMES.includes(saved) ? saved : 'system';
  } catch {
    return 'system'; // storage disabled: the device's setting, and nothing is remembered
  }
}

/** @param {string} value */
function apply(value) {
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  // Each toolbar colour of index.html applies to its own scheme, or to every one when that theme is pinned.
  /** @type {NodeListOf<HTMLMetaElement>} */
  const metas = document.querySelectorAll('meta[name="theme-color"][data-theme]');
  for (const meta of metas) {
    const own = meta.dataset.theme;
    meta.media = value === 'system' ? `(prefers-color-scheme: ${own})` : own === value ? 'all' : 'not all';
  }
}

let current = $state(stored());
apply(current);

export const theme = {
  get value() {
    return current;
  },
  /** @param {string} next  one of THEMES */
  set(next) {
    if (!THEMES.includes(next)) return;
    current = next;
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // nothing to do: the theme still applies until the page is reloaded
    }
  },
};
