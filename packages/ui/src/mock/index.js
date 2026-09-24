// In-browser mock of the controller API: replaces fetch for /api/… and EventSource, with the real shapes and status codes.
// Stateful, and emits events only in response to user actions (so screenshots are stable). Dev/test builds only.
import * as fixtures from './fixtures.js';

/** Mock only: a password at least this long logs in, a shorter one is "wrong" (the controller has no minimum). */
const MIN_PASSWORD = 8;
/** Delay on every answer, so loading states are visible. */
const LATENCY_MS = 60;
/** How long a device operation takes before its event arrives. */
const OPERATION_MS = 700;

/** The mock session lives in sessionStorage: it survives a reload, and a new tab starts logged out. */
const SESSION_KEY = 'aster.mock.session';
const remember = (/** @type {boolean} */ value) => {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, '1');
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // storage disabled: the session then lasts as long as the page does
  }
};
const remembered = () => {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
};

/** @type {any} */
const state = {
  in: remembered(),
  ops: 40,
  devices: fixtures.unassigned(),
  modems: fixtures.modems(),
  phones: fixtures.phones(),
  settings: fixtures.settings(),
  // gsm1 has a verified answer; gsm2 (no SIM) never gives a usable one.
  forwarding: /** @type {Record<string, any>} */ ({
    gsm1: {
      unconditional: fixtures.forwarding(),
      // what an operator answered for "not reachable": forwarded for synchronous data (class 16) only, not for voice
      not_reachable: fixtures.forwarding({ class: 0, entries: [{ class: 16, status: 1, number: '+375290000099', type: 145 }], lines: ['+CCFC: 1,16,"+375290000099",145,,,'] }),
    },
    gsm2: null,
  }),
  /** the modems whose USSD menu waits for an answer @type {Set<string>} */
  ussdMenus: new Set(),
  operations: new Map(),
  messages: fixtures.messages(),
  calls: fixtures.calls(),
  notifications: fixtures.notifications(),
  history: fixtures.operations(),
  files: fixtures.configFiles(),
};

/** @type {Set<MockEventSource>} */
const streams = new Set();

/**
 * @param {unknown} body
 * @param {number} [status]
 */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** The controller's own refusal shape. */
const error = (/** @type {string} */ message, /** @type {number} */ status) => json({ error: message }, status);

/**
 * The controller's 400 `invalid request: …` for a body that fails the route schema, so pages cannot rely on a laxer mock.
 * @param {any} body
 * @param {Record<string, RegExp>} required  field → the pattern it must match
 */
function invalid(body, required) {
  const fields = typeof body === 'object' && body !== null ? body : {};
  for (const [name, pattern] of Object.entries(required)) {
    const value = fields[name];
    if (typeof value !== 'string' || !pattern.test(value)) {
      return error(`invalid request: body/${name} must match pattern "${pattern.source}"`, 400);
    }
  }
  return null;
}

/** @param {string} id */
const findModem = (id) => state.modems.find((modem) => modem.id === id) ?? null;
/** @param {string} number */
const findPhone = (number) => state.phones.find((phone) => phone.number === number) ?? null;

/** The `rings_for` of a phone view is read from the modems, never stored (http/routes/phones.js). */
const phoneView = (/** @type {any} */ phone) => ({ ...phone, rings_for: state.modems.filter((modem) => modem.ring.includes(phone.number)).map((modem) => modem.id) });

/**
 * One operation, answered at once and finished a moment later on the event stream — the 202 path.
 * @param {string} kind
 * @param {string | null} modemId
 * @param {{ status?: string, result?: any, error?: string | null, delayMs?: number }} [ending]
 */
function operation(kind, modemId, { status = 'done', result = null, error: failure = null, delayMs = OPERATION_MS } = {}) {
  const id = ++state.ops;
  const now = Date.now();
  const op = { id, kind, modem_id: modemId, status: 'queued', params: {}, result: null, error: null, actor: 'admin',
    created_at: now, started_at: now, finished_at: null };
  state.operations.set(id, op);
  setTimeout(() => {
    Object.assign(op, { status, result, error: failure, finished_at: Date.now() });
    emit('op.progress', { id, kind, modem_id: modemId, actor: 'admin', status, message: null, result, error: failure, at: Date.now() });
  }, delayMs);
  return { id, kind, status: 'queued', error: null, result: null };
}

/** A registry change: the controller applies it inside its wait and answers 200 with the finished operation. */
function applied(kind = 'registry-apply') {
  const id = ++state.ops;
  const now = Date.now();
  const op = { id, kind, modem_id: null, status: 'done', params: {}, result: { files_written: [] }, error: null, actor: 'admin',
    created_at: now, started_at: now, finished_at: now };
  state.operations.set(id, op);
  // Pages refetch on a finished operation.
  setTimeout(() => emit('op.progress', { id, kind, modem_id: null, actor: 'admin', status: 'done', message: null, result: op.result, error: null, at: Date.now() }), LATENCY_MS);
  return { id, kind, status: 'done', error: null, result: op.result };
}

