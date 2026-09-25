// @ts-check
// Aster controller entry point: load the environment, open and migrate the database, start every module, and stop them in
// reverse order on SIGTERM/SIGINT. Without ASTER_AMI_SECRET it runs but refuses what needs Asterisk; a boot error exits 1.
// Usage: node src/index.js [--check]   (--check: open the database, apply migrations, print the table names, exit 0)
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AmiClient } from './ami/client.js';
import { createBus } from './bus.js';
import { createConfigOps } from './config/apply.js';
import { DEFAULTS as REGISTRY_DEFAULTS, load as loadRegistry, validate } from './config/registry.js';
import { createAtOps } from './at/client.js';
import { createForwardingOps } from './at/forwarding.js';
import { createSimNumberOps } from './at/simnumber.js';
import { createUssdOps } from './at/ussd.js';
import { createLifecycleOps } from './devices/lifecycle.js';
import { createRemapOps } from './devices/remap.js';
import { createScanOps } from './devices/scan.js';
import { createDeviceState } from './devices/state.js';
import { createSecretsStore, loadEnv } from './env.js';
import { createServer } from './http/server.js';
import { createLogger } from './log.js';
import { createRing } from './logs/ring.js';
import { startLogRotation } from './logs/rotate.js';
import { createAlerts } from './notify/alerts.js';
import { createIngestHooks } from './notify/hooks.js';
import { createNotifyQueue } from './notify/queue.js';
import { startRetention } from './ops/retention.js';
import { createRunner } from './ops/runner.js';
import { createReconciler } from './reconcile.js';
import { watchConnections } from './sip/connections.js';
import { createOutbox } from './sms/outbox.js';
import { applyReport, createReportListener } from './sms/reports.js';
import { start as startSpool } from './spool/ingest.js';
import { listTables, migrate, open, schemaVersion } from './store/db.js';

const HEARTBEAT_MS = 3_600_000; // hourly, to limit SD-card writes
/** How long a stop waits for running operations; a hung handler never settles and the next start re-evaluates it. */
const STOP_DEADLINE_MS = 30_000;
/** What the device modules see before install.sh has written config/aster.yaml: no modems. */
const EMPTY_REGISTRY = validate({ version: 1, modems: [], phones: [] });
// Lines still go to stdout; the ring keeps the last ones for GET /api/logs/controller (the container has no log file).
const ring = createRing();
const log = createLogger({ stream: ring });

/**
 * @param {string} msg
 * @param {unknown} err
 * @returns {never}
 */
function fail(msg, err) {
  log.error(msg, { err });
  process.exit(1);
}

process.on('uncaughtException', (err) => fail('uncaught exception', err));
process.on('unhandledRejection', (err) => fail('unhandled rejection', err));

/**
 * The retention days of the registry on disk, read each time retention runs; the defaults when it is missing or invalid.
 * @param {string} path
 */
function retentionDays(path) {
  try {
    return loadRegistry(path).registry.settings.retention_days;
  } catch (err) {
    log.warn('retention uses the default days: the registry cannot be loaded', { registry: path, err });
    return REGISTRY_DEFAULTS.settings.retention_days;
  }
}

/**
 * A reader of the registry on disk for the device modules: the empty registry while the file does not exist yet, null while it is
 * invalid (the modules keep their last state and say so once).
 * @param {string} path
 */
