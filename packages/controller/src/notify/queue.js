// @ts-check
// Telegram notification queue: one row per recipient and message part, sent oldest first with backoff, per-chat holds
// after a 429, and a 24 h limit. A row left `sending` is sent again, so a message may arrive twice but is never lost.
import { hostname } from 'node:os';
import { chunk } from './chunk.js';
import { isToken, sendMessage } from './telegram.js';
import { testText } from './texts.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../bus.js').Bus} Bus */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('./telegram.js').SendResult} SendResult */
/** @typedef {import('./telegram.js').SendOptions} SendOptions */
/** @typedef {'sms' | 'call' | 'alert' | 'test'} SourceKind */
/** @typedef {'pending' | 'sending' | 'sent' | 'retry' | 'failed'} Status */
/**
 * @typedef {object} Notification  a notifications row
 * @property {number} id
 * @property {SourceKind} source_kind
 * @property {number | null} source_id  messages.id (sms) or calls.id (call); null for alert and test
 * @property {string} chat_id
 * @property {number} part_no
 * @property {number} part_count
 * @property {string} text
 * @property {Status} status
 * @property {number} attempts
 * @property {number | null} next_at
 * @property {number | null} tg_message_id
 * @property {string | null} error
 * @property {number} created_at
 * @property {number | null} sent_at
 */
/**
 * @typedef {object} Timing
 * @property {number} tickMs     worker period (1 s)
 * @property {number} maxAgeMs   a row not sent this long after created_at fails (24 h)
 * @property {number} timeoutMs  per request (15 s)
 * @property {number} batch      due rows read per tick (100)
 */
/**
 * @typedef {object} QueueOptions
 * @property {DatabaseSync} db
 * @property {Bus} bus
 * @property {Logger} [log]
 * @property {() => string | null | undefined} token  the bot token now (secrets.env TELEGRAM_BOT_TOKEN); read at every tick
 * @property {() => string} [timeZone]  display time zone of the test probe text (registry settings.timezone)
 * @property {() => string} [host]  the host name that starts the test probe text (default: this machine's)
 * @property {() => number} [now]
 * @property {(token: string, chatId: string, text: string, options: SendOptions) => Promise<SendResult>} [send]  default sendMessage
 * @property {string} [apiBase]   Bot API base URL (tests)
 * @property {Partial<Timing>} [timing]
 */
/** @typedef {{ expired: number, sent: number, retried: number, failed: number, waiting: number, skipped: string | null }} TickResult */

export const SOURCE_KINDS = Object.freeze(/** @type {const} */ (['sms', 'call', 'alert', 'test']));
export const STATUSES = Object.freeze(/** @type {const} */ (['pending', 'sending', 'sent', 'retry', 'failed']));
/** Delay after failed attempt 1, 2, … (the last one repeats). */
export const BACKOFF_MS = Object.freeze([5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000]);
export const DEFAULTS = Object.freeze({ tickMs: 1_000, maxAgeMs: 86_400_000, timeoutMs: 15_000, batch: 100 });
const CHAT_ID = /^-?[0-9]+$/;

/** A request the queue refuses (a malformed chat id, no token for the test probe). */
export class NotifyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NotifyError';
  }
}

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

const INSERT = `INSERT INTO notifications (source_kind, source_id, chat_id, part_no, part_count, text, status, attempts, next_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`;
const EXPIRE = `UPDATE notifications SET status = 'failed', next_at = NULL,
  error = CASE WHEN error IS NULL THEN ? ELSE ? || ': ' || error END
  WHERE status IN ('pending', 'retry') AND created_at <= ? RETURNING *`;
/** Due rows oldest first, except those of the chats on hold (a JSON array of chat ids), so a held chat's backlog cannot fill the batch. */
const SELECT_DUE = `SELECT * FROM notifications WHERE status IN ('pending', 'retry') AND next_at <= ?
  AND chat_id NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`;
/** The part before this one: the nearest earlier row of the same message (parts are inserted together, in order). */
const SELECT_PREVIOUS = `SELECT id, status FROM notifications WHERE chat_id = ? AND source_kind = ? AND source_id IS ? AND part_count = ?
  AND part_no = ? AND id < ? ORDER BY id DESC LIMIT 1`;
const CLAIM = `UPDATE notifications SET status = 'sending', attempts = attempts + 1
  WHERE id = ? AND status IN ('pending', 'retry') RETURNING attempts`;
const SENT = `UPDATE notifications SET status = 'sent', tg_message_id = ?, error = NULL, next_at = NULL, sent_at = ? WHERE id = ? RETURNING *`;
const RETRY = `UPDATE notifications SET status = 'retry', error = ?, next_at = ? WHERE id = ? RETURNING *`;
const FAIL = `UPDATE notifications SET status = 'failed', error = ?, next_at = NULL WHERE id = ? RETURNING *`;
const PULL_FORWARD = `UPDATE notifications SET next_at = ? WHERE chat_id = ? AND status = 'retry' AND next_at > ?`;
const RECOVER = `UPDATE notifications SET status = 'retry', next_at = ? WHERE status = 'sending' RETURNING id`;

