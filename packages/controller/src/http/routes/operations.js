// @ts-check
// Aster controller — the operation routes: the Activity page's list and one operation by id.
// Read from the table rather than the runner, since retention keeps rows longer than the runner does.
import { byId, operations as schema } from '../schemas/history.js';
import { offset, page, paging, where } from '../page.js';
import { view } from '../ops.js';

/** Columns of a list row: the params and the result of every operation would make a page of the list very large. */
const COLUMNS = `id, kind, modem_id, status, error, actor, created_at, started_at, finished_at,
  length(COALESCE(params_json, '')) AS params_bytes, length(COALESCE(result_json, '')) AS result_bytes`;

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function operationRoutes(app, ctx) {
  app.get('/api/operations', { schema }, async (request, reply) => {
    const query = /** @type {Record<string, string | undefined>} */ (request.query ?? {});
    const p = paging(query);
    const w = where();
    w.eq('kind', query.kind);
    w.eq('modem_id', query.modem);
    w.eq('status', query.status);
    w.eq('actor', query.actor);
    w.contains(['kind', 'error'], p.q);
    const total = Number(/** @type {any} */ (ctx.db.prepare(`SELECT count(*) AS n FROM operations ${w.sql}`).get(...w.params)).n);
    const rows = ctx.db.prepare(`SELECT ${COLUMNS} FROM operations ${w.sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, p.per_page, offset(p));
    return reply.send(page(rows.map((row) => ({ ...row })), p, total));
  });

  app.get('/api/operations/:id', { schema: { params: byId } }, async (request, reply) => {
    const id = Number(/** @type {any} */ (request.params).id);
    const op = ctx.runner.get(id);
    if (!op) return reply.code(404).send({ error: `no operation ${id}` });
    return reply.send({ operation: view(op) });
  });
}
