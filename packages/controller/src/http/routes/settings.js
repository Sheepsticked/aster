// @ts-check
// Aster controller — GET and PUT /api/settings. GET never returns the token or password, only whether they exist.
// PUT checks everything first, then applies registry fields via registry-apply and writes secrets atomically.
import { RegistryError, validate } from '../../config/registry.js';
import { isToken } from '../../notify/telegram.js';
import { checkPassword, HASH_KEY, hashPassword, verifyPassword } from '../auth.js';
import { applyRegistry } from '../ops.js';
import { update as updateSchema } from '../schemas/settings.js';

/** The secrets.env key of the Telegram bot token. */
export const TOKEN_KEY = 'TELEGRAM_BOT_TOKEN';
/** How long PUT waits for its registry-apply before answering 202 with the operation. */
export const DEFAULTS = Object.freeze(/** @type {Readonly<{ applyWaitMs: number }>} */ ({ applyWaitMs: 20_000 }));

/** @typedef {import('../../config/registry.js').Registry} Registry */
/**
 * @typedef {object} SettingsUpdate
 * @property {'ru' | 'en'} [ui_language]
 * @property {string} [timezone]
 * @property {{ operations?: number, notifications?: number, messages?: number, calls?: number }} [retention_days]
 * @property {string[]} [default_recipients]
 * @property {boolean} [alerts]
 * @property {string | null} [telegram_token]
 * @property {{ current: string, next: string }} [password]
 * @property {boolean} [force]
 */

/**
 * What GET answers and what PUT returns after it has changed something.
 * @param {{ registry: Registry, hash: string | null, present: boolean }} current
 * @param {Readonly<Record<string, string>>} secrets
 */
function view({ registry, hash, present }, secrets) {
  return {
    ui_language: registry.settings.ui_language,
    timezone: registry.settings.timezone,
    retention_days: { ...registry.settings.retention_days },
    default_recipients: [...registry.telegram.default_recipients],
    alerts: registry.telegram.alerts,
    telegram_token_set: isToken(secrets[TOKEN_KEY]),
    password_set: typeof secrets[HASH_KEY] === 'string' && secrets[HASH_KEY] !== '',
    registry: { present, hash },
  };
}

