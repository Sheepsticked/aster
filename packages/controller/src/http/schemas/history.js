// @ts-check
// Aster controller — JSON schemas of the history routes (messages, calls, notifications, operations, logs).
// Query fields are strings with patterns, parsed by the route; `q` is a plain substring, not a pattern.
import { MAX_Q, PAGE_QUERY } from '../page.js';

const MODEM = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,15}$' };
/** @param {Record<string, unknown>} properties */
const query = (properties) => ({ querystring: { type: 'object', additionalProperties: false, properties: { ...PAGE_QUERY, ...properties } } });

/** GET /api/messages — inbox and outbox in one list, newest first. */
export const messages = query({ direction: { enum: ['in', 'out'] }, modem: MODEM, status: { type: 'string', maxLength: 32 } });

/** GET /api/calls. */
export const calls = query({ modem: MODEM, outcome: { enum: ['answered', 'missed', 'failed'] } });

/** GET /api/notifications. */
export const notifications = query({
  status: { enum: ['pending', 'sending', 'sent', 'retry', 'failed'] },
  kind: { enum: ['sms', 'call', 'alert', 'test'] },
  chat_id: { type: 'string', pattern: '^-?[0-9]{1,20}$' },
});

/** GET /api/operations. */
export const operations = query({
  kind: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
  modem: MODEM,
  status: { enum: ['queued', 'running', 'interrupted', 'done', 'failed', 'uncertain'] },
  actor: { enum: ['admin', 'cli', 'system'] },
});

/** GET /api/operations/:id and GET /api/sms/:id. */
export const byId = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9]{1,15}$' } } };

/** GET /api/logs/asterisk and /api/logs/controller (`lines` ≤ 2000, `grep` a plain substring). */
export const logs = ({
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { lines: { type: 'string', pattern: '^[0-9]{1,4}$' }, grep: { type: 'string', maxLength: MAX_Q } },
  },
});

/** POST /api/sms. */
export const send = ({
  body: {
    type: 'object',
    required: ['modem_id', 'number', 'text'],
    additionalProperties: false,
    properties: {
      modem_id: MODEM,
      number: { type: 'string', pattern: '^\\+?[0-9]{2,20}$' },
      text: { type: 'string', minLength: 1, maxLength: 4096 },
    },
  },
});

/** POST /api/sms/:id/retry — `confirm` is required for a status that may already have reached the recipient (sms/outbox.js). */
export const retry = ({
  params: byId,
  body: { type: 'object', additionalProperties: false, properties: { confirm: { type: 'boolean' } } },
});

/** A purge bound: rows at or before this epoch ms (the newest row the admin was shown), so one that arrives meanwhile stays. */
const BEFORE = { type: 'integer', minimum: 0 };
/** @param {Record<string, unknown>} properties */
const body = (properties) => ({ body: { type: 'object', additionalProperties: false, properties } });

/** POST /api/messages/purge — what GET /api/messages lists with the same filters. */
export const messagesPurge = body({
  direction: { enum: ['in', 'out'] }, modem: MODEM, status: { type: 'string', maxLength: 32 },
  q: { type: 'string', maxLength: MAX_Q }, before: BEFORE,
});

/** POST /api/calls/purge — what GET /api/calls lists with the same filters. */
export const callsPurge = body({
  modem: MODEM, outcome: { enum: ['answered', 'missed', 'failed'] }, q: { type: 'string', maxLength: MAX_Q }, before: BEFORE,
});

/** POST /api/sms/purge — without `modem_id`, the SMS of every modem. */
export const purge = ({
  body: { type: 'object', additionalProperties: false, properties: { modem_id: MODEM } },
});

/** POST /api/notify/test. */
export const notifyTest = ({
  body: {
    type: 'object',
    required: ['chat_id'],
    additionalProperties: false,
    properties: { chat_id: { type: 'string', pattern: '^-?[0-9]{1,20}$' } },
  },
});
