// @ts-check
// Test harness for the HTTP API: a temporary ASTER_HOME, a migrated database, the bus, a runner whose kinds are recording
// stubs, the real outbox and notification queue, and the server driven with fastify.inject().
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../src/bus.js';
import { load, stringify, validate } from '../src/config/registry.js';
import { createSecretsStore } from '../src/env.js';
import { hashPassword } from '../src/http/auth.js';
import { REQUIRED_MODULES } from '../src/http/routes/health.js';
import { createServer } from '../src/http/server.js';
import { createRing } from '../src/logs/ring.js';
import { createNotifyQueue } from '../src/notify/queue.js';
import { createRunner, OperationError } from '../src/ops/runner.js';
import { createOutbox } from '../src/sms/outbox.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi } from './devices-fake.js';

export const PASSWORD = 'correct horse battery';
/** scrypt parameters for the tests only: a login must not cost 100 ms. */
export const WEAK = Object.freeze({ ln: 4, r: 8, p: 1 });

/** The modem and the phone of REGISTRY, so a test can name their fields without indexing the frozen list. */
export const MODEM = Object.freeze({ id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true, usb_port: '1-1', ring: ['596'] });
export const PHONE = Object.freeze({ number: '596', label: 'Desk', secret: 'sip-secret' });
/** A registry with one modem and one phone, enough for the overview. */
export const REGISTRY = Object.freeze({
  version: 1,
  settings: { ui_language: 'ru', timezone: 'Europe/Istanbul', retention_days: { operations: 90, notifications: 45, messages: 200, calls: 365 } }, // not the defaults, so a patch that drops a field shows
  telegram: { default_recipients: ['100200300'], alerts: false },
  modems: [MODEM],
  phones: [PHONE],
});

/** The operation kinds the routes enqueue; every one is a recording stub here. */
export const KINDS = Object.freeze(['registry-apply', 'config-apply', 'config-restore', 'modem-start', 'modem-stop', 'modem-restart',
  'modem-reset', 'remap', 'scan', 'at', 'forwarding', 'ussd', 'ussd-cancel']);
/** Kinds that take the global lock, so a stub must declare it (ops/runner.js refuses 'queue' for them). */
const GLOBAL = new Set(['registry-apply', 'config-apply', 'config-restore', 'remap']);

/**
 * @param {object} [options]
 * @param {string | null} [options.password]  null: no ASTER_ADMIN_PASSWORD_HASH in secrets.env
 * @param {Record<string, string>} [options.secrets]  further secrets.env entries
 * @param {object | null} [options.registry]  written to config/aster.yaml (null: no file, as before install.sh)
 * @param {Record<string, string> | null} [options.files]  config/asterisk files to write (name → content)
 * @param {Record<string, string>} [options.prev]  state/prev files to write (name → content)
 * @param {boolean} [options.ami]  give the server a fake AMI client (default true)
 * @param {string | null} [options.uiDir]
 * @param {Record<string, number>} [options.timing]
 * @param {{ spoolBacklog?: number, diskFreeMb?: number }} [options.thresholds]
 * @param {any} [options.devices]  a device state (the overview asks it for states() and stateOf())
 * @param {any} [options.scan]     scan operations (the overview asks it for latest())
 * @param {() => number} [options.now]
 */