function registryReader(path) {
  return () => {
    try {
      return loadRegistry(path).registry;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('registry not found')) return EMPTY_REGISTRY;
      return null;
    }
  };
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
  const env = loadEnv();
  const db = open(env.paths.db);
  const { from, to, applied } = migrate(db);
  log.info(applied.length > 0 ? 'migrations applied' : 'schema up to date', { db: env.paths.db, from, to, applied });

  if (values.check) {
    const tables = listTables(db);
    db.close();
    process.stdout.write(`${tables.join('\n')}\n`);
    return;
  }

  const startedAt = Date.now();
  const bus = createBus({ log: log.child({ module: 'bus' }) });
  // Stays current when the settings API rewrites secrets.env, so readers need no restart.
  const secrets = createSecretsStore(env.paths.secrets, env.secrets);
  // Development only: a stand-in for Asterisk on loopback that the real AMI client connects to (ami/mock.js).
  const mockAmi = env.amiMock
    ? await (await import('./ami/mock.js')).startMockAmi({ configDir: env.paths.asteriskConfig, log: log.child({ module: 'ami-mock' }) })
    : null;
  const secret = mockAmi?.secret ?? env.secrets.ASTER_AMI_SECRET;
  const target = secret
    ? Object.freeze({ host: mockAmi?.host ?? env.ami.host, port: mockAmi?.port ?? env.ami.port, username: mockAmi?.username ?? env.ami.username, secret })
    : null;
  const ami = target ? new AmiClient({ log: log.child({ module: 'ami' }) }) : null;
  if (!ami) log.warn('ASTER_AMI_SECRET is not set: running without AMI; configuration changes that need a reload are refused', { secrets: env.paths.secrets });
  const asteriskLog = join(env.paths.logs, 'asterisk', 'full');
  const registry = registryReader(env.paths.registry);
  const runner = createRunner({ db, ami, bus, log: log.child({ module: 'ops' }) });
  const reconciler = createReconciler({ log: log.child({ module: 'reconcile' }) });
  const configOps = createConfigOps({
    paths: { configDir: env.paths.asteriskConfig, registry: env.paths.registry, prevDir: env.paths.prev, asteriskLog },
    log: log.child({ module: 'config' }),
    hooks: { applied: reconciler.afterRegistryApply },
  });
  configOps.register(runner);
  createLifecycleOps({ registry, log: log.child({ module: 'devices' }) }).register(runner);
  const scanOps = createScanOps({ db, registry, log: log.child({ module: 'scan' }), sysfsRoot: env.sysfsRoot, ami });
  scanOps.register(runner);
  const remapOps = createRemapOps({ paths: { registry: env.paths.registry }, apply: configOps.apply, log: log.child({ module: 'remap' }), sysfsRoot: env.sysfsRoot });
  remapOps.register(runner);
  const smsLog = log.child({ module: 'sms' });
  const outbox = createOutbox({ db, registry, log: smsLog });
  outbox.register(runner);
  const atLog = log.child({ module: 'at' });
  createAtOps({ registry, log: atLog }).register(runner);
  createForwardingOps({ db, registry, log: atLog }).register(runner);
  createUssdOps({ registry, log: atLog }).register(runner);
  createSimNumberOps({ registry, log: atLog }).register(runner);
  const reports = ami ? createReportListener({ ami, db, log: smsLog }) : null;
  const connections = ami ? watchConnections({ ami, bus }) : null;
  const devices = createDeviceState({
    db, ami, bus, registry, sysfsRoot: env.sysfsRoot,
    log: log.child({ module: 'devices' }),
    onUsbChange: (change) => scanOps.onUsbChange(change),
    onRemapNeeded: (modemId, reason) => {
      if (ami?.connected) remapOps.trigger(modemId, reason, db);
    },
  });
  const notifyLog = log.child({ module: 'notify' });
  /** @type {import('./spool/ingest.js').Hooks} */
  const hooks = { ...createIngestHooks({ registry, bus, log: notifyLog }), applyReport: (report, ctx) => void applyReport(ctx.db, report, { log: smsLog }) };
  const spool = startSpool(db, join(env.paths.spool, 'events'), { log: log.child({ module: 'spool' }), hooks });
  // The token is read at every tick, so one set through the settings API is used by the next tick.
  const notify = createNotifyQueue({ db, bus, token: () => secrets.get().TELEGRAM_BOT_TOKEN, timeZone: () => registry()?.settings.timezone ?? 'UTC',
    apiBase: env.telegramApi, log: notifyLog });
  const alerts = createAlerts({ db, bus, ami, registry, log: log.child({ module: 'alerts' }) });
  outbox.start(); // before the runner re-evaluates an interrupted sms-send
  const operations = runner.start();
  alerts.start(); // before the refresher publishes its first modem.state events
  devices.start();
  notify.start();
  const retention = startRetention(db, { days: () => retentionDays(env.paths.registry), log: log.child({ module: 'retention' }) });
  const rotation = ami ? startLogRotation({ ami, path: asteriskLog, log: log.child({ module: 'logs' }) }) : null;
  const http = createServer({
    db, bus, runner, registry, secrets, devices, scan: scanOps, outbox, notify, logRing: ring, ami, startedAt,
    paths: { home: env.home, spool: env.paths.spool, state: env.paths.state, registry: env.paths.registry,
      asteriskConfig: env.paths.asteriskConfig, prev: env.paths.prev, asteriskLog },
    uiDir: env.uiDir, host: env.http.host, port: env.http.port, log: log.child({ module: 'http' }),
  });
  const address = await http.listen();
  let stopping = false;
  if (ami && target) {
    ami.connect(target).catch((err) => {
      if (!stopping) log.error('AMI connect failed', { err });
    });
  }

  // The heartbeat reads the database, so a store that became unusable ends the process.
  const heartbeat = setInterval(() => {
    log.info('heartbeat', { uptime_s: Math.round((Date.now() - startedAt) / 1000), schema_version: schemaVersion(db), ami: ami?.state ?? 'none', modems: devices.states().size });
  }, HEARTBEAT_MS);

  /** @param {NodeJS.Signals} signal */
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    await http.close();
    await devices.stop();
    alerts.stop();
    scanOps.stop();
    rotation?.stop();
    retention.stop();
    await spool.stop();
    await notify.stop();
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        log.warn('operations still running at the stop deadline; the next start re-evaluates them', { deadline_ms: STOP_DEADLINE_MS });
        resolve(undefined);
      }, STOP_DEADLINE_MS);
      timer.unref();
    });
    await Promise.race([runner.stop(), deadline]);
    clearTimeout(timer);
    outbox.stop();
    reports?.stop();
    connections?.stop();
    if (ami) await ami.close();
    await mockAmi?.close();
    db.close();
    log.info('stopped', { signal });
  }
  process.on('SIGTERM', (signal) => void stop(signal).catch((err) => fail('stop failed', err)));
  process.on('SIGINT', (signal) => void stop(signal).catch((err) => fail('stop failed', err)));
  log.info('ready', { pid: process.pid, node: process.version, home: env.home, http: address, ui: env.uiDir,
    ami: target ? `${target.host}:${target.port}` : null, ami_mock: mockAmi !== null, sysfs: env.sysfsRoot, operations });
}

main().catch((err) => fail('boot failed', err));
