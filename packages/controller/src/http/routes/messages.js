// @ts-check
// Aster controller — GET /api/messages: inbox and outbox as one UNION list, newest first, so paging spans both.
// DELETE /api/messages/in/:id and POST /api/messages/purge delete SMS (not ones still being sent) with their spool events.
import { REMOVABLE } from '../../sms/outbox.js';
import { transaction } from '../../store/db.js';
import { byId, messages as schema, messagesPurge } from '../schemas/history.js';
import { offset, page, paging, where } from '../page.js';

/** The columns both halves of the UNION produce, in this order. */
const COLUMNS = `direction, id, modem_id, number, text, status, at, updated_at, attempt_no, last_error, scts`;
const INBOX = `SELECT 'in' AS direction, id, modem_id, sender AS number, text, NULL AS status, received_at AS at,
  received_at AS updated_at, NULL AS attempt_no, NULL AS last_error, scts FROM messages`;
const OUTBOX = `SELECT 'out' AS direction, id, modem_id, number, text, status, created_at AS at,
  updated_at, attempt_no, last_error, NULL AS scts FROM sms_outbox`;
/** Every sms event has a messages row until that row is deleted. */
const ORPHAN_EVENTS = "DELETE FROM events WHERE kind = 'sms' AND id NOT IN (SELECT event_id FROM messages)";

/**
 * The WHERE of one half of the list.
 * @param {'in' | 'out'} direction
 * @param {{ modem?: string, status?: string, q: string | null, before?: number }} filters
 */
function filter(direction, { modem, status, q, before }) {
  const w = where();
  w.eq('modem_id', modem);
  w.contains(direction === 'in' ? ['sender', 'text'] : ['number', 'text'], q);
  if (direction === 'out') w.eq('status', status);
  w.atMost(direction === 'in' ? 'received_at' : 'created_at', before);
  return w;
}

/**
 * The halves a filter reads: a status is an outbox column — an inbox message has none — so asking for one narrows the list to
 * sent messages.
 * @param {{ direction?: string, status?: string }} filters
 */
const halves = ({ direction, status }) => ({ inbox: direction !== 'out' && status === undefined, outbox: direction !== 'in' });

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function messageRoutes(app, ctx) {
  app.get('/api/messages', { schema }, async (request, reply) => {
    const query = /** @type {Record<string, string | undefined>} */ (request.query ?? {});
    const p = paging(query);
    const filters = { modem: query.modem, status: query.status, q: p.q };
    const read = halves(query);

    /** @type {Array<{ select: string, w: ReturnType<typeof where> }>} */
    const parts = [];
    if (read.inbox) parts.push({ select: INBOX, w: filter('in', filters) });
    if (read.outbox) parts.push({ select: OUTBOX, w: filter('out', filters) });

    if (parts.length === 0) return reply.send(page([], p, 0));
    const union = parts.map(({ select, w }) => `${select} ${w.sql}`).join(' UNION ALL ');
    const params = parts.flatMap(({ w }) => w.params);
    const total = Number(/** @type {any} */ (ctx.db.prepare(`SELECT count(*) AS n FROM (${union})`).get(...params)).n);
    const rows = ctx.db.prepare(`SELECT ${COLUMNS} FROM (${union}) ORDER BY at DESC, direction ASC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, p.per_page, offset(p));
    return reply.send(page(rows.map((row) => ({ ...row })), p, total));
  });

  app.delete('/api/messages/in/:id', { schema: { params: byId } }, async (request, reply) => {
    const id = Number(/** @type {any} */ (request.params).id);
    const deleted = transaction(ctx.db, () => {
      const changes = Number(ctx.db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes);
      if (changes > 0) ctx.db.prepare(ORPHAN_EVENTS).run();
      return changes;
    });
    if (deleted === 0) return reply.code(404).send({ error: `no received SMS ${id}` });
    ctx.log.info('received SMS deleted', { message: id, actor: 'admin' });
    return reply.send({ deleted: id });
  });

  app.post('/api/messages/purge', { schema: messagesPurge }, async (request, reply) => {
    const body = /** @type {{ direction?: string, modem?: string, status?: string, q?: string, before?: number }} */ (request.body ?? {});
    const filters = { modem: body.modem, status: body.status, q: body.q ? body.q : null, before: body.before };
    const read = halves(body);
    const result = transaction(ctx.db, () => {
      let received = 0;
      let sent = 0;
      let kept = 0;
      if (read.inbox) {
        const w = filter('in', filters);
        received = Number(ctx.db.prepare(`DELETE FROM messages ${w.sql}`).run(...w.params).changes);
        if (received > 0) ctx.db.prepare(ORPHAN_EVENTS).run();
      }
      if (read.outbox) {
        const w = filter('out', filters);
        const matched = Number(/** @type {any} */ (ctx.db.prepare(`SELECT count(*) AS n FROM sms_outbox ${w.sql}`).get(...w.params)).n);
        w.in('status', REMOVABLE);
        sent = Number(ctx.db.prepare(`DELETE FROM sms_outbox ${w.sql}`).run(...w.params).changes);
        kept = matched - sent;
      }
      return { received, sent, kept };
    });
    if (result.received + result.sent > 0) ctx.log.info('SMS deleted', { ...result, actor: 'admin' });
    return reply.send({ deleted: result.received + result.sent, kept: result.kept });
  });
}
