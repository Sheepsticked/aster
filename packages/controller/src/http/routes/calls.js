// @ts-check
// Aster controller — GET /api/calls: ended calls with their outcome, newest first, filtered like the Calls page.
// GET /api/calls/summary: talk time per modem and direction. DELETE /api/calls/:id and POST /api/calls/purge delete calls
// together with their spool events.
import { transaction } from '../../store/db.js';
import { ORPHAN_CALL_EVENTS } from '../../store/orphans.js';
import { byId, calls as schema, callsPurge, callsSummary } from '../schemas/history.js';
import { offset, page, paging, where } from '../page.js';

const COLUMNS = `id, modem_id, uniqueid, direction, caller, did, dialstatus, answered_sec, dialed_sec, disposition, hangupcause, outcome,
  ended_at`;
/** Calls, answered calls and their talk time per modem and direction, of the calls that ended in [since, until). */
const SUMMARY = `SELECT modem_id, direction, count(*) AS calls, sum(outcome = 'answered') AS answered,
  coalesce(sum(CASE WHEN outcome = 'answered' THEN answered_sec END), 0) AS answered_sec
  FROM calls WHERE ended_at >= ? AND ended_at < ? GROUP BY modem_id, direction ORDER BY modem_id, direction`;

/** @param {{ modem?: string, direction?: string, outcome?: string, q: string | null, before?: number }} filters */
function filter({ modem, direction, outcome, q, before }) {
  const w = where();
  w.eq('modem_id', modem);
  w.eq('direction', direction);
  w.eq('outcome', outcome);
  w.contains(['caller', 'did'], q);
  w.atMost('ended_at', before);
  return w;
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function callRoutes(app, ctx) {
  app.get('/api/calls', { schema }, async (request, reply) => {
    const query = /** @type {Record<string, string | undefined>} */ (request.query ?? {});
    const p = paging(query);
    const w = filter({ modem: query.modem, direction: query.direction, outcome: query.outcome, q: p.q });
    const total = Number(/** @type {any} */ (ctx.db.prepare(`SELECT count(*) AS n FROM calls ${w.sql}`).get(...w.params)).n);
    const rows = ctx.db.prepare(`SELECT ${COLUMNS} FROM calls ${w.sql} ORDER BY ended_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, p.per_page, offset(p));
    return reply.send(page(rows.map((row) => ({ ...row })), p, total));
  });

  app.get('/api/calls/summary', { schema: callsSummary }, async (request, reply) => {
    const query = /** @type {{ since: string, until?: string }} */ (request.query);
    const since = Number(query.since);
    const until = query.until === undefined ? null : Number(query.until);
    const items = ctx.db.prepare(SUMMARY).all(since, until ?? Number.MAX_SAFE_INTEGER).map((row) => ({
      modem_id: row.modem_id, direction: row.direction, calls: Number(row.calls), answered: Number(row.answered), answered_sec: Number(row.answered_sec),
    }));
    return reply.send({ since, until, items });
  });

  /** Deletes the calls a WHERE selects, with their events. @param {ReturnType<typeof where>} w */
  const remove = (w) => transaction(ctx.db, () => {
    const changes = Number(ctx.db.prepare(`DELETE FROM calls ${w.sql}`).run(...w.params).changes);
    if (changes > 0) ctx.db.prepare(ORPHAN_CALL_EVENTS).run();
    return changes;
  });

  app.delete('/api/calls/:id', { schema: { params: byId } }, async (request, reply) => {
    const id = Number(/** @type {any} */ (request.params).id);
    const w = where();
    w.eq('id', id);
    if (remove(w) === 0) return reply.code(404).send({ error: `no call ${id}` });
    ctx.log.info('call deleted', { call: id, actor: 'admin' });
    return reply.send({ deleted: id });
  });

  app.post('/api/calls/purge', { schema: callsPurge }, async (request, reply) => {
    const body = /** @type {{ modem?: string, direction?: string, outcome?: string, q?: string, before?: number }} */ (request.body ?? {});
    const deleted = remove(filter({ ...body, q: body.q ? body.q : null }));
    if (deleted > 0) ctx.log.info('calls deleted', { count: deleted, actor: 'admin' });
    return reply.send({ deleted });
  });
}