/**
 * The answer to one AT command: the SIM-less modem is never connected; the working one answers AT+CSQ and AT+CIMI, and OK to the rest.
 * @param {string} id
 * @param {string} command
 */
function atAnswer(id, command) {
  const driver = findModem(id)?.driver ?? 'quectel';
  const base = { modem_id: id, driver, action_id: `at-${state.ops}`, device: id, command, timeout_s: 10,
    reply: `[${id}] AT command queued`, sent_at: Date.now(), observed_at: Date.now() };
  if (findModem(id)?.state === 'flapping') {
    return { ok: false, result: { ...base, reply: `[${id}] Device not connected`, outcome: 'refused', error: `[${id}] Device not connected`, lines: [] },
      error: `${command}: [${id}] Device not connected` };
  }
  const upper = command.toUpperCase();
  const lines = upper.startsWith('AT+CSQ') ? ['+CSQ: 21,99'] : upper.startsWith('AT+CIMI') ? ['001011234567890'] : [];
  return { ok: true, result: { ...base, outcome: 'OK', error: null, lines } };
}

/**
 * One page of a list in the list-route envelope; `total` counts the filtered rows.
 * @param {any[]} rows
 * @param {URLSearchParams} query
 * @param {{ eq?: Record<string, string>, search?: string[] }} [how]  query field → row field, and the fields `q` searches
 */
function listPage(rows, query, { eq = {}, search = [] } = {}) {
  const items = filtered(rows, query, { eq, search });
  const per_page = Math.min(200, Math.max(1, Number(query.get('per_page') ?? '25') || 25));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const total = items.length;
  return json({
    items: items.slice((page - 1) * per_page, page * per_page),
    page,
    per_page,
    total,
    pages: Math.max(1, Math.ceil(total / per_page)),
  });
}

/**
 * The rows a list's filters select.
 * @param {any[]} rows
 * @param {URLSearchParams} query
 * @param {{ eq?: Record<string, string>, search?: string[] }} [options]
 */
function filtered(rows, query, { eq = {}, search = [] } = {}) {
  let items = rows;
  for (const [field, column] of Object.entries(eq)) {
    const wanted = query.get(field);
    if (wanted !== null && wanted !== '') items = items.filter((row) => String(row[column] ?? '') === wanted);
  }
  const q = (query.get('q') ?? '').toLowerCase();
  if (q !== '' && search.length > 0) {
    items = items.filter((row) => search.some((column) => String(row[column] ?? '').toLowerCase().includes(q)));
  }
  return items;
}

const MESSAGE_FILTERS = { eq: { modem: 'modem_id', status: 'status' }, search: ['number', 'text'] };
const CALL_FILTERS = { eq: { modem: 'modem_id', direction: 'direction', outcome: 'outcome' }, search: ['caller', 'did'] };

/**
 * GET /api/calls/summary: calls, answered calls and their talk time per modem and direction.
 * @param {any[]} rows @param {URLSearchParams} query
 */
function callSummary(rows, query) {
  const since = Number(query.get('since') ?? '0');
  const until = query.get('until') === null ? null : Number(query.get('until'));
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const row of rows.filter((call) => call.ended_at >= since && (until === null || call.ended_at < until))) {
    const key = `${row.modem_id} ${row.direction}`;
    const entry = groups.get(key) ?? { modem_id: row.modem_id, direction: row.direction, calls: 0, answered: 0, answered_sec: 0 };
    entry.calls += 1;
    if (row.outcome === 'answered') {
      entry.answered += 1;
      entry.answered_sec += row.answered_sec ?? 0;
    }
    groups.set(key, entry);
  }
  return json({ since, until, items: [...groups.keys()].sort().map((key) => groups.get(key)) });
}

/**
 * The messages of one direction; a status filter implies the outbox, as in the controller.
 * @param {URLSearchParams} query
 */
function messageRows(query) {
  const direction = query.get('direction');
  const status = query.get('status');
  if (direction === 'in' && (status === null || status === '')) return state.messages.filter((/** @type {any} */ row) => row.direction === 'in');
  if (direction === 'out' || (status !== null && status !== '')) return state.messages.filter((/** @type {any} */ row) => row.direction === 'out');
  return state.messages;
}

/** A purge body as the list's query. @param {any} body */
const purgeQuery = (body) => new URLSearchParams(Object.entries(body ?? {}).filter(([key]) => key !== 'before').map(([key, value]) => [key, String(value)]));

/**
 * The answer to one API request.
 * @param {string} method
 * @param {string} path
 * @param {any} body
 * @param {URLSearchParams} query
 */
