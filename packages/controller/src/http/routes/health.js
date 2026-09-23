// @ts-check
// Aster controller — GET /api/health, outside the session gate so install.sh and the healthcheck can wait for it.
// Answers `ok` or `degraded` with reasons; probes are cached so polling stays cheap, and nothing here throws.
import { readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { schemaVersion } from '../../store/db.js';

/** The modules the generated dialplan and the drivers need; the image's smoke test checks the same list. */
export const REQUIRED_MODULES = Object.freeze(['chan_pjsip.so', 'chan_quectel.so', 'chan_dongle.so', 'pbx_config.so', 'app_dial.so',
  'app_system.so', 'app_stack.so', 'app_exec.so', 'app_verbose.so', 'func_base64.so', 'func_callerid.so', 'func_cdr.so',
  'func_channel.so', 'res_musiconhold.so', 'res_clioriginate.so']);
/** When a number becomes a reason. */
export const THRESHOLDS = Object.freeze(/** @type {Readonly<{ spoolBacklog: number, diskFreeMb: number }>} */ ({ spoolBacklog: 100, diskFreeMb: 500 }));
/** How far back a failure still counts as news for the strip; an SMS that failed last week is history, not a thing to act on. */
export const RECENT_MS = 24 * 60 * 60 * 1000;
export const DEFAULTS = Object.freeze(/** @type {Readonly<{ probeMs: number, filesMs: number, actionTimeoutMs: number }>} */ ({
  probeMs: 60_000,        // `module show` / `core show version` are cached this long
  filesMs: 2_000,         // the spool count and the disk reading are cached this long
  actionTimeoutMs: 10_000,
}));

/** @typedef {import('../../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../../log.js').Logger} Logger */
/** @typedef {{ status: 'ok' | 'degraded', reasons: string[] }} Summary */

// `module show` prints name, description, use count, status, support level. The status column is the last "Running" of the line
// (greedy prefix), and the lookbehind is what separates it from "Not Running", which contains the same word.
const MODULE_LINE = /^([A-Za-z0-9_]+\.so)\s+.*\s(?<!Not )Running\b/;
/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * The modules `module show` reports as Running.
 * @param {readonly string[]} lines
 * @returns {Set<string>}
 */
export function runningModules(lines) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const line of lines) {
    const match = MODULE_LINE.exec(line);
    if (match?.[1]) out.add(match[1]);
  }
  return out;
}

/**
 * Remembers the result of `fn` for `ms`; one call at a time, and a failure is not cached.
 * @template T
 * @param {number} ms
 * @param {(now: number) => Promise<T>} fn
 */
