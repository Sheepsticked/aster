// @ts-check
// Aster controller — GET /api/notifications (the Activity page's queue list) and POST /api/notify/test,
// which enqueues a test notification and is refused while no usable bot token is configured.
import { NotifyError } from '../../notify/queue.js';
import { notifications as schema, notifyTest } from '../schemas/history.js';
import { offset, page, paging, where } from '../page.js';

const COLUMNS = `id, source_kind, source_id, chat_id, part_no, part_count, text, status, attempts, next_at, tg_message_id, error,
  created_at, sent_at`;

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function notificationRoutes(app, ctx) {
  app.get('/api/notifications', { schema }, async (request, reply) => {
    const query = /** @type {Record<string, string | undefined>} */ (request.query ?? {});
    const p = paging(query);
    const w = where();
    w.eq('status', query.status);
    w.eq('source_kind', query.kind);
    w.eq('chat_id', query.chat_id);
    w.contains(['text', 'error'], p.q);
    const total = Number(/** @type {any} */ (ctx.db.prepare(`SELECT count(*) AS n FROM notifications ${w.sql}`).get(...w.params)).n);
    const rows = ctx.db.prepare(`SELECT ${COLUMNS} FROM notifications ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, p.per_page, offset(p));
    return reply.send(page(rows.map((row) => ({ ...row })), p, total));
  });

  app.post('/api/notify/test', { schema: notifyTest }, async (request, reply) => {
    if (!ctx.notify) return reply.code(503).send({ error: 'the notification queue is not running in this controller' });
    const chatId = /** @type {{ chat_id: string }} */ (request.body).chat_id;
    try {
      const id = ctx.notify.enqueueTest(chatId);
      ctx.log.info('test notification queued', { notification: id, chat_id: chatId });
      return reply.code(202).send({ id, chat_id: chatId });
    } catch (err) {
      if (!(err instanceof NotifyError)) throw err;
      return reply.code(400).send({ error: err.message });
    }
  });
}