async function answer(method, path, body, query = new URLSearchParams()) {
  // The health summary is only included with a session.
  if (path === '/api/health') return json(fixtures.health({ summary: state.in }));

  if (path === '/api/login' && method === 'POST') {
    if (typeof body?.password !== 'string' || body.password.length < MIN_PASSWORD) return error('wrong password', 401);
    state.in = true;
    remember(true);
    const now = Date.now();
    return json({ ok: true, session: { created_at: now, last_seen_at: now, expires_at: now + 30 * 86_400_000 } });
  }
  if (path === '/api/logout' && method === 'POST') {
    state.in = false;
    remember(false);
    for (const stream of streams) stream._fail();
    return json({ ok: true });
  }

  // Everything below requires a session.
  if (!state.in) return error('not logged in', 401);

  if (path === '/api/me') {
    const now = Date.now();
    return json({ authenticated: true, session: { created_at: now - 3600_000, last_seen_at: now, expires_at: now + 30 * 86_400_000 } });
  }
  if (path === '/api/overview') {
    return json({
      modems: state.modems.map(withForwarding),
      unassigned: state.devices,
      scan: fixtures.scan(),
      health: fixtures.health({ summary: false }),
      registry: { valid: true, problems: [] },
    });
  }
  if (path === '/api/settings') {
    if (method === 'GET') return json(state.settings);
    if (method === 'PUT') return settingsPut(body);
  }
  if (path === '/api/scan' && method === 'POST') {
    const started = operation('scan', null, {
      result: { devices: 3, unassigned: state.devices.length },
      delayMs: 1200,
    });
    // The scanned device appears when the operation ends.
    setTimeout(() => (state.devices = fixtures.unassigned()), 1200);
    return json({ operation: started }, 202);
  }
  if (path === '/api/scan/latest') {
    return json({ scan: { ...fixtures.scan(), devices: [...state.devices], unassigned: [...state.devices] } });
  }
  if (path === '/api/notify/test' && method === 'POST') {
    if (!state.settings.telegram_token_set) return error('no Telegram bot token is configured', 400);
    return json({ id: ++state.ops, chat_id: body?.chat_id ?? '' }, 202);
  }

  const operationId = /^\/api\/operations\/([0-9]+)$/.exec(path);
  if (operationId && method === 'GET') {
    const id = Number(operationId[1]);
    const op = state.operations.get(id) ?? state.history.find((/** @type {any} */ row) => row.id === id);
    if (!op) return error(`no operation ${id}`, 404);
    return json({ operation: state.operations.has(id) ? op : fixtures.operationDetail(op) });
  }
  if (path === '/api/operations' && method === 'GET') {
    // Operations started in this session come first (newest first).
    const started = [...state.operations.values()].sort((a, b) => b.id - a.id);
    return listPage([...started, ...state.history], query,
      { eq: { modem: 'modem_id', status: 'status', actor: 'actor', kind: 'kind' }, search: ['kind', 'error'] });
  }
  if (path === '/api/messages' && method === 'GET') return listPage(messageRows(query), query, MESSAGE_FILTERS);
  if (path === '/api/messages/purge' && method === 'POST') {
    const matched = filtered(messageRows(purgeQuery(body)), purgeQuery(body), MESSAGE_FILTERS)
      .filter((/** @type {any} */ row) => body?.before === undefined || row.at <= body.before);
    const gone = matched.filter((/** @type {any} */ row) => row.direction === 'in' || REMOVABLE.includes(row.status));
    state.messages = state.messages.filter((/** @type {any} */ row) => !gone.includes(row));
    return json({ deleted: gone.length, kept: matched.length - gone.length });
  }
  const receivedPath = /^\/api\/messages\/in\/([0-9]+)$/.exec(path);
  if (receivedPath && method === 'DELETE') {
    const row = state.messages.find((/** @type {any} */ entry) => entry.direction === 'in' && entry.id === Number(receivedPath[1]));
    if (!row) return error(`no received SMS ${receivedPath[1]}`, 404);
    state.messages = state.messages.filter((/** @type {any} */ entry) => entry !== row);
    return json({ deleted: row.id });
  }
  if (path === '/api/calls' && method === 'GET') return listPage(state.calls, query, CALL_FILTERS);
  if (path === '/api/calls/summary' && method === 'GET') return callSummary(state.calls, query);
  if (path === '/api/calls/purge' && method === 'POST') {
    const gone = filtered(state.calls, purgeQuery(body), CALL_FILTERS)
      .filter((/** @type {any} */ row) => body?.before === undefined || row.ended_at <= body.before);
    state.calls = state.calls.filter((/** @type {any} */ row) => !gone.includes(row));
    return json({ deleted: gone.length });
  }
  const callPath = /^\/api\/calls\/([0-9]+)$/.exec(path);
  if (callPath && method === 'DELETE') {
    const row = state.calls.find((/** @type {any} */ entry) => entry.id === Number(callPath[1]));
    if (!row) return error(`no call ${callPath[1]}`, 404);
    state.calls = state.calls.filter((/** @type {any} */ entry) => entry !== row);
    return json({ deleted: row.id });
  }
  if (path === '/api/notifications' && method === 'GET') {
    return listPage(state.notifications, query, { eq: { status: 'status', kind: 'source_kind', chat_id: 'chat_id' }, search: ['text', 'error'] });
  }

  if (path === '/api/sms' && method === 'POST') return smsPost(body);
  if (path === '/api/sms/purge' && method === 'POST') return smsPurge(body);
  const retryPath = /^\/api\/sms\/([0-9]+)\/retry$/.exec(path);
  if (retryPath && method === 'POST') return smsRetry(Number(retryPath[1]), body?.confirm === true);
  const smsPath = /^\/api\/sms\/([0-9]+)$/.exec(path);
  if (smsPath && method === 'GET') {
    const row = state.messages.find((/** @type {any} */ entry) => entry.direction === 'out' && entry.id === Number(smsPath[1]));
    return row ? json({ sms: { ...row, attempts: [] } }) : error(`no outbox SMS ${smsPath[1]}`, 404);
  }
  if (smsPath && method === 'DELETE') return smsDelete(Number(smsPath[1]));

  if (path === '/api/config/files' && method === 'GET') {
    return json({ files: state.files.map(fileEntry), dir: '/srv/aster/config/asterisk' });
  }
  const configFile = /^\/api\/config\/files\/(.+?)(\/restore)?$/.exec(path);
  if (configFile) return configRoute(method, decodeURIComponent(configFile[1]), Boolean(configFile[2]), body);

  const logName = /^\/api\/logs\/(asterisk|controller)$/.exec(path);
  if (logName && method === 'GET') {
    const which = /** @type {'asterisk' | 'controller'} */ (logName[1]);
    const grep = query.get('grep') ?? '';
    const limit = Math.min(2000, Math.max(1, Number(query.get('lines') ?? '200') || 200));
    const all = fixtures.logLines(which).filter((line) => grep === '' || line.toLowerCase().includes(grep.toLowerCase()));
    const lines = all.slice(Math.max(0, all.length - limit));
    return json(which === 'asterisk'
      ? { file: '/srv/aster/logs/asterisk/full', lines, size: 4096, truncated: false, limit, grep: grep || null }
      : { kept: lines.length, capacity: 1000, dropped: 0, lines, limit, grep: grep || null });
  }

  if (path === '/api/modems') {
    if (method === 'GET') return json({ modems: state.modems.map(withForwarding), registry: { present: true, hash: state.settings.registry.hash } });
    if (method === 'POST') return modemPost(body);
  }
  const modemPath = /^\/api\/modems\/([^/]+)(?:\/([a-z]+(?:\/cancel)?))?$/.exec(path);
  if (modemPath) return modemRoute(method, decodeURIComponent(modemPath[1]), modemPath[2] ?? null, body);

  if (path === '/api/connections' && method === 'GET') return json({ available: true, error: null, phones: fixtures.connections() });

  if (path === '/api/phones') {
    if (method === 'GET') return json({ phones: state.phones.map(phoneView), registry: { present: true, hash: state.settings.registry.hash } });
    if (method === 'POST') return phonePost(body);
  }
  const phonePath = /^\/api\/phones\/([^/]+)$/.exec(path);
  if (phonePath) return phoneRoute(method, decodeURIComponent(phonePath[1]), body);

  return error(`unknown endpoint: ${method} ${path}`, 404);
}

