// @ts-check
// Tests for src/index.js run as a process: --check, boot errors, a clean start and stop, spool events reaching a fake
// Telegram, and SMS attempts recovered against a fake AMI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { asterisk, fakeAmi, packet } from './ami-fake-server.js';
import { startFakeTelegram } from './telegram-fake.js';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));
const TABLES = ['calls', 'devices_seen', 'events', 'messages', 'modem_forwarding', 'notifications', 'operations', 'sessions', 'settings',
  'sms_attempts', 'sms_outbox'];

const tmp = mkdtempSync(join(tmpdir(), 'aster-index-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A minimal ASTER_HOME: an empty config/secrets.env and a state/ directory.
 * @param {string} name
 * @param {{ secrets?: boolean, state?: boolean }} [layout]
 */
function makeHome(name, { secrets = true, state = true } = {}) {
  const home = join(tmp, name);
  mkdirSync(join(home, 'config'), { recursive: true });
  if (state) mkdirSync(join(home, 'state'));
  if (secrets) writeFileSync(join(home, 'config', 'secrets.env'), '', { mode: 0o600 });
  return home;
}

/**
 * A free loopback port (80 needs root), and an ASTER_UI_DIR that does not exist so the result does not depend on a local
 * UI build.
 * @param {string} home
 */
const environ = (home) => ({ ...process.env, ASTER_HOME: home, ASTER_HTTP_HOST: '127.0.0.1', ASTER_HTTP_PORT: '0',
  ASTER_UI_DIR: join(home, 'no-ui') });

/**
 * @param {string} home
 * @param {string[]} args
 */
const runSync = (home, args) => spawnSync(process.execPath, [INDEX, ...args], { env: environ(home), encoding: 'utf8', timeout: 20_000 });

/**
 * The JSON log lines of an output.
 * @param {string} stdout
 * @returns {Array<Record<string, any>>}
 */
const logLines = (stdout) => stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));