export async function harness(options = {}) {
  const { password = PASSWORD, secrets: extra = {}, registry: initial = REGISTRY, files = null, prev = {}, ami: withAmi = true,
    uiDir = null, timing = {}, thresholds = { diskFreeMb: 0 }, devices = null, scan = null, now = Date.now } = options;
  const dir = mkdtempSync(join(tmpdir(), 'aster-http-'));
  const paths = { home: dir, config: join(dir, 'config'), state: join(dir, 'state'), spool: join(dir, 'spool'),
    registry: join(dir, 'config', 'aster.yaml'), secrets: join(dir, 'config', 'secrets.env'), db: join(dir, 'state', 'aster.db'),
    asteriskConfig: join(dir, 'config', 'asterisk'), prev: join(dir, 'state', 'prev'), asteriskLog: join(dir, 'logs', 'asterisk', 'full') };
  mkdirSync(paths.config, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  mkdirSync(paths.prev, { recursive: true });
  mkdirSync(join(paths.asteriskConfig, 'aster.d'), { recursive: true });
  mkdirSync(join(dir, 'logs', 'asterisk'), { recursive: true });
  mkdirSync(join(paths.spool, 'events'), { recursive: true });
  const lines = ['# Aster secrets', 'ASTER_AMI_SECRET=ami-secret'];
  if (password !== null) lines.push(`${'ASTER_ADMIN_PASSWORD_HASH'}=${await hashPassword(password, WEAK)}`);
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}=${value}`);
  writeFileSync(paths.secrets, `${lines.join('\n')}\n`, { mode: 0o600 });
  if (initial) writeFileSync(paths.registry, stringify(initial));
  for (const [name, content] of Object.entries(files ?? { 'extensions.conf': '[aster-hand]\nexten => 100,1,Hangup()\n' })) {
    writeFileSync(join(paths.asteriskConfig, name), content);
  }
  for (const [name, content] of Object.entries(prev)) writeFileSync(join(paths.prev, name), content);

  const db = open(paths.db);
  migrate(db);
  const bus = createBus();
  const ami = withAmi ? new FakeDriverAmi() : null;
  /** what `module show` reports as Running (health); a test can drop one */
  let modules = [...REQUIRED_MODULES];
  let commands = 0;
  if (ami) {
    ami.onCommand = (cli) => {
      commands += 1;
      if (cli === 'module show') {
        return ['Module                         Description                  Use Count  Status      Support Level',
          ...modules.map((name) => `${name.padEnd(30)} a description                0          Running      core`),
          `${modules.length} modules loaded`];
      }
      if (cli === 'core show version') return ['Asterisk 20.15.2 built by aster @ host on a x86_64 running Linux'];
      return undefined;
    };
  }
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus });
  /** every registry-apply the routes enqueued @type {Array<Record<string, unknown>>} */
  const applies = [];
  /** what a kind's stub does next: 'write'/'done' (default), 'fail', 'hang' (until release()) @type {Map<string, string>} */
  const modes = new Map();
  /** @type {Array<() => void>} */
  let releases = [];
  for (const kind of KINDS) {
    runner.register(kind, async (ctx) => {
      const params = ctx.op.params ?? {};
      if (kind === 'registry-apply') applies.push(params);
      const mode = modes.get(kind) ?? 'done';
      if (mode === 'hang') await new Promise((resolve) => releases.push(() => resolve(undefined)));
      if (mode === 'fail') throw new OperationError(kind === 'registry-apply' ? 'the reload failed' : `${kind} failed`, { status: 'failed', result: { observed_at: Date.now() } });
      if (kind === 'registry-apply') {
        writeFileSync(paths.registry, stringify(/** @type {any} */ (params.registry)));
        return { observed_at: Date.now(), written: true };
      }
      if (kind === 'config-apply' || kind === 'config-restore') {
        if (typeof params.content === 'string') writeFileSync(join(paths.asteriskConfig, String(params.name)), params.content);
        const { fileHash } = await import('../src/config/atomic.js');
        return { observed_at: Date.now(), name: params.name, hash: fileHash(join(paths.asteriskConfig, String(params.name))) };
      }
      return { observed_at: Date.now(), stub: true };
    }, GLOBAL.has(kind) ? { lock: 'global' } : undefined);
  }

  const registry = () => {
    try {
      return load(paths.registry).registry;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('registry not found')) return validate({ version: 1, modems: [], phones: [] });
      return null;
    }
  };
  const store = createSecretsStore(paths.secrets);
  // A short action timeout: an sms-send with no device behind the fake AMI must fail at once, not hold up the runner's stop.
  const outbox = createOutbox({ db, registry, timing: { actionTimeoutMs: 100 } });
  outbox.register(runner);
  const notify = createNotifyQueue({ db, bus, token: () => store.get().TELEGRAM_BOT_TOKEN, timeZone: () => 'UTC', host: () => 'aster-test' });
  const logRing = createRing({ stream: null, lines: 50 });
  // host/port matter only for the tests that need a real socket (the event stream); the rest use fastify.inject().
  const server = createServer({ db, bus, runner, registry, secrets: store, ami: /** @type {any} */ (ami), paths, uiDir, now, timing,
    thresholds, devices, scan, outbox, notify, logRing, version: '1.2.3', startedAt: now(), host: '127.0.0.1', port: 0 });
  runner.start();

  /**
   * Logs in and returns the cookie header for the following requests.
   * @param {string} [text]
   */
  async function login(text = PASSWORD) {
    const response = await server.app.inject({ method: 'POST', url: '/api/login', payload: { password: text } });
    const cookie = String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    return { response, cookie, headers: { cookie } };
  }

  return {
    dir, paths, db, bus, runner, ami, server, applies, login, outbox, notify, logRing,
    app: server.app,
    secrets: store,
    /** The registry file as it is now. */
    onDisk: () => load(paths.registry),
    secretsText: () => readFileSync(paths.secrets, 'utf8'),
    /** The stored operations of one kind, in id order — what the route enqueued, whether or not its handler has run. @param {string} kind */
    opsOf: (kind) => db.prepare('SELECT * FROM operations WHERE kind = ? ORDER BY id').all(kind).map((row) => ({
      id: Number(row.id), kind: String(row.kind), modem_id: row.modem_id === null ? null : String(row.modem_id),
      status: String(row.status), actor: String(row.actor), params: row.params_json === null ? null : JSON.parse(String(row.params_json)),
    })),
    /** @param {'write' | 'done' | 'fail' | 'hang'} mode @param {string} [kind] */
    applyMode: (mode, kind = 'registry-apply') => {
      modes.set(kind, mode);
    },
    /** Lets every 'hang' stub finish (the runner's stop() waits for its handlers). */
    release: () => {
      modes.clear();
      for (const resolve of releases) resolve();
      releases = [];
    },
    /** Drops modules from what `module show` reports. @param {string[]} names */
    stopModules: (names) => {
      modules = REQUIRED_MODULES.filter((name) => !names.includes(name));
    },
    /** How many CLI commands the health probe has run. */
    commands: () => commands,
    /** Rows for the history routes. @param {object} rows */
    seed: (rows) => seed(db, rows),
    async stop() {
      await server.close();
      await runner.stop();
      outbox.stop();
      await notify.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Inbox messages, calls and notifications as the ingester and the queue would have written them: a message and a call need
 * their `events` row, which the foreign keys enforce.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ messages?: any[], calls?: any[], notifications?: any[], outbox?: any[] }} rows
 */
export function seed(db, { messages = [], calls = [], notifications = [], outbox = [] }) {
  const event = db.prepare('INSERT INTO events (id, kind, modem_id, uniqueid, emitted_at, received_at, fields_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const message = db.prepare('INSERT INTO messages (event_id, modem_id, sender, text, scts, received_at) VALUES (?, ?, ?, ?, ?, ?)');
  const call = db.prepare(`INSERT INTO calls (event_id, modem_id, uniqueid, caller, did, dialstatus, answered_sec, dialed_sec,
    disposition, hangupcause, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const notification = db.prepare(`INSERT INTO notifications (source_kind, source_id, chat_id, part_no, part_count, text, status,
    attempts, next_at, tg_message_id, error, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const sms = db.prepare('INSERT INTO sms_outbox (modem_id, number, text, status, attempt_no, created_at, updated_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const row of messages) {
    const id = `m${(n += 1)}`;
    event.run(id, 'sms', row.modem_id ?? 'gsm1', null, row.received_at ?? 0, row.received_at ?? 0, '{}');
    message.run(id, row.modem_id ?? 'gsm1', row.sender ?? null, row.text ?? '', row.scts ?? null, row.received_at ?? 0);
  }
  for (const row of calls) {
    const id = `c${(n += 1)}`;
    event.run(id, 'call-end', row.modem_id ?? 'gsm1', row.uniqueid ?? id, row.ended_at ?? 0, row.ended_at ?? 0, '{}');
    call.run(id, row.modem_id ?? 'gsm1', row.uniqueid ?? id, row.caller ?? null, row.did ?? null, row.dialstatus ?? null,
      row.answered_sec ?? null, row.dialed_sec ?? null, row.disposition ?? null, row.hangupcause ?? null, row.outcome ?? 'missed', row.ended_at ?? 0);
  }
  for (const row of notifications) {
    notification.run(row.source_kind ?? 'sms', row.source_id ?? null, row.chat_id ?? '100200300', row.part_no ?? 1, row.part_count ?? 1,
      row.text ?? '', row.status ?? 'sent', row.attempts ?? 1, row.next_at ?? null, row.tg_message_id ?? null, row.error ?? null,
      row.created_at ?? 0, row.sent_at ?? null);
  }
  for (const row of outbox) {
    sms.run(row.modem_id ?? 'gsm1', row.number ?? '+375290000001', row.text ?? '', row.status ?? 'queued', row.attempt_no ?? 0,
      row.created_at ?? 0, row.updated_at ?? row.created_at ?? 0, row.last_error ?? null);
  }
}

/**
 * The sha256 of every table except `sessions` — what "a GET never mutates" means: no domain row changes. The session's
 * last_seen_at is not domain state and is written at most once a minute (src/http/session.js).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sessions?: boolean }} [options]  sessions: true includes the session table
 */
export function snapshot(db, { sessions = false } = {}) {
  const tables = /** @type {Array<{ name: string }>} */ (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all())
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith('sqlite_') && (sessions || name !== 'sessions'));
  /** @type {Record<string, unknown[]>} */
  const out = {};
  for (const name of tables) out[name] = db.prepare(`SELECT * FROM ${name}`).all().map((row) => ({ ...row }));
  return JSON.stringify(out);
}
