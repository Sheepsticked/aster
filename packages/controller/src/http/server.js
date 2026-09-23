// @ts-check
// Aster controller — the HTTP server: Fastify with a session gate in front of /api (except the public routes),
// and the built SPA from packages/ui/dist for everything else, with an index.html fallback and no path escaping its root.
import { createReadStream, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, sep } from 'node:path';
import Fastify from 'fastify';
import { load as loadRegistry, RegistryError, validate as validateRegistry } from '../config/registry.js';
import { registerSearch } from './page.js';
import { createSessions, cookieSessionId } from './session.js';
import { createSse } from './sse.js';
import { authRoutes } from './routes/auth.js';
import { backupRoutes } from './routes/backup.js';
import { callRoutes } from './routes/calls.js';
import { configRoutes } from './routes/config.js';
import { connectionRoutes } from './routes/connections.js';
import { createHealth, healthRoutes } from './routes/health.js';
import { logRoutes } from './routes/logs.js';
import { messageRoutes } from './routes/messages.js';
import { modemRoutes } from './routes/modems.js';
import { notificationRoutes } from './routes/notifications.js';
import { operationRoutes } from './routes/operations.js';
import { overviewRoutes } from './routes/overview.js';
import { phoneRoutes } from './routes/phones.js';
import { scanRoutes } from './routes/scan.js';
import { settingsRoutes } from './routes/settings.js';
import { smsRoutes } from './routes/sms.js';

export const BODY_LIMIT = 1024 * 1024;
/** The /api routes that do not need a session. */
export const PUBLIC = Object.freeze(['/api/health', '/api/login', '/api/logout']);
export const DEFAULTS = Object.freeze(/** @type {Readonly<{ shutdownMs: number }>} */ ({ shutdownMs: 5_000 }));
/** Content types of what a Vite build emits; anything else is served as a byte stream. */
const TYPES = Object.freeze(/** @type {Readonly<Record<string, string>>} */ ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
}));
const VERSION = process.env.ASTER_VERSION || String(createRequire(import.meta.url)('../../package.json').version);

/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('./session.js').Session} Session */
/**
 * @typedef {object} Ctx  what every route needs; built here and passed to each routes() function
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {import('../bus.js').Bus} bus
 * @property {ReturnType<typeof import('../ops/runner.js').createRunner>} runner
 * @property {() => import('../config/registry.js').Registry | null} registry
 * @property {ReturnType<typeof createSessions>} sessions
 * @property {import('../env.js').SecretsStore} secrets
 * @property {ReturnType<typeof createHealth>} health
 * @property {ReturnType<typeof createSse>} sse
 * @property {ReturnType<typeof import('../devices/state.js').createDeviceState> | null} devices
 * @property {ReturnType<typeof import('../devices/scan.js').createScanOps> | null} scan
 * @property {ReturnType<typeof import('../sms/outbox.js').createOutbox> | null} outbox
 * @property {ReturnType<typeof import('../notify/queue.js').createNotifyQueue> | null} notify
 * @property {import('../logs/ring.js').Ring | null} logRing
 * @property {import('../ami/client.js').AmiClient | null} ami
 * @property {Paths} paths
 * @property {Logger} log
 * @property {() => number} now
 * @property {(request: import('fastify').FastifyRequest) => Session | null} sessionOf
 * @property {() => { registry: import('../config/registry.js').Registry, hash: string | null, present: boolean }} registryFile
 *   the registry on disk with the hash a change must carry as its base; it throws RegistryError for a file that does not parse
 * @property {Readonly<Record<string, number>>} timing
 */
/**
 * @typedef {object} Paths  ASTER_HOME and what the routes read under it (src/env.js writes the same names)
 * @property {string} home
 * @property {string} spool
 * @property {string} state
 * @property {string} registry        config/aster.yaml
 * @property {string} asteriskConfig  config/asterisk
 * @property {string} prev            state/prev
 * @property {string} asteriskLog     logs/asterisk/full
 */

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * The path of a request without its query string, percent-decoded; null when the encoding is broken.
 * @param {string} url
 */