/**
 * Stores a notification: one row per chat id and part, `pending`, due at `now`. Inside an open transaction the rows join it;
 * otherwise they are written in one transaction of their own. A blank text or no chat ids → no rows.
 * @param {DatabaseSync} db
 * @param {{ sourceKind: SourceKind, sourceId?: number | null, chatIds: readonly string[], text: string, now?: number }} notification
 * @returns {number[]} the new row ids, per chat in part order
 */
export function enqueue(db, { sourceKind, sourceId = null, chatIds, text, now = Date.now() }) {
  if (!SOURCE_KINDS.includes(sourceKind)) throw new NotifyError(`unknown notification source kind ${JSON.stringify(sourceKind)}`);
  for (const chatId of chatIds) {
    if (typeof chatId !== 'string' || !CHAT_ID.test(chatId)) throw new NotifyError(`a chat id is digits with an optional leading -, not ${JSON.stringify(chatId)}`);
  }
  const parts = chunk(text);
  if (parts.length === 0 || chatIds.length === 0) return [];
  const insert = db.prepare(INSERT);
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN IMMEDIATE');
  try {
    /** @type {number[]} */
    const ids = [];
    for (const chatId of new Set(chatIds)) {
      for (const [index, part] of parts.entries()) {
        ids.push(Number(insert.run(sourceKind, sourceId, chatId, index + 1, parts.length, part, now, now).lastInsertRowid));
      }
    }
    if (own) db.exec('COMMIT');
    return ids;
  } catch (err) {
    if (own) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite has already rolled the transaction back; the original error is rethrown.
      }
    }
    throw err;
  }
}

/**
 * The notification.result payload: the row without its text.
 * @param {Notification} row
 * @param {number} at
 */
function result(row, at) {
  const { text: _text, ...rest } = row;
  return { ...rest, at };
}

/**
 * @param {QueueOptions} options
 */
