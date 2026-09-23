// @ts-check
// Aster controller — the outbound SMS routes: send (202 with ids), retry (`confirm` needed if it may have arrived),
// delete and purge. OutboxError codes map to HTTP statuses only here.
import { OutboxError } from '../../sms/outbox.js';
import { byId, purge as purgeSchema, retry as retrySchema, send as sendSchema } from '../schemas/history.js';

/** An OutboxError code → the status that says the same thing over HTTP. */
const STATUS = Object.freeze(/** @type {Readonly<Record<string, number>>} */ ({
  invalid: 400, 'not-found': 404, 'confirm-required': 409, 'not-retryable': 409, 'not-removable': 409, unavailable: 503,
}));

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function smsRoutes(app, ctx) {
  /** @param {import('fastify').FastifyReply} reply */
  const noOutbox = (reply) => reply.code(503).send({ error: 'the outbox is not running in this controller' });

  /** @param {unknown} err @param {import('fastify').FastifyReply} reply */
  function refused(err, reply) {
    if (!(err instanceof OutboxError)) throw err;
    return reply.code(STATUS[err.code] ?? 400).send({ error: err.message, code: err.code });
  }

  app.post('/api/sms', { schema: sendSchema }, async (request, reply) => {
    if (!ctx.outbox) return noOutbox(reply);
    const body = /** @type {{ modem_id: string, number: string, text: string }} */ (request.body);
    try {
      const queued = ctx.outbox.send({ modemId: body.modem_id, number: body.number, text: body.text, actor: 'admin' });
      ctx.log.info('SMS accepted', { outbox: queued.id, modem: body.modem_id, operation: queued.operationId });
      return reply.code(202).send({ id: queued.id, attempt_no: queued.attemptNo, operation: { id: queued.operationId, kind: 'sms-send', status: ctx.runner.get(queued.operationId)?.status ?? 'queued' } });
    } catch (err) {
      return refused(err, reply);
    }
  });

  app.post('/api/sms/:id/retry', { schema: retrySchema }, async (request, reply) => {
    if (!ctx.outbox) return noOutbox(reply);
    const id = Number(/** @type {any} */ (request.params).id);
    const confirm = /** @type {any} */ (request.body)?.confirm === true;
    try {
      const queued = ctx.outbox.retry(id, { confirm, actor: 'admin' });
      ctx.log.info('SMS retry accepted', { outbox: id, attempt: queued.attemptNo, operation: queued.operationId });
      return reply.code(202).send({ id: queued.id, attempt_no: queued.attemptNo, operation: { id: queued.operationId, kind: 'sms-send', status: ctx.runner.get(queued.operationId)?.status ?? 'queued' } });
    } catch (err) {
      return refused(err, reply);
    }
  });

  app.delete('/api/sms/:id', { schema: { params: byId } }, async (request, reply) => {
    if (!ctx.outbox) return noOutbox(reply);
    const id = Number(/** @type {any} */ (request.params).id);
    try {
      const removed = ctx.outbox.remove(id, { actor: 'admin' });
      return reply.send({ deleted: removed.id, status: removed.status });
    } catch (err) {
      return refused(err, reply);
    }
  });

  app.post('/api/sms/purge', { schema: purgeSchema }, async (request, reply) => {
    if (!ctx.outbox) return noOutbox(reply);
    const modemId = /** @type {{ modem_id?: string } | undefined} */ (request.body)?.modem_id;
    try {
      return reply.send(ctx.outbox.purge({ modemId, actor: 'admin' }));
    } catch (err) {
      return refused(err, reply);
    }
  });

  // Beyond the documented routes: one SMS with its attempts, which is what the retry dialog and the Activity page show for a failed send.
  app.get('/api/sms/:id', { schema: { params: byId } }, async (request, reply) => {
    if (!ctx.outbox) return noOutbox(reply);
    const row = ctx.outbox.get(Number(/** @type {any} */ (request.params).id));
    if (!row) return reply.code(404).send({ error: `no outbox SMS ${/** @type {any} */ (request.params).id}` });
    return reply.send({ sms: row });
  });
}