function cached(ms, fn) {
  /** @type {{ at: number, value: T } | null} */
  let last = null;
  /** @type {Promise<T> | null} */
  let inFlight = null;
  /** @param {number} at */
  return (at) => {
    if (last && at - last.at < ms) return Promise.resolve(last.value);
    if (inFlight) return inFlight;
    inFlight = fn(at)
      .then((value) => {
        last = { at, value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {AmiClient | null} options.ami
 * @param {{ spool: string, state: string }} options.paths
 * @param {string} options.version   the controller's version (package.json / ASTER_VERSION)
 * @param {number} options.startedAt
 * @param {Logger} [options.log]
 * @param {() => number} [options.now]
 * @param {Partial<typeof DEFAULTS>} [options.timing]
 * @param {Partial<typeof THRESHOLDS>} [options.thresholds]  an appliance with a smaller disk, and the tests
 */
export function createHealth({ db, ami, paths, version, startedAt, log = SILENT, now = Date.now, timing = {}, thresholds = {} }) {
  const t = { ...DEFAULTS, ...timing };
  const limit = { ...THRESHOLDS, ...thresholds };

  /** `module show` and `core show version` in one probe; null while AMI is not up. */
  const probe = cached(t.probeMs, async () => {
    if (!ami?.connected) return null;
    try {
      const [modules, versions] = await Promise.all([
        ami.command('module show', { timeout: t.actionTimeoutMs }),
        ami.command('core show version', { timeout: t.actionTimeoutMs }),
      ]);
      const running = runningModules(modules);
      const first = versions.find((line) => line.startsWith('Asterisk ')) ?? null;
      return {
        missing: REQUIRED_MODULES.filter((name) => !running.has(name)),
        asterisk: first === null ? null : (/^Asterisk (\S+)/.exec(first)?.[1] ?? null),
        error: /** @type {string | null} */ (null),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn('the Asterisk probe of /api/health failed', { err });
      return { missing: /** @type {string[]} */ ([]), asterisk: /** @type {string | null} */ (null), error };
    }
  });

  /** The spool backlog and the free space of the state filesystem. */
  const files = cached(t.filesMs, async () => ({
    backlog: count(join(paths.spool, 'events'), (name) => !name.endsWith('.tmp')),
    quarantine: count(join(paths.spool, 'quarantine'), (name) => name.endsWith('.evt')),
    diskFreeMb: freeMb(paths.state),
  }));

  /**
   * @param {string} dir
   * @param {(name: string) => boolean} keep
   * @returns {number | null} null when the directory cannot be read
   */
  function count(dir, keep) {
    try {
      return readdirSync(dir).filter(keep).length;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') log.warn('a spool directory cannot be read', { dir, err });
      return null;
    }
  }

  /** @param {string} path @returns {number | null} */
  function freeMb(path) {
    try {
      const { bsize, bavail } = statfsSync(path);
      return Math.floor((Number(bsize) * Number(bavail)) / (1024 * 1024));
    } catch (err) {
      log.warn('the free disk space cannot be read', { path, err });
      return null;
    }
  }

  return {
    /**
     * The health of the controller now.
     * @returns {Promise<Summary & Record<string, unknown>>}
     */
    async check() {
      const at = now();
      /** @type {string[]} */
      const reasons = [];

      /** @type {{ ok: boolean, schema_version: number | null, error: string | null }} */
      const database = { ok: true, schema_version: null, error: null };
      try {
        database.schema_version = schemaVersion(db);
      } catch (err) {
        database.ok = false;
        database.error = err instanceof Error ? err.message : String(err);
        reasons.push(`the database cannot be read: ${database.error}`);
      }

      const state = ami?.state ?? null;
      if (!ami) reasons.push('AMI is not configured (ASTER_AMI_SECRET is not set), so nothing can be changed in Asterisk');
      else if (state !== 'up') {
        reasons.push(state === 'booting'
          ? 'Asterisk accepted the AMI login but has not reported FullyBooted yet'
          : `Asterisk is not reachable over AMI (${state})`);
      }

      const asterisk = await probe(at);
      if (asterisk && asterisk.missing.length > 0) reasons.push(`required Asterisk modules are not running: ${asterisk.missing.join(', ')}`);

      const { backlog, quarantine, diskFreeMb } = await files(at);
      if (backlog !== null && backlog > limit.spoolBacklog) reasons.push(`${backlog} spool files are waiting to be ingested (more than ${limit.spoolBacklog})`);
      if (diskFreeMb !== null && diskFreeMb < limit.diskFreeMb) reasons.push(`${diskFreeMb} MB free on the disk (less than ${limit.diskFreeMb} MB)`);

      return {
        status: reasons.length === 0 ? 'ok' : 'degraded',
        reasons,
        versions: { controller: version, node: process.version, asterisk: asterisk?.asterisk ?? null },
        ami: { configured: ami !== null, state, connected: ami?.connected ?? false, since: ami?.since ?? null },
        fully_booted: state === 'up',
        modules: { checked: asterisk !== null && asterisk.error === null, missing: asterisk?.missing ?? [], error: asterisk?.error ?? null },
        spool_backlog: backlog,
        quarantine,
        disk_free_mb: diskFreeMb,
        database,
        uptime_s: Math.round((at - startedAt) / 1000),
        checked_at: at,
      };
    },
  };
}

/** @typedef {ReturnType<typeof createHealth>} Health */
/** @typedef {import('../server.js').Ctx} Ctx */

// The numbers behind the health strip: what the appliance still owes somebody — an SMS it has not managed to send, a
// notification that has not reached Telegram, an operation still running. Reads only, so a GET still writes nothing.
const WAITING_SMS = "SELECT COUNT(*) AS n FROM sms_outbox WHERE status IN ('queued', 'submitting', 'submitted', 'accepted')";
const FAILED_SMS = `SELECT COUNT(*) AS n FROM sms_outbox
  WHERE status IN ('rejected', 'undelivered', 'undelivered_expired', 'failed', 'uncertain') AND updated_at >= ?`;
const WAITING_NOTIFICATIONS = "SELECT COUNT(*) AS n FROM notifications WHERE status IN ('pending', 'sending', 'retry')";
const FAILED_NOTIFICATIONS = "SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed' AND created_at >= ?";
const RUNNING_OPERATIONS = "SELECT COUNT(*) AS n FROM operations WHERE status = 'running'";
const WAITING_OPERATIONS = "SELECT COUNT(*) AS n FROM operations WHERE status IN ('queued', 'interrupted')";
/** A notification nobody could send becomes `failed` 24 h after it was created (notify/queue.js), and the table has no
 *  `updated_at`: a window of one day by creation would therefore count none of them, so the window spans that wait as well. */
const NOTIFY_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {...(string | number)} params
 */
function count(db, sql, ...params) {
  const row = /** @type {{ n?: number } | undefined} */ (db.prepare(sql).get(...params));
  return Number(row?.n ?? 0);
}

/**
 * The health strip's extras: every registry modem with its state derived now, and the work in flight.
 * Only added for a request with a session, since /api/health is public.
 * @param {Ctx} ctx
 * @param {number} at
 */
export function summaryOf(ctx, at) {
  /** @type {import('../../config/registry.js').Registry | null} */
  let registry = null;
  try {
    registry = ctx.registry();
  } catch {
    // An unreadable registry is a problem the pages already state in their own words; for the strip it means no modems.
    registry = null;
  }
  const states = ctx.devices?.states() ?? new Map();
  const modems = (registry?.modems ?? []).map((modem) => {
    const row = states.get(modem.id) ?? null;
    return {
      id: modem.id,
      enabled: modem.enabled,
      state: ctx.devices?.stateOf(modem) ?? 'unverified',
      rssi: row?.rssi ?? null,
      provider: row?.provider ?? null,
    };
  });
  return {
    modems,
    sms: { waiting: count(ctx.db, WAITING_SMS), failed: count(ctx.db, FAILED_SMS, at - RECENT_MS) },
    notifications: {
      waiting: count(ctx.db, WAITING_NOTIFICATIONS),
      failed: count(ctx.db, FAILED_NOTIFICATIONS, at - RECENT_MS - NOTIFY_EXPIRY_MS),
    },
    operations: { running: count(ctx.db, RUNNING_OPERATIONS), waiting: count(ctx.db, WAITING_OPERATIONS) },
  };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {Ctx} ctx
 */
export function healthRoutes(app, ctx) {
  app.get('/api/health', async (request) => {
    const body = await ctx.health.check();
    if (ctx.sessionOf(request) === null) return body;
    try {
      return { ...body, summary: summaryOf(ctx, ctx.now()) };
    } catch (err) {
      // Nothing in this route throws: whether the appliance is up matters more than the extras beside it.
      ctx.log.warn('the health summary could not be built', { err });
      return { ...body, summary: null };
    }
  });
}
