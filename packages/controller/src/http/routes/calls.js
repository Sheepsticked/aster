// @ts-check
// Aster controller — GET /api/calls: ended calls with their outcome, newest first, filtered like the Calls page.
// DELETE /api/calls/:id and POST /api/calls/purge delete calls together with their spool events.
import { transaction } from '../../store/db.js';
import { byId, calls as schema, callsPurge } from '../schemas/history.js';
import { offset, page, paging, where } from '../page.js';

const COLUMNS = `id, modem_id, uniqueid, caller, did, dialstatus, answered_sec, dialed_sec, disposition, hangupcause, outcome, ended_at`;
/** Every call-end event's uniqueid has a calls row until that row is deleted (a repeated call-end adds none). */
const ORPHAN_EVENTS = "DELETE FROM events WHERE kind = 'call-end' AND uniqueid NOT IN (SELECT uniqueid FROM calls)";

/** @param {{ modem?: string, outcome?: string, q: string | null, before?: number }} filters */
function filter({ modem, outcome, q, before }) {
  const w = where();
  w.eq('modem_id', modem);
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
    const w = filter({ modem: query.modem, outcome: query.outcome, q: p.q });
    const total = Number(/** @type {any} */ (ctx.db.prepare(`SELECT count(*) AS n FROM calls ${w.sql}`).get(...w.params)).n);
    const rows = ctx.db.prepare(`SELECT ${COLUMNS} FROM calls ${w.sql} ORDER BY ended_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, p.per_page, offset(p));
    return reply.send(page(rows.map((row) => ({ ...row })), p, total));
  });

  /** Deletes the calls a WHERE selects, with their events. @param {ReturnType<typeof where>} w */
  const remove = (w) => transaction(ctx.db, () => {
    const changes = Number(ctx.db.prepare(`DELETE FROM calls ${w.sql}`).run(...w.params).changes);
    if (changes > 0) ctx.db.prepare(ORPHAN_EVENTS).run();
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
    const body = /** @type {{ modem?: string, outcome?: string, q?: string, before?: number }} */ (request.body ?? {});
    const deleted = remove(filter({ ...body, q: body.q ? body.q : null }));
    if (deleted > 0) ctx.log.info('calls deleted', { count: deleted, actor: 'admin' });
    return reply.send({ deleted });
  });
}