/** The fields a PUT can change, as they are compared to decide whether the registry has to be applied at all. */
const fields = (/** @type {Registry} */ registry) => JSON.stringify([registry.settings.ui_language, registry.settings.timezone,
  registry.settings.retention_days, registry.telegram.default_recipients, registry.telegram.alerts]);

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function settingsRoutes(app, ctx) {
  const { sessions, secrets, log } = ctx;
  const applyWaitMs = ctx.timing.applyWaitMs ?? DEFAULTS.applyWaitMs;
  const currentRegistry = () => ctx.registryFile();

  /** @param {unknown} err @param {import('fastify').FastifyReply} reply */
  function registryProblem(err, reply) {
    if (!(err instanceof RegistryError)) throw err;
    return reply.code(409).send({ error: `config/aster.yaml is invalid, so the settings cannot be changed: ${err.errors.length} problem(s)`, problems: err.errors });
  }

  app.get('/api/settings', async (request, reply) => {
    try {
      return view(currentRegistry(), secrets.get());
    } catch (err) {
      return registryProblem(err, reply);
    }
  });

  app.put('/api/settings', { schema: updateSchema }, async (request, reply) => {
    const body = /** @type {SettingsUpdate} */ (request.body);
    /** @type {{ registry: Registry, hash: string | null, present: boolean }} */
    let current;
    try {
      current = currentRegistry();
    } catch (err) {
      return registryProblem(err, reply);
    }

    // 1. Everything is checked before anything is written.
    const settings = { ...current.registry.settings, retention_days: { ...current.registry.settings.retention_days } };
    const telegram = { ...current.registry.telegram, default_recipients: [...current.registry.telegram.default_recipients] };
    if (body.ui_language !== undefined) settings.ui_language = body.ui_language;
    if (body.timezone !== undefined) settings.timezone = body.timezone;
    if (body.retention_days !== undefined) Object.assign(settings.retention_days, body.retention_days);
    if (body.default_recipients !== undefined) telegram.default_recipients = [...body.default_recipients];
    if (body.alerts !== undefined) telegram.alerts = body.alerts;
    /** @type {Registry} */
    let next;
    try {
      next = validate({ ...current.registry, settings, telegram });
    } catch (err) {
      if (err instanceof RegistryError) return reply.code(400).send({ error: `the settings are invalid: ${err.errors.length} problem(s)`, problems: err.errors });
      throw err;
    }

    if (body.telegram_token !== undefined && body.telegram_token !== null && !isToken(body.telegram_token)) {
      return reply.code(400).send({ error: 'telegram_token must be a bot token (<digits>:<letters, digits, _ and ->) or null to clear it' });
    }
    if (body.password) {
      const stored = secrets.get()[HASH_KEY];
      if (stored === undefined || stored === '') return reply.code(503).send({ error: `no admin password is set (${HASH_KEY} of config/secrets.env; bin/passwd.js sets it)` });
      let ok = false;
      try {
        ok = await verifyPassword(body.password.current, stored);
      } catch (err) {
        log.error('the stored admin password hash cannot be read', { key: HASH_KEY, err });
        return reply.code(503).send({ error: `${HASH_KEY} of config/secrets.env is not a usable scrypt hash; set the password again with bin/passwd.js` });
      }
      if (!ok) {
        log.warn('a password change was refused: the current password is wrong', { ip: request.ip });
        return reply.code(401).send({ error: 'the current password is wrong' });
      }
      const problem = checkPassword(body.password.next);
      if (problem) return reply.code(400).send({ error: problem });
    }

    /** @type {string[]} */
    const changed = [];
    for (const key of /** @type {const} */ (['ui_language', 'timezone', 'retention_days', 'default_recipients', 'alerts'])) {
      if (body[key] !== undefined) changed.push(key);
    }

    // 2. The registry first: it is the only change that can fail for a reason outside the controller (a reload, Asterisk).
    /** @type {import('../ops.js').Started | null} */
    let operation = null;
    if (fields(next) !== fields(current.registry) || (changed.length > 0 && !current.present)) {
      const applied = await applyRegistry(ctx, { registry: next, baseHash: current.hash, force: body.force === true, waitMs: applyWaitMs });
      if (!applied.ok) {
        return reply.code(applied.code).send({ ok: false, error: applied.error, result: applied.result, changed: [], operation: applied.operation, sessions_cleared: 0 });
      }
      operation = applied.operation;
    } else {
      changed.length = 0; // the values are already what the request asks for
    }

    // 3. Then the secrets: one atomic rewrite for both, so a token and a password change cannot half-apply.
    /** @type {Record<string, string | null>} */
    const patch = {};
    if (body.telegram_token !== undefined) patch[TOKEN_KEY] = body.telegram_token;
    if (body.password) patch[HASH_KEY] = await hashPassword(body.password.next);
    if (Object.keys(patch).length > 0) {
      try {
        secrets.set(patch);
      } catch (err) {
        log.error('config/secrets.env could not be written', { keys: Object.keys(patch), err });
        return reply.code(500).send({
          ok: false,
          error: `config/secrets.env could not be written: ${err instanceof Error ? err.message : String(err)}`,
          changed,
          operation,
          sessions_cleared: 0,
        });
      }
      if (body.telegram_token !== undefined) changed.push('telegram_token');
    }

    // 4. A new password ends every session, the caller's included (its cookie is expired here so the browser drops it).
    let cleared = 0;
    if (body.password) {
      cleared = sessions.clear();
      changed.push('password');
      reply.header('set-cookie', sessions.expiredCookie());
      log.info('the admin password was changed; every session was ended', { sessions_cleared: cleared, ip: request.ip });
    }
    if (changed.length > 0) log.info('settings changed', { changed, operation: operation?.id ?? null });
    return reply.send({ ok: true, changed, operation, sessions_cleared: cleared, settings: view(currentRegistry(), secrets.get()) });
  });
}
