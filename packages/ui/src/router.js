// History-API router (no hash): maps paths to page components. A plain module; App.svelte holds the reactive path.
// `start()` turns plain left clicks on internal <a href> links into pushState and leaves other clicks to the browser.
import Activity from './pages/Activity.svelte';
import Calls from './pages/Calls.svelte';
import Config from './pages/Config.svelte';
import Login from './pages/Login.svelte';
import Logs from './pages/Logs.svelte';
import Messages from './pages/Messages.svelte';
import Modem from './pages/Modem.svelte';
import Modems from './pages/Modems.svelte';
import Overview from './pages/Overview.svelte';
import Phones from './pages/Phones.svelte';
import Settings from './pages/Settings.svelte';

/**
 * @typedef {object} Route
 * @property {string} path            the pattern, `/modems` or `/modems/:id`
 * @property {string} name            the i18n key suffix (`nav.<name>`) and the page's id
 * @property {any} component          the Svelte component the shell renders
 * @property {boolean} [nav]          whether it appears in the navigation
 * @property {boolean} [anonymous]    whether it is shown without a session
 * @property {string} [icon]          the icon name (lib/NavIcon.svelte)
 */

/** Every path and its page; detail paths follow their section (patterns do not overlap, so order is not precedence). */
export const ROUTES = Object.freeze(/** @type {readonly Route[]} */ ([
  { path: '/login', name: 'login', component: Login, anonymous: true },
  { path: '/', name: 'overview', component: Overview, nav: true, icon: 'overview' },
  { path: '/modems', name: 'modems', component: Modems, nav: true, icon: 'modems' },
  { path: '/modems/:id', name: 'modem', component: Modem },
  { path: '/phones', name: 'phones', component: Phones, nav: true, icon: 'phones' },
  { path: '/messages', name: 'messages', component: Messages, nav: true, icon: 'messages' },
  { path: '/calls', name: 'calls', component: Calls, nav: true, icon: 'calls' },
  { path: '/config', name: 'config', component: Config, nav: true, icon: 'config' },
  { path: '/settings', name: 'settings', component: Settings, nav: true, icon: 'settings' },
  { path: '/activity', name: 'activity', component: Activity, nav: true, icon: 'activity' },
  { path: '/logs', name: 'logs', component: Logs, nav: true, icon: 'logs' },
]));

/** The navigation entries, in order. */
export const NAV = Object.freeze(ROUTES.filter((route) => route.nav));

/** @type {Map<Route, { re: RegExp, keys: string[] }>} */
const patterns = new Map();

/** `/modems/:id` → a regular expression and the names of its parts; `/modems` matches with and without a trailing slash. */
function patternOf(/** @type {Route} */ route) {
  let pattern = patterns.get(route);
  if (!pattern) {
    /** @type {string[]} */
    const keys = [];
    const source = route.path.replace(/\/:([A-Za-z0-9_]+)/g, (_whole, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    pattern = { re: new RegExp(`^${source === '/' ? '/' : `${source}/?`}$`), keys };
    patterns.set(route, pattern);
  }
  return pattern;
}

/**
 * The route a path means, with its `:parts` decoded. No route is a 404 inside the app (App.svelte shows it as one).
 * @param {string} path
 * @returns {{ route: Route | null, params: Record<string, string> }}
 */
export function match(path) {
  for (const route of ROUTES) {
    const { re, keys } = patternOf(route);
    const found = re.exec(path);
    if (!found) continue;
    /** @type {Record<string, string>} */
    const params = {};
    keys.forEach((key, index) => {
      params[key] = decodeURIComponent(found[index + 1] ?? '');
    });
    return { route, params };
  }
  return { route: null, params: {} };
}

/** The path the browser is on, with a trailing slash removed so `/modems/` and `/modems` are one route. */
export function currentPath() {
  const path = window.location.pathname;
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** @type {Set<(path: string) => void>} */
const listeners = new Set();

const announce = () => {
  const path = currentPath();
  for (const listener of listeners) listener(path);
};

/**
 * Goes to a path inside the app.
 * @param {string} to
 * @param {{ replace?: boolean }} [options]  replace: do not leave the current path in the back history (the login redirect)
 */
export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, window.location.origin);
  if (url.pathname === window.location.pathname && url.search === window.location.search) return;
  if (replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
  window.scrollTo({ top: 0 });
  announce();
}

/**
 * Starts routing: the back button, and every click on an internal link.
 * @param {(path: string) => void} onChange
 * @returns {() => void} stops it again
 */
export function start(onChange) {
  listeners.add(onChange);

  /** @param {MouseEvent} event */
  function click(event) {
    // Anything but a plain left click is the browser's business: a new tab, a download, the context menu.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = /** @type {Element | null} */ (event.target)?.closest?.('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download') || anchor.getAttribute('rel') === 'external') return;
    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    // /api/… is the controller's, not the app's (the backup download is such a link).
    if (url.pathname.startsWith('/api/')) return;
    // Same-page fragment links (e.g. the skip link) are left to the browser so focus moves.
    if (url.hash !== '' && url.pathname === window.location.pathname && url.search === window.location.search) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  }

  window.addEventListener('popstate', announce);
  document.addEventListener('click', click);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('popstate', announce);
    document.removeEventListener('click', click);
  };
}
