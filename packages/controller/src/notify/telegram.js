// @ts-check
// Telegram Bot API client: sendMessage() posts plain text (no parse_mode) and never throws for a failed send; the result
// says whether a retry can help. Error texts never contain the bot token, since they are shown in the UI and logs.

/**
 * @typedef {object} SendOptions
 * @property {string} [apiBase]         default https://api.telegram.org (tests point it at a fake server)
 * @property {number} [timeoutMs]       whole request including the answer (15 s)
 * @property {AbortSignal} [signal]     aborts the request early (the queue's stop())
 * @property {typeof fetch} [fetch]
 */
/** @typedef {{ ok: true, messageId: number | null, status: number }} SendOk */
/** @typedef {{ ok: false, permanent: boolean, retryAfter: number | null, status: number | null, error: string }} SendFailure */
/** @typedef {SendOk | SendFailure} SendResult */
/**
 * @typedef {{ ok?: unknown, result?: { message_id?: unknown }, description?: unknown,
 *   parameters?: { retry_after?: unknown, migrate_to_chat_id?: unknown } }} BotAnswer  the fields of a Bot API answer that are read
 */

export const API_BASE = 'https://api.telegram.org';
export const TIMEOUT_MS = 15_000;
/** HTTP statuses after which the same request can never succeed. */
export const PERMANENT_STATUSES = Object.freeze([400, 401, 403, 404]);
/** A bot token as BotFather issues it (`<bot id>:<secret>`); nothing else may become part of the request path. */
export const TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{1,128}$/;
/** A chat id as the registry writes it, with a length Telegram ids stay far below. */
const CHAT_ID = /^-?[0-9]{1,32}$/;
/** Longest error text kept. */
const ERROR_MAX = 300;

/**
 * @param {unknown} token
 * @returns {token is string}
 */
export const isToken = (token) => typeof token === 'string' && TOKEN.test(token);

/**
 * @param {string} text
 * @param {string} token
 */
function clean(text, token) {
  const safe = text.split(token).join('<token>').replace(/\s+/g, ' ').trim();
  return safe.length > ERROR_MAX ? `${safe.slice(0, ERROR_MAX - 1)}…` : safe;
}

/**
 * A readable text for a fetch failure: the timeout, an abort, or the network error behind fetch's "fetch failed".
 * @param {unknown} err
 * @param {number} timeoutMs
 */
function fetchError(err, timeoutMs) {
  if (!(err instanceof Error)) return `request failed: ${String(err)}`;
  if (err.name === 'TimeoutError') return `no answer within ${timeoutMs / 1000} s`;
  if (err.name === 'AbortError') return 'request aborted';
  const cause = /** @type {{ code?: unknown, message?: unknown } | undefined} */ (err.cause);
  const detail = cause && typeof cause.message === 'string' ? cause.message : typeof cause?.code === 'string' ? cause.code : null;
  return detail ? `${err.message}: ${detail}` : err.message;
}

/**
 * A positive whole number of seconds, or null.
 * @param {unknown} value
 */
function seconds(value) {
  const number = typeof value === 'string' && /^[0-9]{1,9}$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Sends one message. Throws only for a malformed token (the caller checks it with isToken); a chat id Telegram cannot have is a
 * permanent failure like any other refused request.
 * @param {string} token
 * @param {string} chatId  digits with an optional leading `-` (registry chat ids), sent as a string so no id loses precision
 * @param {string} text
 * @param {SendOptions} [options]
 * @returns {Promise<SendResult>}
 */
export async function sendMessage(token, chatId, text, { apiBase = API_BASE, timeoutMs = TIMEOUT_MS, signal, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!isToken(token)) throw new TypeError('the Telegram bot token is malformed (expected <digits>:<letters, digits, _ or ->)');
  if (!CHAT_ID.test(chatId)) return { ok: false, permanent: true, retryAfter: null, status: null, error: 'the chat id is not digits with an optional leading -' };
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  /** @type {Response} */
  let response;
  try {
    response = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: combined,
    });
  } catch (err) {
    return { ok: false, permanent: false, retryAfter: null, status: null, error: clean(fetchError(err, timeoutMs), token) };
  }
  const { status } = response;
  /** @type {BotAnswer | null} */
  let answer = null;
  try {
    const body = await response.json();
    if (body !== null && typeof body === 'object') answer = body;
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, permanent: false, retryAfter: null, status, error: clean(fetchError(err, timeoutMs), token) };
    }
  }
  if (status === 200 && answer?.ok === true) {
    const messageId = answer.result?.message_id;
    return { ok: true, messageId: typeof messageId === 'number' && Number.isInteger(messageId) ? messageId : null, status };
  }
  const description = typeof answer?.description === 'string' ? answer.description : `${response.statusText || 'no description'} (not a Bot API answer)`;
  const moved = answer?.parameters?.migrate_to_chat_id;
  const error = clean(`HTTP ${status}: ${description}${typeof moved === 'number' || typeof moved === 'string' ? ` (the chat moved to ${moved})` : ''}`, token);
  if (PERMANENT_STATUSES.includes(status)) return { ok: false, permanent: true, retryAfter: null, status, error };
  const retryAfter = status === 429 ? seconds(answer?.parameters?.retry_after) ?? seconds(response.headers.get('retry-after')) : null;
  return { ok: false, permanent: false, retryAfter, status, error };
}