function pathOf(url) {
  const raw = url.split('?')[0] ?? '/';
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * `path` resolved under `root`, or null when it would leave it (`..`, an absolute path, a symlinked-in name).
 * @param {string} root  already resolved
 * @param {string} path  a URL path such as /assets/app.js
 */
export function resolveUnder(root, path) {
  if (path.includes('\0')) return null;
  const file = resolve(root, `.${normalize(path.startsWith('/') ? path : `/${path}`)}`);
  return file === root || file.startsWith(root + sep) ? file : null;
}

/** What the device modules and the settings route see before install.sh has written config/aster.yaml: no modems, no phones. */
const EMPTY_REGISTRY = { version: /** @type {const} */ (1), modems: [], phones: [] };

/**
 * @param {Omit<Ctx, 'sessions' | 'health' | 'sse' | 'sessionOf' | 'registryFile' | 'log' | 'now' | 'timing' | 'paths'
 *   | 'outbox' | 'notify' | 'logRing'> & {
 *   paths: Partial<Paths> & { registry: string, state: string, spool: string },
 *   outbox?: Ctx['outbox'], notify?: Ctx['notify'], logRing?: Ctx['logRing'],
 *   log?: Logger, now?: () => number, uiDir?: string | null, host?: string, port?: number, startedAt?: number,
 *   version?: string, timing?: Record<string, number>, thresholds?: Partial<typeof import('./routes/health.js').THRESHOLDS>,
 * }} options
 */
export function createServer(options) {
  const { db, bus, runner, registry, secrets, devices = null, scan = null, outbox = null, notify = null, logRing = null, ami = null } = options;
  const log = options.log ?? SILENT;
  const now = options.now ?? Date.now;
  const timing = Object.freeze({ ...options.timing });
  const uiDir = options.uiDir ? resolve(options.uiDir) : null;
  const home = options.paths.home ?? resolve(options.paths.state, '..');
  /** @type {Paths} */
  const paths = {
    home,
    state: options.paths.state,
    spool: options.paths.spool,
    registry: options.paths.registry,
    asteriskConfig: options.paths.asteriskConfig ?? join(home, 'config', 'asterisk'),
    prev: options.paths.prev ?? join(options.paths.state, 'prev'),
    asteriskLog: options.paths.asteriskLog ?? join(home, 'logs', 'asterisk', 'full'),
  };
  // The `q` of the list routes is matched by this function, because SQLite's own lower() folds ASCII only (http/page.js).
  registerSearch(db);
  /** @type {WeakMap<import('fastify').FastifyRequest, Session>} */
  const ofRequest = new WeakMap();
  const sessions = createSessions({ db, now, timing });
  const sse = createSse({ bus, log: log.child({ module: 'sse' }), timing });
  const health = createHealth({
    db, ami, paths, log, now, timing,
    thresholds: options.thresholds ?? {},
    version: options.version ?? VERSION,
    startedAt: options.startedAt ?? now(),
  });
  /** @type {Ctx} */
  const ctx = { db, bus, runner, registry, sessions, secrets, health, sse, devices, scan, outbox, notify, logRing, ami, paths, log, now, timing,
    sessionOf: (request) => ofRequest.get(request) ?? null,
    registryFile() {
      try {
        const { registry: current, hash } = loadRegistry(paths.registry);
        return { registry: current, hash, present: true };
      } catch (err) {
        // Not written yet (before install.sh): the empty registry, which a change then creates. Anything else is the caller's 409.
        if (err instanceof Error && !(err instanceof RegistryError) && err.message.startsWith('registry not found')) {
          return { registry: validateRegistry(EMPTY_REGISTRY), hash: null, present: false };
        }
        throw err;
      }
    } };

  // Validation is strict on purpose: Fastify's defaults drop unknown fields and coerce types, which would let a misspelled
  // settings field look accepted while nothing changed. Here an unknown or mistyped field is a 400 that names it.
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT, routerOptions: { ignoreTrailingSlash: true },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });

  // A body is JSON or nothing: a POST without one (logout) is allowed, any other content type is refused before a handler runs.
  // Fastify's own text/plain parser would otherwise hand a route a string body, which its schema then rejects as a 400.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    const err = /** @type {Error & { statusCode?: number }} */ (new Error(`the request body must be application/json, not ${request.headers['content-type'] ?? 'an unnamed type'}`));
    err.statusCode = 415;
    done(err, undefined);
  });

  // A request with no body is an empty object, so a client need not send `{}` to an action that takes no fields.
  app.addHook('preValidation', async (request) => {
    if (request.body === undefined && request.method !== 'GET' && request.method !== 'HEAD') request.body = {};
  });

  const publicPaths = new Set(PUBLIC);
  app.addHook('onRequest', async (request, reply) => {
    // Refuse absolute-form targets: the router strips scheme and host, so this gate would otherwise judge a different path.
    if (!request.url.startsWith('/')) return reply.code(400).send({ error: 'absolute-form request targets are not accepted' });
    const path = pathOf(request.url);
    if (path === null) return reply.code(400).send({ error: 'the request path is not valid percent-encoded UTF-8' });
    const api = path === '/api' || path.startsWith('/api/');
    if (!api) return undefined;
    if (publicPaths.has(path.replace(/\/+$/, '') || '/')) {
      // A public route may still see the admin's session; a read-only lookup without touch(), so polling causes no writes.
      const session = sessions.get(cookieSessionId(request.headers.cookie));
      if (session) ofRequest.set(request, session);
      return undefined;
    }
    const sent = cookieSessionId(request.headers.cookie);
    const session = sessions.get(sent);
    if (!session) {
      if (sent !== null) reply.header('set-cookie', sessions.expiredCookie());
      return reply.code(401).send({ error: 'not logged in' });
    }
    sessions.touch(session);
    ofRequest.set(request, session);
    return undefined;
  });

  // 503 is an answer the controller gives on purpose (no UI in this build, no admin password, an apply that needs AMI), and the
  // route that decides it logs its own reason; only a real failure is an error line.
  app.addHook('onResponse', async (request, reply) => {
    const fields = { method: request.method, url: request.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) };
    if (reply.statusCode >= 500 && reply.statusCode !== 503) log.error('request failed', fields);
    else if (reply.statusCode >= 500) log.warn('request refused', fields);
    else if (reply.statusCode >= 400) log.info('request refused', fields);
    else log.debug('request', fields);
  });

  app.setErrorHandler(/** @param {import('fastify').FastifyError} err */ (err, request, reply) => {
    const status = err.validation ? 400 : (err.statusCode ?? 500);
    if (status >= 500) log.error('a request handler failed', { method: request.method, url: request.url, err });
    const message = err.validation ? `invalid request: ${err.message}` : err.message;
    void reply.code(status).send({ error: status >= 500 ? `the controller failed to answer: ${message}` : message });
  });

  authRoutes(app, ctx);
  healthRoutes(app, ctx);
  overviewRoutes(app, ctx);
  settingsRoutes(app, ctx);
  modemRoutes(app, ctx);
  phoneRoutes(app, ctx);
  connectionRoutes(app, ctx);
  scanRoutes(app, ctx);
  messageRoutes(app, ctx);
  smsRoutes(app, ctx);
  callRoutes(app, ctx);
  notificationRoutes(app, ctx);
  configRoutes(app, ctx);
  operationRoutes(app, ctx);
  logRoutes(app, ctx);
  backupRoutes(app, ctx);
  app.get('/api/events', (request, reply) => sse.handler(request, reply));

  // Everything that matched no route: an unknown /api endpoint is a 404 in JSON, anything else is the SPA.
  app.setNotFoundHandler((request, reply) => {
    const path = pathOf(request.url);
    if (path === null) return reply.code(400).send({ error: 'the request path is not valid percent-encoded UTF-8' });
    if (path === '/api' || path.startsWith('/api/')) return reply.code(404).send({ error: `unknown endpoint: ${request.method} ${path}` });
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send({ error: `unknown endpoint: ${request.method} ${path}` });
    return sendUi(reply, path);
  });

  /**
   * The built SPA: the file itself when it exists, else index.html (the app routes on the client).
   * @param {import('fastify').FastifyReply} reply
   * @param {string} path
   */
  function sendUi(reply, path) {
    if (uiDir === null) {
      return reply.code(503).send({ error: 'the web UI is not part of this build; the JSON API under /api is available' });
    }
    const file = resolveUnder(uiDir, path);
    const found = file !== null && isFile(file) ? file : join(uiDir, 'index.html');
    if (!isFile(found)) return reply.code(503).send({ error: `the web UI directory has no index.html (${uiDir})` });
    const ext = extname(found).toLowerCase();
    return reply
      .type(TYPES[ext] ?? 'application/octet-stream')
      .header('cache-control', found.endsWith('index.html') ? 'no-store' : 'public, max-age=3600')
      .send(createReadStream(found));
  }

  return {
    app,
    ctx,
    sessions,
    sse,
    health,
    /** For tests and logs: the address once listen() has run. */
    get address() {
      return app.server.address();
    },
    /** Binds the port; returns the address text Fastify reports (which says 127.0.0.1 for a wildcard bind). */
    async listen() {
      const host = options.host ?? '0.0.0.0';
      const port = options.port ?? 80;
      const address = await app.listen({ host, port });
      if (uiDir === null || !isFile(join(uiDir, 'index.html'))) log.warn('no web UI in this build: only the JSON API under /api is served', { ui_dir: uiDir });
      log.info('http listening', { address, bound: `${host}:${port}`, ui: uiDir });
      return address;
    },
    /** Ends the event streams (they would hold the server open), then closes it. */
    async close() {
      sse.stop();
      await app.close();
    },
  };
}

/** @param {string} path */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