/** The stored verdict belongs to the modem view (http/routes/modems.js reads it out of the state row). */
const withForwarding = (/** @type {any} */ modem) => ({ ...modem, forwarding: state.forwarding[modem.id] ?? null });

/** The statuses a retry needs a confirmation for (sms/outbox.js RETRY_WITH_CONFIRM) and the ones it does not. */
const RETRY_WITH_CONFIRM = ['uncertain', 'rejected', 'undelivered', 'undelivered_expired'];
const RETRY_FREELY = ['failed'];
/** What the purge removes (sms/outbox.js UNSUCCESSFUL), and what a delete does (REMOVABLE): every status a sending ended in. */
const UNSUCCESSFUL = [...RETRY_FREELY, ...RETRY_WITH_CONFIRM];
const REMOVABLE = ['delivered', ...UNSUCCESSFUL];

/** @param {number} id */
function smsDelete(id) {
  const row = state.messages.find((/** @type {any} */ entry) => entry.direction === 'out' && entry.id === id);
  if (!row) return json({ error: `no outbox SMS ${id}`, code: 'not-found' }, 404);
  if (!REMOVABLE.includes(row.status)) {
    return json({ error: `SMS ${id} is ${row.status}; an SMS still being sent cannot be deleted`, code: 'not-removable' }, 409);
  }
  state.messages = state.messages.filter((/** @type {any} */ entry) => entry !== row);
  return json({ deleted: id, status: row.status });
}

/** @param {any} body */
function smsPurge(body) {
  const modem = body?.modem_id;
  const gone = (/** @type {any} */ entry) => entry.direction === 'out' && UNSUCCESSFUL.includes(entry.status) && (modem === undefined || entry.modem_id === modem);
  const deleted = state.messages.filter(gone).length;
  state.messages = state.messages.filter((/** @type {any} */ entry) => !gone(entry));
  return json({ deleted });
}

