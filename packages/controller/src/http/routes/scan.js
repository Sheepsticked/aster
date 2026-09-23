// @ts-check
// Aster controller — the scan routes: POST starts the scan operation and answers 202; GET returns the last
// result, classified against the current registry so an already-assigned device is not offered.
import { start as startOp } from '../ops.js';
import { scan as scanSchema } from '../schemas/modems.js';
import { unassigned } from './overview.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function scanRoutes(app, ctx) {
  app.post('/api/scan', { schema: scanSchema }, async (request, reply) => {
    const operation = startOp(ctx, { kind: 'scan', modemId: null, params: { trigger: 'admin' }, actor: 'admin' });
    ctx.log.info('scan queued', { operation: operation.id });
    return reply.code(202).send({ operation });
  });

  app.get('/api/scan/latest', async (request, reply) => {
    const latest = ctx.scan?.latest() ?? null;
    if (latest === null) return reply.send({ scan: null });
    /** @type {import('../../config/registry.js').Registry | null} */
    let registry = null;
    try {
      registry = ctx.registry();
    } catch {
      registry = null; // an invalid registry: the devices are still worth showing, none of them claimed
    }
    return reply.send({
      scan: {
        at: latest.at,
        trigger: latest.trigger,
        errors: latest.errors,
        devices: latest.devices,
        unassigned: latest.unassigned.filter((device) => registry === null || unassigned(device, registry)),
      },
    });
  });
}
