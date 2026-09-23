// The single API client: GETs return the body, mutations return {status, data}; non-2xx throws ApiError (status 0 = no answer);
// 401 triggers the logout handler. `createEventStream` reconnects and signals a refetch after gaps.

/** The bus event types the controller sends (src/bus.js), plus `dropped`, which is the stream saying "refetch". */
export const EVENT_TYPES = Object.freeze(['modem.state', 'op.progress', 'message.new', 'call.new', 'notification.result', 'health', 'phone.state']);

const BASE = '/api';

export class ApiError extends Error {
  /**
   * @param {number} status  the HTTP status, or 0 when there was no answer at all
   * @param {string} message the controller's sentence when it sent one
   * @param {any} [body]     the parsed JSON body, when there was one
   * @param {{ cause?: unknown }} [options]
   */
  constructor(status, message, body = null, options = {}) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    /** @type {{ path: string, message: string }[] | null} */
    this.problems = Array.isArray(body?.problems) ? body.problems : null;
    /** @type {Record<string, unknown> | null} */
    this.operation = body?.operation ?? null;
  }

  /** True when the request never reached the controller (it is down, or the network is). */
  get offline() {
    return this.status === 0;
  }
}

/** @type {() => void} */
let unauthorized = () => {};

/**
 * What to do when the controller says the session is gone; the app sets this once (lib/session.svelte.js).
 * @param {() => void} handler
 */
export function onUnauthorized(handler) {
  unauthorized = handler;
}

/**
 * @param {string} method
 * @param {string} path  below /api, e.g. `/overview`
 * @param {unknown} [body]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ status: number, data: any }>}
 */
async function call(method, path, body, options = {}) {
  /** @type {RequestInit} */
  const init = { method, credentials: 'same-origin', signal: options.signal };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(BASE + path, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'the controller could not be reached', null, { cause });
  }
  const text = await response.text();
  let data = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = null; // a body that is not JSON is not something this API sends; treat it as none
    }
  }
  if (response.ok) return { status: response.status, data };
  if (response.status === 401 && path !== '/login') unauthorized();
  const message = typeof data?.error === 'string' ? data.error : `${response.status} ${response.statusText}`.trim();
  throw new ApiError(response.status, message, data);
}

/** @param {string} path @param {{ signal?: AbortSignal }} [options] */
export const get = async (path, options) => (await call('GET', path, undefined, options)).data;
/** @param {string} path @param {unknown} [body] @param {{ signal?: AbortSignal }} [options] */
export const post = (path, body, options) => call('POST', path, body ?? {}, options);
/** @param {string} path @param {unknown} body @param {{ signal?: AbortSignal }} [options] */
export const put = (path, body, options) => call('PUT', path, body, options);
/** @param {string} path @param {{ signal?: AbortSignal }} [options] */
export const del = (path, options) => call('DELETE', path, {}, options);

/** @param {string} part  an id, a phone number or an action verb that goes into a path */
const seg = (part) => encodeURIComponent(String(part));