/** @param {any} body */
function smsPost(body) {
  const refused = invalid(body, { modem_id: /^[a-z][a-z0-9_]{0,15}$/, number: /^\+?[0-9]{2,20}$/, text: /^[\s\S]{1,4096}$/ });
  if (refused) return refused;
  const id = Math.max(0, ...state.messages.map((/** @type {any} */ row) => (row.direction === 'out' ? row.id : 0))) + 1;
  const now = Date.now();
  const row = { direction: 'out', id, modem_id: body.modem_id, number: body.number, text: body.text, status: 'queued',
    at: now, updated_at: now, attempt_no: 1, last_error: null, scts: null };
  state.messages = [row, ...state.messages];
  // The row becomes `submitted` when its operation ends.
  const started = operation('sms-send', body.modem_id, { result: { outbox_id: id, attempt_no: 1 } });
  setTimeout(() => {
    row.status = 'submitted';
    row.updated_at = Date.now();
    state.messages = [...state.messages];
  }, OPERATION_MS);
  return json({ id, attempt_no: 1, operation: started }, 202);
}

/**
 * @param {number} id
 * @param {boolean} confirm
 */
function smsRetry(id, confirm) {
  const row = state.messages.find((/** @type {any} */ entry) => entry.direction === 'out' && entry.id === id);
  if (!row) return error(`no outbox SMS ${id}`, 404);
  if (RETRY_WITH_CONFIRM.includes(row.status) && !confirm) {
    // 409 with `code: confirm-required`, which the Messages page turns into a confirm dialog.
    return json({ error: `SMS ${id} is ${row.status}: it may have reached the recipient, so a retry needs confirm`, code: 'confirm-required' }, 409);
  }
  if (!RETRY_WITH_CONFIRM.includes(row.status) && !RETRY_FREELY.includes(row.status)) {
    return json({ error: `SMS ${id} is ${row.status}; only a failed, uncertain, rejected or undelivered SMS can be retried`, code: 'not-retryable' }, 409);
  }
  row.attempt_no += 1;
  row.status = 'queued';
  row.updated_at = Date.now();
  state.messages = [...state.messages];
  return json({ id, attempt_no: row.attempt_no, operation: operation('sms-send', row.modem_id, { result: { outbox_id: id, attempt_no: row.attempt_no } }) }, 202);
}

/** One entry of the file list, without its content (`GET /api/config/files`). */
function fileEntry(/** @type {any} */ file) {
  const { content, drift, ...entry } = file;
  return { ...entry, hash: hashOf(content), size: content.length, modified_at: Date.now() - 3600_000, applied_hash: hashOf(content), matches_registry: entry.kind === 'generated' ? true : null };
}

/** A cheap stand-in for sha256; the page only compares hashes for equality. */
function hashOf(/** @type {string} */ text) {
  let hash = 0n;
  for (const code of text) hash = (hash * 131n + BigInt(code.codePointAt(0) ?? 0)) % (2n ** 64n);
  return hash.toString(16).padStart(64, '0');
}

/**
 * @param {string} method
 * @param {string} name
 * @param {boolean} restore
 * @param {any} body
 */
function configRoute(method, name, restore, body) {
  const file = state.files.find((/** @type {any} */ entry) => entry.name === name);
  if (!file) return error(`no configuration file ${JSON.stringify(name)}; GET /api/config/files lists them`, 404);
  if (method === 'GET') return json({ ...fileEntry(file), content: file.content });

  if (restore) {
    if (!file.restorable) return error(`no previous version of ${name} is stored; one is kept from the first apply through the controller`, 409);
    file.content = `; restored by the mock\n${file.content}`;
    state.files = [...state.files];
    return json({ ok: true, operation: applied('config-restore') });
  }
  if (method !== 'PUT') return error(`unknown endpoint: ${method} /api/config/files/${name}`, 404);
  if (!file.editable) {
    return error(`${name} is generated from config/aster.yaml and cannot be edited; change the modems, phones or settings instead`, 409);
  }
  const content = typeof body?.content === 'string' ? body.content : '';
  // Simulate one outside write between a page's read and its apply.
  if (file.drift) {
    file.drift = false;
    file.content = `; written by someone else\n${file.content}`;
  }
  // Refuse an apply whose base hash is stale unless forced.
  if (typeof body?.base_hash === 'string' && body.base_hash !== hashOf(file.content) && body?.force !== true) {
    const message = `${name} changed on disk since it was opened; reload it and apply again (or force)`;
    const id = ++state.ops;
    return json({ ok: false, error: message,
      operation: { id, kind: 'config-apply', status: 'failed', result: { name, current_hash: hashOf(file.content) }, error: message } }, 409);
  }
  if (file.restart_required && body?.restart !== true) {
    const id = ++state.ops;
    const message = `${name} takes effect only after a graceful restart of Asterisk (calls end first); confirm with restart: true`;
    return json({ ok: false, error: message, operation: { id, kind: 'config-apply', status: 'failed', result: { name }, error: message } }, 409);
  }
  // Mock lint: a `[` without `]` is refused before writing.
  const bad = content.split('\n').findIndex((line) => /^\s*\[[^\]]*$/.test(line));
  if (bad !== -1) {
    const id = ++state.ops;
    const message = `${name} has 1 lint problem; nothing was written`;
    return json({ ok: false, error: message, operation: { id, kind: 'config-apply', status: 'failed', error: message,
      result: { name, problems: [{ line: bad + 1, message: 'a section header must end with "]"' }] } } }, 409);
  }
  file.content = content;
  file.status = 'applied';
  file.restorable = true;
  state.files = [...state.files];
  return json({ ok: true, operation: applied('config-apply') });
}

