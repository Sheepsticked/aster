// @ts-check
// Aster controller — POST /api/login, POST /api/logout, GET /api/me for the one admin password.
// No rate limiting on purpose: a wrong password is a 401 and a logged warning; an unreadable hash is a 503.
import { HASH_KEY, verifyPassword } from '../auth.js';
import { login as loginSchema } from '../schemas/auth.js';
import { cookieSessionId } from '../session.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function authRoutes(app, ctx) {
  const { sessions, secrets, log } = ctx;

  app.post('/api/login', { schema: loginSchema }, async (request, reply) => {
    const { password } = /** @type {{ password: string }} */ (request.body);
    const hash = secrets.get()[HASH_KEY];
    if (hash === undefined || hash === '') {
      log.error('a login was attempted before an admin password was set', { secrets: secrets.path, key: HASH_KEY });
      return reply.code(503).send({ error: `no admin password is set (${HASH_KEY} of config/secrets.env; bin/passwd.js sets it)` });
    }
    let ok = false;
    try {
      ok = await verifyPassword(password, hash);
    } catch (err) {
      log.error('the stored admin password hash cannot be read', { key: HASH_KEY, err });
      return reply.code(503).send({ error: `${HASH_KEY} of config/secrets.env is not a usable scrypt hash; set the password again with bin/passwd.js` });
    }
    if (!ok) {
      log.warn('wrong password', { ip: request.ip });
      return reply.code(401).send({ error: 'wrong password' });
    }
    const session = sessions.create();
    log.info('logged in', { ip: request.ip, sessions: sessions.count() });
    return reply.header('set-cookie', sessions.cookie(session.id)).send({ ok: true, session: publicSession(session, sessions.maxAgeMs) });
  });

  app.post('/api/logout', async (request, reply) => {
    const id = cookieSessionId(request.headers.cookie);
    const existed = id === null ? false : sessions.destroy(id);
    if (existed) log.info('logged out', { ip: request.ip, sessions: sessions.count() });
    return reply.header('set-cookie', sessions.expiredCookie()).send({ ok: true });
  });

  app.get('/api/me', async (request, reply) => {
    const session = ctx.sessionOf(request);
    if (!session) return reply.code(401).send({ error: 'not logged in' });
    return { authenticated: true, session: publicSession(session, sessions.maxAgeMs) };
  });
}

/**
 * What a session looks like to the client: no id (the cookie has it, and a response body reaches scripts the cookie does not).
 * @param {import('../session.js').Session} session
 * @param {number} maxAgeMs
 */
const publicSession = (session, maxAgeMs) => ({
  created_at: session.created_at,
  last_seen_at: session.last_seen_at,
  expires_at: session.created_at + maxAgeMs,
});