/** Every API call the pages make, so pages never build paths themselves. */
export const api = {
  /** @param {string} password */
  login: (password) => post('/login', { password }),
  logout: () => post('/logout'),
  me: () => get('/me'),
  health: () => get('/health'),
  overview: () => get('/overview'),
  settings: () => get('/settings'),
  /** @param {Record<string, unknown>} fields */
  saveSettings: (fields) => put('/settings', fields),
  scan: () => post('/scan'),
  /** The stored result of the last scan, with the devices no modem owns filtered against the registry as it is now. */
  scanLatest: () => get('/scan/latest'),

  modems: () => get('/modems'),
  /** @param {string} id */
  modem: (id) => get(`/modems/${seg(id)}`),
  /** @param {Record<string, unknown>} fields */
  assignModem: (fields) => post('/modems', fields),
  /** @param {string} id @param {Record<string, unknown>} fields */
  saveModem: (id, fields) => put(`/modems/${seg(id)}`, fields),
  /** @param {string} id */
  deleteModem: (id) => del(`/modems/${seg(id)}`),
  /** @param {string} id @param {string} verb  start | stop | restart | reset | remap @param {Record<string, unknown>} [body] */
  modemAction: (id, verb, body) => post(`/modems/${seg(id)}/${seg(verb)}`, body),
  /** @param {string} id */
  forwarding: (id) => get(`/modems/${seg(id)}/forwarding`),
  /** @param {string} id @param {{ action: string, number?: string }} body */
  runForwarding: (id, body) => post(`/modems/${seg(id)}/forwarding`, body),
  /** @param {string} id @param {{ command: string, timeout?: number }} body */
  at: (id, body) => post(`/modems/${seg(id)}/at`, body),
  /** @param {string} id @param {{ code: string }} body */
  ussd: (id, body) => post(`/modems/${seg(id)}/ussd`, body),
  ussdCancel: (id) => post(`/modems/${seg(id)}/ussd/cancel`),

  phones: () => get('/phones'),
  /** @param {Record<string, unknown>} fields */
  addPhone: (fields) => post('/phones', fields),
  /** @param {string} number @param {Record<string, unknown>} fields */
  savePhone: (number, fields) => put(`/phones/${seg(number)}`, fields),
  /** @param {string} number */
  deletePhone: (number) => del(`/phones/${seg(number)}`),
  /** Who is connected to each phone and its calls, live from Asterisk. */
  connections: () => get('/connections'),

  /** @param {string} chatId */
  notifyTest: (chatId) => post('/notify/test', { chat_id: chatId }),
  /** One operation by id: what a page falls back to when the event that would have reported it was missed. @param {number} id */
  operation: (id) => get(`/operations/${seg(id)}`),

  // The list routes all answer `{items, page, per_page, total, pages}` and take `page`, `per_page` and `q` beside
  // their own filters; `query()` below turns a page's filter object into that query string.
  /** @param {Record<string, unknown>} [filters] */
  messages: (filters) => get(`/messages${query(filters)}`),
  /** @param {Record<string, unknown>} [filters] */
  calls: (filters) => get(`/calls${query(filters)}`),
  /** @param {Record<string, unknown>} [filters] */
  notifications: (filters) => get(`/notifications${query(filters)}`),
  /** @param {Record<string, unknown>} [filters] */
  operations: (filters) => get(`/operations${query(filters)}`),

  /** @param {{ modem_id: string, number: string, text: string }} body */
  sendSms: (body) => post('/sms', body),
  /** @param {number} id @param {boolean} [confirm]  required for a status that may already have reached the recipient */
  retrySms: (id, confirm = false) => post(`/sms/${seg(id)}/retry`, confirm ? { confirm: true } : {}),
  /** One outbound SMS with its attempts. @param {number} id */
  sms: (id) => get(`/sms/${seg(id)}`),
  /** Deletes one outbound SMS whose sending has ended. @param {number} id */
  deleteSms: (id) => del(`/sms/${seg(id)}`),
  /** Deletes every outbound SMS whose sending ended without success, only that modem's when one is given. @param {string} [modemId] */
  purgeSms: (modemId) => post('/sms/purge', modemId ? { modem_id: modemId } : {}),
  /** Deletes one received SMS. @param {number} id */
  deleteReceivedSms: (id) => del(`/messages/in/${seg(id)}`),
  /** Deletes every SMS the list filters select, up to `before`, except one still being sent. @param {Record<string, unknown>} filters */
  purgeMessages: (filters) => post('/messages/purge', chosen(filters)),
  /** @param {number} id */
  deleteCall: (id) => del(`/calls/${seg(id)}`),
  /** Deletes every call the list filters select, up to `before`. @param {Record<string, unknown>} filters */
  purgeCalls: (filters) => post('/calls/purge', chosen(filters)),

  configFiles: () => get('/config/files'),
  /** @param {string} name */
  configFile: (name) => get(`/config/files/${name.split('/').map(seg).join('/')}`),
  /** @param {string} name @param {{ content: string, base_hash: string | null, force?: boolean, restart?: boolean }} body */
  applyConfig: (name, body) => put(`/config/files/${name.split('/').map(seg).join('/')}`, body),
  /** @param {string} name @param {{ base_hash?: string | null, restart?: boolean }} body */
  restoreConfig: (name, body) => post(`/config/files/${seg(name)}/restore`, body),

  /** @param {'asterisk' | 'controller'} which @param {{ lines?: number, grep?: string }} [options] */
  logs: (which, options) => get(`/logs/${seg(which)}${query(options)}`),
};

/**
 * The filters somebody chose, as a request body: the empty ones are left out, as in query().
 * @param {Record<string, unknown>} filters
 */
function chosen(filters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

/**
 * The query string of a list request: an empty, null or undefined value is left out, so a page can keep its filters as one
 * object and simply not set the ones nobody chose.
 * @param {Record<string, unknown> | undefined} filters
 */
function query(filters) {
  if (!filters) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * The controller's event stream as one connection with the reconnect rules.
 * @param {object} handlers
 * @param {(event: { type: string, payload: any }) => void} handlers.onEvent   one bus event
 * @param {(reason: string) => void} [handlers.onResume]  events may have been missed: refetch what is on screen
 * @param {(connected: boolean) => void} [handlers.onStatus]
 * @returns {{ close: () => void }}
 */
export function createEventStream({ onEvent, onResume = () => {}, onStatus = () => {} }) {
  /** @type {EventSource | null} */
  let source = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retry;
  let closed = false;
  let everOpen = false;

  function open() {
    if (closed) return;
    source = new EventSource(`${BASE}/events`, { withCredentials: true });
    source.addEventListener('open', () => {
      onStatus(true);
      // Only a re-open means a gap: the first connection has nothing to catch up on.
      if (everOpen) onResume('reconnected');
      everOpen = true;
    });
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (message) => onEvent({ type, payload: parse(message.data) }));
    }
    // The controller counts events it could not write to a slow client and says so once; the only correct answer is to refetch.
    source.addEventListener('dropped', () => onResume('dropped'));
    source.addEventListener('error', () => {
      onStatus(false);
      // readyState 2 is a connection the browser will not retry by itself (a 401, a 503, a refused socket): reopen it here.
      if (source?.readyState === EventSource.CLOSED) {
        source.close();
        source = null;
        clearTimeout(retry);
        retry = setTimeout(open, 5000);
      }
    });
  }

  function visibility() {
    if (document.visibilityState !== 'visible' || closed) return;
    if (source === null || source.readyState === EventSource.CLOSED) {
      clearTimeout(retry);
      source?.close();
      source = null;
      open();
    }
    // The tab was in the background: a phone suspends the connection, so what is on screen is not to be trusted.
    onResume('visible');
  }

  document.addEventListener('visibilitychange', visibility);
  open();

  return {
    close() {
      closed = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', visibility);
      source?.close();
      source = null;
    },
  };
}

/** @param {string} data */
function parse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null; // a frame that is not JSON cannot be from this controller; ignore its payload rather than throw in a listener
  }
}