/** @param {any} body */
function settingsPut(body) {
  const fields = typeof body === 'object' && body !== null ? body : {};
  if (fields.password) {
    if (typeof fields.password.current !== 'string' || fields.password.current.length < MIN_PASSWORD) {
      return error('the current password is wrong', 401);
    }
    state.in = false;
    remember(false);
    for (const stream of streams) stream._fail();
    return json({ ok: true, changed: ['password'], operation: null, sessions_cleared: 1, settings: state.settings });
  }
  if (fields.telegram_token !== undefined) {
    state.settings = { ...state.settings, telegram_token_set: fields.telegram_token !== null };
    return json({ ok: true, changed: ['telegram_token'], operation: null, sessions_cleared: 0, settings: state.settings });
  }
  const next = { ...state.settings };
  for (const key of ['ui_language', 'timezone', 'alerts']) {
    if (fields[key] !== undefined) next[key] = fields[key];
  }
  if (fields.default_recipients !== undefined) next.default_recipients = [...fields.default_recipients];
  if (fields.retention_days !== undefined) next.retention_days = { ...next.retention_days, ...fields.retention_days };
  state.settings = next;
  const operation = applied();
  return json({ ok: true, changed: Object.keys(fields), operation, sessions_cleared: 0, settings: state.settings });
}

/** @param {any} body */
function modemPost(body) {
  const refused = invalid(body, { id: /^[a-z][a-z0-9_]{0,15}$/, driver: /^(quectel|dongle)$/, imei: /^[0-9]{15}$/ });
  if (refused) return refused;
  const fields = typeof body === 'object' && body !== null ? body : {};
  const taken = state.modems.find((modem) => modem.id === fields.id || modem.imei === fields.imei
    || (fields.usb_port != null && modem.usb_port === fields.usb_port));
  if (taken) {
    return error(`modem ${taken.id} already has that ${taken.id === fields.id ? 'id' : taken.imei === fields.imei ? 'IMEI' : 'USB port'}`, 409);
  }
  const modem = {
    id: fields.id, driver: fields.driver, imei: fields.imei, enabled: fields.enabled ?? true,
    uac: fields.uac ?? false, usb_port: fields.usb_port ?? null, group: null, ring: [], ring_timeout: 120,
    incoming_context: null, recipients: null, ports: null, state: 'unverified', driver_state: null, gsm_registration: null,
    rssi: null, provider: null, number: null, data_tty: null, observed_at: null, forwarding: null, detail: null,
  };
  state.modems = [...state.modems, modem];
  state.devices = state.devices.filter((device) => device.imei !== modem.imei && device.usb_port !== modem.usb_port);
  return json({ ok: true, operation: applied(), modem }, 201);
}

/**
 * @param {string} method
 * @param {string} id
 * @param {string | null} verb
 * @param {any} body
 */
