// @ts-check
// Aster controller — GET /api/connections: who is connected to each phone and its calls, live from Asterisk. Without
// Asterisk the answer says so (`available: false`) instead of failing.
import { readConnections } from '../../sip/connections.js';

/** Live state is not worth the AMI default of 10 s. */
const TIMEOUT_MS = 5_000;

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function connectionRoutes(app, ctx) {
  app.get('/api/connections', async (request, reply) => {
    const { ami } = ctx;
    if (!ami?.connected) {
      return reply.send({ available: false, error: ami ? `Asterisk is not answering (AMI ${ami.state})` : 'AMI is not configured', phones: [] });
    }
    try {
      return reply.send({ available: true, error: null, phones: await readConnections(ami, ctx.now(), { timeout: TIMEOUT_MS }) });
    } catch (err) {
      ctx.log.debug('connections could not be read', { err });
      return reply.send({ available: false, error: err instanceof Error ? err.message : String(err), phones: [] });
    }
  });
}