export function createNotifyQueue({ db, bus, log = SILENT, token, timeZone = () => 'UTC', host = hostname, now = Date.now, send = sendMessage, apiBase,
  timing = {} }) {
  const t = { ...DEFAULTS, ...timing };
  const statements = {
    expire: db.prepare(EXPIRE),
    due: db.prepare(SELECT_DUE),
    previous: db.prepare(SELECT_PREVIOUS),
    claim: db.prepare(CLAIM),
    sent: db.prepare(SENT),
    retry: db.prepare(RETRY),
    fail: db.prepare(FAIL),
    pullForward: db.prepare(PULL_FORWARD),
    recover: db.prepare(RECOVER),
  };
  const expiredText = `not sent within ${t.maxAgeMs % 3_600_000 === 0 ? `${t.maxAgeMs / 3_600_000} h` : `${t.maxAgeMs / 1000} s`}`;
  /** Chat id → epoch ms before which nothing is sent to the chat (after a 429). @type {Map<string, number>} */
  const holds = new Map();
  const abort = new AbortController();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<TickResult> | null} */
  let running = null;
  let started = false;
  let stopped = false;
  /** The token problem last logged ('missing' | 'malformed'); null while the token is usable. @type {string | null} */
  let tokenProblem = null;

  /**
   * @param {Notification | undefined} row
   * @param {number} at
   */
  function publish(row, at) {
    if (row) bus.publish('notification.result', result({ ...row }, at));
  }

  /**
   * One attempt of one row; the row is `sending` already.
   * @param {Notification} row
   * @param {number} attempts  including this one
   * @param {string} botToken
   * @param {TickResult} summary
   * @returns {Promise<boolean>} false when the rest of the tick should wait: the network or Telegram itself failed (no answer, a 5xx),
   *   which the next row would most likely meet as well — each attempt can take the whole request timeout
   */
  async function attempt(row, attempts, botToken, summary) {
    /** @type {SendResult} */
    let outcome;
    try {
      outcome = await send(botToken, row.chat_id, row.text, { apiBase, timeoutMs: t.timeoutMs, signal: abort.signal });
    } catch (err) {
      outcome = { ok: false, permanent: false, retryAfter: null, status: null, error: `send failed: ${errorText(err)}` };
    }
    const at = now();
    if (outcome.ok) {
      publish(/** @type {Notification | undefined} */ (statements.sent.get(outcome.messageId, at, row.id)), at);
      statements.pullForward.run(at, row.chat_id, at);
      summary.sent += 1;
      log.debug('notification sent', { id: row.id, chat_id: row.chat_id, part: `${row.part_no}/${row.part_count}`, attempts });
    } else if (outcome.permanent) {
      publish(/** @type {Notification | undefined} */ (statements.fail.get(outcome.error, row.id)), at);
      summary.failed += 1;
      log.warn('notification failed', { id: row.id, source_kind: row.source_kind, chat_id: row.chat_id, attempts, error: outcome.error });
    } else {
      const delay = stopped ? 0 : outcome.retryAfter !== null ? outcome.retryAfter * 1000 : BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? 0;
      if (outcome.retryAfter !== null) holds.set(row.chat_id, at + delay);
      publish(/** @type {Notification | undefined} */ (statements.retry.get(outcome.error, at + delay, row.id)), at);
      summary.retried += 1;
      log.info('notification send failed; retrying later', { id: row.id, chat_id: row.chat_id, attempts, retry_in_ms: delay, error: outcome.error });
      return outcome.status !== null && outcome.status < 500;
    }
    return true;
  }

  /**
   * Rows left `sending` while no request is in flight (at start(), and at a tick's start, since ticks never overlap) → `retry`, due now.
   * @param {number} at
   */
  function recover(at) {
    const recovered = statements.recover.all(at);
    if (recovered.length > 0) {
      log.warn('notifications interrupted while sending are retried; Telegram may show them twice', { ids: recovered.map((row) => Number(row.id)) });
    }
  }

  /** @returns {Promise<TickResult>} */
  async function tickOnce() {
    /** @type {TickResult} */
    const summary = { expired: 0, sent: 0, retried: 0, failed: 0, waiting: 0, skipped: null };
    const at = now();
    recover(at);
    for (const [chatId, until] of [...holds]) if (until <= at) holds.delete(chatId);
    for (const row of /** @type {Notification[]} */ (statements.expire.all(expiredText, expiredText, at - t.maxAgeMs))) {
      publish(row, at);
      summary.expired += 1;
      log.warn('notification failed', { id: row.id, source_kind: row.source_kind, chat_id: row.chat_id, attempts: row.attempts, error: row.error });
    }
    const due = /** @type {Notification[]} */ (statements.due.all(at, JSON.stringify([...holds.keys()]), t.batch));
    if (due.length === 0) return summary;
    const botToken = token();
    if (!isToken(botToken)) {
      const problem = botToken ? 'malformed' : 'missing';
      if (tokenProblem !== problem) {
        tokenProblem = problem;
        if (problem === 'missing') log.warn('no Telegram bot token (TELEGRAM_BOT_TOKEN): notifications stay queued and fail 24 h after they were created');
        else log.error('the Telegram bot token is malformed (expected <digits>:<letters, digits, _ or ->): notifications stay queued');
      }
      summary.waiting = due.length;
      summary.skipped = `token ${problem}`;
      return summary;
    }
    if (tokenProblem !== null) log.info('Telegram bot token configured; sending queued notifications');
    tokenProblem = null;
    for (const row of due) {
      if (stopped) break;
      const hold = holds.get(row.chat_id);
      if (hold !== undefined && hold > now()) {
        summary.waiting += 1;
        continue;
      }
      holds.delete(row.chat_id);
      if (row.part_no > 1) {
        const previous = statements.previous.get(row.chat_id, row.source_kind, row.source_id, row.part_count, row.part_no - 1, row.id);
        if (previous?.status === 'failed') {
          const failedAt = now();
          publish(/** @type {Notification | undefined} */ (statements.fail.get(`part ${row.part_no - 1} of ${row.part_count} was not sent`, row.id)), failedAt);
          summary.failed += 1;
          continue;
        }
        if (previous && previous.status !== 'sent') {
          summary.waiting += 1;
          continue;
        }
      }
      const claimed = statements.claim.get(row.id);
      if (!claimed) continue;
      if (!(await attempt(row, Number(claimed.attempts), botToken, summary))) break;
    }
    return summary;
  }

  /**
   * Runs one tick now; while one runs, returns it.
   * @returns {Promise<TickResult>}
   */
  function tick() {
    if (running) return running;
    if (stopped) return Promise.resolve({ expired: 0, sent: 0, retried: 0, failed: 0, waiting: 0, skipped: 'stopped' });
    running = tickOnce().catch((err) => {
      log.error('notification queue tick failed', { err });
      return /** @type {TickResult} */ ({ expired: 0, sent: 0, retried: 0, failed: 0, waiting: 0, skipped: `failed: ${errorText(err)}` });
    }).finally(() => {
      running = null;
    });
    return running;
  }

  return {
    /** Makes rows a stopped controller left `sending` due again, then ticks every tickMs. */
    start() {
      if (started) throw new Error('notification queue already started');
      started = true;
      recover(now());
      timer = setInterval(() => void tick(), t.tickMs);
      void tick();
    },
    /** Stops the ticks, aborts a request in flight (its row is due again at the next start) and waits for the tick to end. */
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      abort.abort();
      if (running) await running;
    },
    tick,
    /**
     * The Settings test probe: one `test` notification to `chatId`, sent by the worker like any other. Refused without a usable token.
     * @param {string} chatId
     * @returns {number} the row id
     */
    enqueueTest(chatId) {
      if (typeof chatId !== 'string' || !CHAT_ID.test(chatId)) throw new NotifyError(`a chat id is digits with an optional leading -, not ${JSON.stringify(chatId)}`);
      if (!isToken(token())) throw new NotifyError('no usable Telegram bot token is configured (TELEGRAM_BOT_TOKEN in secrets.env)');
      const at = now();
      const [id] = enqueue(db, { sourceKind: 'test', chatIds: [chatId], text: testText({ host: host(), at, timeZone: timeZone() }), now: at });
      if (id === undefined) throw new Error('the test notification was not stored');
      return id;
    },
  };
}
