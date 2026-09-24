// Rows per page of every list, as reactive state; localStorage remembers the choice in this browser.
const KEY = 'aster.per_page';
/** The choices the pager offers; the first one is the default. */
export const PAGE_SIZES = Object.freeze([25, 50, 100]);
const DEFAULT = 25;

function stored() {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return PAGE_SIZES.includes(saved) ? saved : DEFAULT;
  } catch {
    return DEFAULT; // storage disabled: the default, and nothing is remembered
  }
}

let current = $state(stored());

export const perPage = {
  get value() {
    return current;
  },
  /** @param {number} next  one of PAGE_SIZES */
  set(next) {
    if (!PAGE_SIZES.includes(next)) return;
    current = next;
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      // nothing to do: the lists still use it until the page is reloaded
    }
  },
};