test('--check on an empty ASTER_HOME creates state/aster.db, prints every table and exits 0', () => {
  const home = makeHome('check');
  const first = runSync(home, ['--check']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(first.stderr, '', 'nothing on stderr (node:sqlite prints an ExperimentalWarning before Node 24.15)');
  assert.ok(existsSync(join(home, 'state', 'aster.db')));
  assert.deepEqual(first.stdout.split('\n').filter((line) => line !== '' && !line.startsWith('{')), TABLES);
  const [migrated] = logLines(first.stdout);
  assert.equal(migrated?.msg, 'migrations applied');
  assert.deepEqual([migrated?.from, migrated?.to, migrated?.applied], [0, 3, [1, 2, 3]]);

  const second = runSync(home, ['--check']);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(logLines(second.stdout)[0]?.msg, 'schema up to date');
});

test('a missing secrets file, a missing state directory and an unknown option are boot errors: one JSON line, exit 1', () => {
  const cases = [
    { home: makeHome('no-secrets', { secrets: false }), args: ['--check'], message: /^secrets file not found: .*\/no-secrets\/config\/secrets\.env / },
    {
      home: makeHome('no-state', { state: false }),
      args: ['--check'],
      message: /^cannot open database .*\/no-state\/state\/aster\.db: unable to open database file$/,
    },
    { home: makeHome('bad-option'), args: ['--bogus'], message: /^Unknown option '--bogus'/ },
  ];
  for (const { home, args, message } of cases) {
    const result = runSync(home, args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const entries = logLines(result.stdout);
    assert.equal(entries.length, 1, result.stdout);
    assert.equal(entries[0]?.level, 'error');
    assert.equal(entries[0]?.msg, 'boot failed');
    assert.match(String(entries[0]?.err?.message), message);
  }
  assert.ok(!existsSync(join(tmp, 'no-secrets', 'state', 'aster.db')), 'the database is not touched before the environment loads');
});

test('without --check the process stays up, logs ready, and on SIGTERM closes the database and exits 0', async (t) => {
  const home = makeHome('run');
  // with an admin password the whole API can be walked through the booted process, tar and all.
  const { hashPassword } = await import('../src/http/auth.js');
  writeFileSync(join(home, 'config', 'secrets.env'), `ASTER_ADMIN_PASSWORD_HASH=${await hashPassword('correct horse battery', { ln: 4 })}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [INDEX], { env: environ(home), stdio: ['ignore', 'pipe', 'pipe'] });
  // A failed assertion below would otherwise leave the controller running, and `node --test` waits for it: the file would hang
  // instead of reporting the failure.
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, 'close');
  const deadline = Date.now() + 15_000;
  while (!stdout.includes('"msg":"ready"')) {
    assert.ok(Date.now() < deadline && child.exitCode === null, `no ready line: ${stdout}${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(join(home, 'state', 'aster.db-wal')), 'the WAL file exists while the database is open');
  // the API is up on the port the ready line names, and /api/health answers without a session.
  const address = String(logLines(stdout).find((entry) => entry.msg === 'ready')?.http ?? '');
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/, stdout);
  const health = await fetch(`${address}/api/health`);
  assert.equal(health.status, 200);
  const body = /** @type {any} */ (await health.json());
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.reasons, ['AMI is not configured (ASTER_AMI_SECRET is not set), so nothing can be changed in Asterisk']);
  assert.equal((await fetch(`${address}/api/overview`)).status, 401, 'everything else needs a session');
  // this ASTER_UI_DIR holds no build, and the controller names the directory instead of answering an empty page.
  const noUi = await fetch(`${address}/`);
  assert.equal(noUi.status, 503);
  assert.equal(/** @type {any} */ (await noUi.json()).error, `the web UI directory has no index.html (${join(home, 'no-ui')})`);

  // log in over the socket and walk the resource routes of the running process.
  const login = await fetch(`${address}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery' }) });
  assert.equal(login.status, 200);
  const cookie = String(login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
  assert.match(cookie, /^aster_sid=/);
  const get = (/** @type {string} */ path) => fetch(`${address}${path}`, { headers: { cookie } });
  for (const path of ['/api/modems', '/api/phones', '/api/messages', '/api/calls', '/api/notifications', '/api/operations',
    '/api/config/files', '/api/scan/latest', '/api/logs/controller']) {
    assert.equal((await get(path)).status, 200, path);
  }
  assert.deepEqual((await (await get('/api/modems')).json()).modems, [], 'no registry file yet, so no modems');
  const files = /** @type {any} */ (await (await get('/api/config/files')).json());
  assert.equal(files.files.filter((/** @type {any} */ file) => file.present).length, 0, 'this ASTER_HOME has no config/asterisk yet');
  const ring = /** @type {any} */ (await (await get('/api/logs/controller?grep=ready')).json());
  assert.equal(ring.lines.filter((/** @type {string} */ line) => JSON.parse(line).msg === 'ready').length, 1,
    'the controller log route answers the ring buffer the logger writes to');
  const archive = await get('/api/backup');
  assert.equal(archive.status, 200);
  assert.match(String(archive.headers.get('content-disposition')), /aster-\d{8}T\d{6}Z\.tar\.gz/);
  const bytes = Buffer.from(await archive.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], 'a gzip stream comes back');
  writeFileSync(join(home, 'archive.tar.gz'), bytes);
  const listed = spawnSync('tar', ['tzf', join(home, 'archive.tar.gz')], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes('state/aster.db'), listed.stdout);
  assert.ok(listed.stdout.includes('config/secrets.env'), listed.stdout);

  child.kill('SIGTERM');
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(code, 0, stdout + stderr);
  assert.equal(stderr, '');
  const entries = logLines(stdout);
  // the boot assembles the modules; without ASTER_AMI_SECRET the controller runs without AMI and says so
  assert.deepEqual(entries.map((entry) => entry.msg), ['migrations applied', 'ASTER_AMI_SECRET is not set: running without AMI; configuration changes that need a reload are refused',
    'operations runner started', 'no web UI in this build: only the JSON API under /api is served', 'http listening', 'ready',
    'request refused', 'request refused', 'logged in', 'the backup leaves out paths that do not exist', 'backup download started',
    'backup download finished', 'stopped'],
  'every answered request is logged at debug; only the 401, the 503, the login, the backup and the boot lines are above it');
  assert.deepEqual(entries.map((entry) => entry.level), ['info', 'warn', 'info', 'warn', 'info', 'info', 'info', 'warn', 'info',
    'warn', 'info', 'info', 'info']);
  assert.deepEqual([entries[6]?.status, entries[6]?.url], [401, '/api/overview'], 'the answered health request is logged at debug, the refusal at info');
  assert.deepEqual([entries[7]?.status, entries[7]?.url], [503, '/'], 'a refusal the controller makes on purpose is a warning, not an error');
  assert.equal(entries[5]?.ami, null);
  assert.equal(String(entries[5]?.ui), join(home, 'no-ui'), 'the UI directory of this run (the image build puts one there; here there is none)');
  assert.equal(entries.at(-1)?.signal, 'SIGTERM');
  assert.ok(existsSync(join(home, 'spool', 'events')), 'the spool ingester created its directory');
  assert.ok(!existsSync(join(home, 'state', 'aster.db-wal')), 'closing the last connection checkpoints and removes the WAL file');
});

test('notify: spool events reach Telegram through the booted controller — one message per missed call and per SMS, nothing else', async () => {
  const tg = await startFakeTelegram();
  const home = makeHome('notify');
  writeFileSync(join(home, 'config', 'secrets.env'), 'TELEGRAM_BOT_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw\n', { mode: 0o600 });
  writeFileSync(join(home, 'config', 'aster.yaml'), [
    'version: 1',
    'settings: { timezone: UTC }',
    'telegram: { default_recipients: ["111222333"] }',
    'modems:',
    '  - { id: cap_noanswer, driver: quectel, imei: "000000000000103", enabled: false }',
    'phones: []',
    '',
  ].join('\n'));
  const events = join(home, 'spool', 'events');
  mkdirSync(events, { recursive: true });
  const fixtures = new URL('./fixtures/spool/', import.meta.url);
  const tab = String.fromCharCode(9);
  /** @param {string} path @param {(columns: string[]) => void} [edit] */
  const put = (path, edit) => {
    const columns = readFileSync(new URL(path, fixtures)).toString('latin1').slice(0, -1).split(tab);
    edit?.(columns);
    writeFileSync(join(events, `${columns[2]}.evt`), `${columns.join(tab)}\n`, 'latin1');
    return columns;
  };
  const missed = put('calls/noanswer.evt');
  put('calls/answered.evt');
  // the hangup handler of the same channel once more: a new event id (one second later), the same uniqueid → no second message
  put('calls/noanswer.evt', (columns) => {
    const ns = BigInt((columns[2] ?? '').split('-')[0] ?? '0') + 1_000_000_000n;
    columns[2] = `${ns}${(columns[2] ?? '').slice(String(ns).length)}`;
    columns[4] = String(ns).slice(0, -9);
  });
  copyFileSync(new URL('valid/sms-alphanumeric-sender.evt', fixtures), join(events, `${readFileSync(new URL('valid/sms-alphanumeric-sender.evt', fixtures)).toString('latin1').split(tab)[2]}.evt`));

  const child = spawn(process.execPath, [INDEX], { env: { ...environ(home), ASTER_TELEGRAM_API: tg.url }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, 'close');
  try {
    const deadline = Date.now() + 15_000;
    while (tg.messages().length < 2) {
      assert.ok(Date.now() < deadline && child.exitCode === null, `messages ${JSON.stringify(tg.messages())}: ${stdout}${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 2500)); // more ticks and rescans: nothing else may arrive
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 0, stdout + stderr);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await tg.close();
  }
  const endedAt = Number(BigInt((missed[2] ?? '').split('-')[0] ?? '0') / 1_000_000n);
  const time = new Date(endedAt).toISOString().replace('T', ' ').slice(0, 19);
  assert.deepEqual(tg.messages().sort((a, b) => String(a.text).localeCompare(String(b.text))), [
    // The controller's own host name, as it is on an appliance, where the container shares the host's (docker-compose.yml).
    { chatId: '111222333', text: `[${hostname()}] Missed call cap_noanswer from +375290000100 [${time} +00:00] (no answer)` },
    { chatId: '111222333', text: `[${hostname()}] SMS gsm2 from MTS Bank [2026-09-10 12:35:01 +03:00]\nKod 4821. Nikomu ne soobshchayte.` },
  ]);
  assert.equal(tg.requests.length, 2);
  const db = new DatabaseSync(join(home, 'state', 'aster.db'), { readOnly: true });
  try {
    const count = (/** @type {string} */ sql) => Number(db.prepare(sql).get()?.n);
    assert.equal(count('SELECT count(*) AS n FROM events'), 4);
    assert.equal(count('SELECT count(*) AS n FROM calls'), 2);
    assert.equal(count("SELECT count(*) AS n FROM notifications WHERE status = 'sent'"), 2);
    assert.equal(count('SELECT count(*) AS n FROM notifications'), 2);
  } finally {
    db.close();
  }
  assert.deepEqual(readdirSyncSafe(events), []);
});