function modemRoute(method, id, verb, body) {
  const modem = findModem(id);
  if (!modem) return error(`no modem ${id} in config/aster.yaml`, 404);

  if (verb === null) {
    if (method === 'GET') return json({ modem: withForwarding(modem), registry: { hash: state.settings.registry.hash } });
    if (method === 'PUT') {
      Object.assign(modem, typeof body === 'object' && body !== null ? body : {});
      state.modems = [...state.modems];
      return json({ ok: true, operation: applied(), modem: withForwarding(modem) });
    }
    if (method === 'DELETE') {
      const dials = state.phones.filter((phone) => phone.outbound === id).map((phone) => phone.number);
      if (dials.length > 0) return error(`phone ${dials.join(', ')} dials out through modem ${id}; change or delete ${dials.length === 1 ? 'it' : 'them'} first`, 409);
      state.modems = state.modems.filter((entry) => entry.id !== id);
      return json({ ok: true, operation: applied(), modem: null });
    }
  }

  if (method !== 'POST' && !(method === 'GET' && verb === 'forwarding')) return error(`unknown endpoint: ${method} /api/modems/${id}/${verb}`, 404);

  if (verb === 'forwarding') {
    if (method === 'GET') return json({ modem_id: id, forwarding: state.forwarding[id] ?? null });
    return json({ operation: forwardingOperation(id, body ?? {}) }, 202);
  }
  if (verb === 'at') {
    const run = atAnswer(id, String(body?.command ?? ''));
    return json({ operation: operation('at', id, run.ok ? { result: run.result } : { status: 'failed', result: run.result, error: run.error }) }, 202);
  }
  if (verb === 'ussd') {
    const connected = modem.state !== 'flapping';
    const code = String(body?.code ?? '');
    // *111# opens a menu (session state 1) that an option number answers; anything else is a final answer (0).
    const menu = state.ussdMenus.delete(id);
    const [type, text] = menu ? [0, code === '1' ? 'Ваш баланс 12.34 EUR' : code === '2' ? 'Ваш номер +1234567890' : `Пункта ${code} нет`]
      : code === '*111#' ? [1, 'Меню\n1. Баланс\n2. Мой номер'] : [0, `Ваш баланс 12.34 EUR. Запрос ${code}`];
    if (connected && type === 1) state.ussdMenus.add(id);
    return json({ operation: operation('ussd', id, connected
      ? { result: { modem_id: id, driver: modem.driver, code, reply: `[${id}] USSD queued for send`, type, text, lines: text.split('\n'), sent_at: Date.now(), observed_at: Date.now() } }
      : { status: 'uncertain', result: null, error: `[${id}] Device disconnected` }) }, 202);
  }
  if (verb === 'ussd/cancel') {
    state.ussdMenus.delete(id);
    return json({ operation: operation('ussd-cancel', id, { result: { modem_id: id, driver: modem.driver, command: 'AT+CUSD=2', outcome: 'OK', lines: [] } }) }, 202);
  }
  if (['start', 'stop', 'restart', 'reset', 'remap'].includes(String(verb))) {
    const kind = verb === 'remap' ? 'remap' : `modem-${verb}`;
    if (verb === 'start' || verb === 'restart') setTimeout(() => publishState(id, 'connecting'), OPERATION_MS / 2);
    if (verb === 'stop') setTimeout(() => publishState(id, 'stopped'), OPERATION_MS / 2);
    return json({ operation: operation(kind, id, { result: { events: [] } }) }, 202);
  }
  return error(`unknown endpoint: ${method} /api/modems/${id}/${verb}`, 404);
}

/** The conditions each forwarding reason covers (at/forwarding.js). */
const FORWARD_COVERS = /** @type {Record<string, string[]>} */ ({
  unconditional: ['unconditional'], busy: ['busy'], no_reply: ['no_reply'], not_reachable: ['not_reachable'],
  conditional: ['busy', 'no_reply', 'not_reachable'], all: ['unconditional', 'busy', 'no_reply', 'not_reachable'],
});

/**
 * A forwarding operation: the mutation, then a query per covered condition; only query answers become state.
 * @param {string} id
 * @param {{ action?: string, reason?: string, number?: string, time?: number }} body
 */
function forwardingOperation(id, { action, reason = 'unconditional', number, time }) {
  const conditions = FORWARD_COVERS[reason] ?? [];
  const known = state.forwarding[id] ?? {};
  /** @type {Record<string, any>} */
  const verdicts = {};
  const reachable = findModem(id)?.state !== 'flapping';
  for (const condition of conditions) {
    if (!reachable) {
      verdicts[condition] = fixtures.forwarding({ verified: false, outcome: 'uncertain', enabled: null, number: null, entries: [], lines: [],
        error: `[${id}] Device not connected`, observed_at: Date.now() });
      continue;
    }
    const before = known[condition] ?? fixtures.forwarding();
    const enabled = action === 'set' || action === 'enable' ? true : action === 'disable' || action === 'erase' ? false : Boolean(before.enabled);
    const to = action === 'set' ? (number ?? null) : action === 'erase' ? null : before.number;
    const wait = condition !== 'no_reply' ? null : action === 'set' ? (time ?? 20) : action === 'erase' ? null : before.time;
    verdicts[condition] = fixtures.forwarding({
      enabled,
      number: enabled ? to : null,
      type: enabled && to ? 145 : null,
      time: enabled ? wait : null,
      entries: [{ class: 1, status: enabled ? 1 : 0, number: enabled ? to : null, type: enabled && to ? 145 : null }],
      lines: enabled ? [`+CCFC: 1,1,"${to ?? ''}",145${wait ? `,,,${wait}` : ''}`] : ['+CCFC: 0,1'],
      observed_at: Date.now(),
    });
  }
  state.forwarding[id] = { ...known, ...verdicts };
  if (!reachable) return operation('forwarding', id, { status: 'failed', result: { forwarding: verdicts }, error: `AT+CCFC=0,2: [${id}] Device not connected` });
  return operation('forwarding', id, { result: { forwarding: verdicts } });
}

/**
 * Applies `rings_for`: adds the number to those modems' ring lists and removes it from the rest.
 * Returns an error response for an invalid value, else null.
 * @param {string} number
 * @param {unknown} ringsFor
 */