test('sms: the booted controller marks an attempt left submitting uncertain and applies a driver Report event from AMI', async () => {
  const home = makeHome('sms');
  writeFileSync(join(home, 'config', 'secrets.env'), 'ASTER_AMI_SECRET=test\n', { mode: 0o600 });
  writeFileSync(join(home, 'config', 'aster.yaml'), ['version: 1', 'modems:', '  - { id: gsm9, driver: quectel, imei: "000000000000114", enabled: false }', 'phones: []', ''].join('\n'));
  const check = runSync(home, ['--check']);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const seed = new DatabaseSync(join(home, 'state', 'aster.db'));
  try {
    const at = Date.now();
    seed.exec('BEGIN IMMEDIATE');
    seed.prepare("INSERT INTO sms_outbox (id, modem_id, number, text, status, attempt_no, created_at, updated_at) VALUES (1, 'gsm9', '+1234567890', 'sent before the restart', 'submitted', 1, ?, ?)").run(at, at);
    seed.prepare("INSERT INTO sms_attempts (outbox_id, attempt_no, submitted_at, ami_result, status) VALUES (1, 1, ?, '[gsm9] SMS queued for send', 'submitted')").run(at);
    seed.prepare("INSERT INTO sms_outbox (id, modem_id, number, text, status, attempt_no, created_at, updated_at) VALUES (2, 'gsm9', '+375291234568', 'interrupted', 'submitting', 1, ?, ?)").run(at, at);
    seed.prepare("INSERT INTO sms_attempts (outbox_id, attempt_no, submitted_at, status) VALUES (2, 1, ?, 'submitting')").run(at);
    seed.prepare("INSERT INTO operations (kind, modem_id, status, params_json, actor, created_at, started_at) VALUES ('sms-send', 'gsm9', 'running', '{\"outbox_id\":2}', 'admin', ?, ?)").run(at, at);
    seed.exec('COMMIT');
  } finally {
    seed.close();
  }
  let reported = false;
  // a booted Asterisk whose ShowDevices lists are empty; the first list request is followed by a status report for attempt 1:1
  const ami = await fakeAmi([asterisk((request, conn) => {
    const action = request.get('Action') ?? '';
    if (!/^(Quectel|Dongle)ShowDevices$/.test(action)) return undefined;
    const id = request.get('ActionID') ?? '';
    if (!reported) {
      reported = true;
      conn.send(packet(['Event: QuectelReport', 'Privilege: call,all', 'Device: gsm9', 'Payload: 1:1', 'SCTS: 2026-09-11 12:00:05 +03:00', 'DT: 2026-09-11 12:00:09 +03:00', 'Success: 1', 'Type: 1', 'Report: 000,']));
    }
    return packet(['Response: Success', `ActionID: ${id}`, 'EventList: start', 'Message: Device status list will follow'])
      + packet([`Event: ${action}Complete`, `ActionID: ${id}`, 'EventList: Complete', 'ListItems: 0']);
  })]);
  const child = spawn(process.execPath, [INDEX], { env: { ...environ(home), ASTER_AMI_PORT: String(ami.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, 'close');
  try {
    const deadline = Date.now() + 15_000;
    while (!stdout.includes('"msg":"SMS report applied"')) {
      assert.ok(Date.now() < deadline && child.exitCode === null, `no report applied: ${stdout}${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 0, stdout + stderr);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await ami.close();
  }
  const entries = logLines(stdout);
  const sweep = entries.find((entry) => entry.msg === 'SMS attempts interrupted by the restart are uncertain');
  assert.deepEqual([sweep?.level, sweep?.attempts], ['warn', 1]);
  const applied = entries.find((entry) => entry.msg === 'SMS report applied');
  assert.deepEqual([applied?.source, applied?.outbox, applied?.attempt, applied?.type, applied?.status, applied?.current], ['ami', 1, 1, 1, 'delivered', true]);
  assert.equal(entries.filter((entry) => entry.level === 'error').length, 0, stdout);
  const db = new DatabaseSync(join(home, 'state', 'aster.db'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT id, status, last_error FROM sms_outbox ORDER BY id').all().map((row) => ({ ...row })), [
      { id: 1, status: 'delivered', last_error: null },
      { id: 2, status: 'uncertain', last_error: 'the controller restarted while the SMS was being submitted; whether the driver received it is unknown' },
    ]);
    assert.deepEqual(db.prepare('SELECT outbox_id, status, report1_success, report_raw FROM sms_attempts ORDER BY outbox_id').all().map((row) => ({ ...row })), [
      { outbox_id: 1, status: 'delivered', report1_success: 1, report_raw: '000,' },
      { outbox_id: 2, status: 'uncertain', report1_success: null, report_raw: null },
    ]);
    assert.deepEqual(db.prepare("SELECT status, error FROM operations WHERE kind = 'sms-send'").all().map((row) => ({ ...row })), [
      { status: 'uncertain', error: 'the controller restarted while the SMS was being submitted; whether the driver received it is unknown' },
    ]);
  } finally {
    db.close();
  }
});

/** @param {string} dir */
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