function applyRings(number, ringsFor) {
  if (ringsFor === undefined) return null;
  if (!Array.isArray(ringsFor) || ringsFor.some((id) => typeof id !== 'string') || new Set(ringsFor).size !== ringsFor.length) {
    return error('body/rings_for must be a list of distinct modem ids', 400);
  }
  const unknown = ringsFor.filter((id) => !state.modems.some((modem) => modem.id === id));
  if (unknown.length > 0) return error(`modem ${unknown.join(', ')} is not in modems`, 400);
  state.modems = state.modems.map((modem) => {
    const wanted = ringsFor.includes(modem.id);
    if (wanted === modem.ring.includes(number)) return modem;
    return { ...modem, ring: wanted ? [...modem.ring, number] : modem.ring.filter((/** @type {string} */ member) => member !== number) };
  });
  return null;
}

/** @param {any} body */
function phonePost(body) {
  const refused = invalid(body, { number: /^[0-9]{3,6}$/, secret: /^[\x21-\x3a\x3c-\x7e]{1,128}$/ });
  if (refused) return refused;
  const fields = typeof body === 'object' && body !== null ? body : {};
  if (findPhone(fields.number)) return error(`phone ${fields.number} already exists`, 409);
  const ringsRefused = applyRings(fields.number, fields.rings_for);
  if (ringsRefused) return ringsRefused;
  const phone = { number: fields.number, label: fields.label ?? null, secret: fields.secret, outbound: fields.outbound ?? null,
    context: fields.context ?? null, direct_media: fields.direct_media ?? false };
  state.phones = [...state.phones, phone];
  return json({ ok: true, operation: applied(), phone: phoneView(phone) }, 201);
}

/**
 * @param {string} method
 * @param {string} number
 * @param {any} body
 */
function phoneRoute(method, number, body) {
  const phone = findPhone(number);
  if (!phone) return error(`no phone ${number} in config/aster.yaml`, 404);
  if (method === 'GET') return json({ phone: phoneView(phone), registry: { hash: state.settings.registry.hash } });
  if (method === 'PUT') {
    const { rings_for: ringsFor, ...fields } = typeof body === 'object' && body !== null ? body : {};
    const ringsRefused = applyRings(number, ringsFor);
    if (ringsRefused) return ringsRefused;
    Object.assign(phone, fields);
    state.phones = [...state.phones];
    return json({ ok: true, operation: applied(), phone: phoneView(phone) });
  }
  if (method === 'DELETE') {
    const rings = state.modems.filter((modem) => modem.ring.includes(number)).map((modem) => modem.id);
    if (rings.length > 0) return error(`modem ${rings.join(', ')} rings phone ${number}; take it out of ${rings.length === 1 ? 'that ring group' : 'those ring groups'} first`, 409);
    state.phones = state.phones.filter((entry) => entry.number !== number);
    return json({ ok: true, operation: applied(), phone: null });
  }
  return error(`unknown endpoint: ${method} /api/phones/${number}`, 404);
}

/**
 * Emits a `modem.state` event like the controller does.
 * @param {string} id
 * @param {string} next
 */
function publishState(id, next) {
  const modem = findModem(id);
  if (!modem) return;
  modem.state = next;
  modem.observed_at = Date.now();
  state.modems = [...state.modems];
  emit('modem.state', { modem_id: id, state: next, driver_state: modem.driver_state, rssi: modem.rssi, provider: modem.provider,
    number: modem.number, data_tty: modem.data_tty, observed_at: modem.observed_at, detail: modem.detail });
}

/**
 * @param {string} type
 * @param {unknown} payload
 */
function emit(type, payload) {
  for (const stream of streams) stream._emit(type, payload);
}

/** What `new EventSource('/api/events')` becomes: the same surface api.js uses, driven by this module. */
class MockEventSource extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  /** @param {string} url */
  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockEventSource.CONNECTING;
    this.withCredentials = true;
    if (!state.in) {
      // The controller refuses a stream without a session, and the browser then closes it for good.
      setTimeout(() => this._fail(), LATENCY_MS);
      return;
    }
    streams.add(this);
    setTimeout(() => {
      if (this.readyState !== MockEventSource.CONNECTING) return;
      this.readyState = MockEventSource.OPEN;
      this.dispatchEvent(new Event('open'));
    }, LATENCY_MS);
  }

  /** @param {string} type @param {unknown} payload */
  _emit(type, payload) {
    if (this.readyState !== MockEventSource.OPEN) return;
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
  }

  _fail() {
    streams.delete(this);
    this.readyState = MockEventSource.CLOSED;
    this.dispatchEvent(new Event('error'));
  }

  close() {
    streams.delete(this);
    this.readyState = MockEventSource.CLOSED;
  }
}

export function installMock() {
  const real = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
    return answer(method, url.pathname, body, url.searchParams);
  };

  Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: MockEventSource });
  // Make it obvious in the console that this is the mock.
  console.info('Aster UI: mock mode — no controller is being contacted (VITE_MOCK=1)');
}
