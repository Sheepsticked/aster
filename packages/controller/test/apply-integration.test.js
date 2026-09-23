// @ts-check
// Integration test for src/config/apply.js and src/logs/rotate.js against a real Asterisk; skipped unless ASTER_AMI_TEST=1 and
// ASTER_APPLY_HOME is a writable copy of test-config mounted into the container (see the CI workflow asterisk-image.yml).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AmiClient } from '../src/ami/client.js';
import { sha256 } from '../src/config/atomic.js';
import { createConfigOps, sectionNames } from '../src/config/apply.js';
import { GENERATED_FILES, generateAll } from '../src/config/generators.js';
import { readPrev } from '../src/config/prev.js';
import { load, parse } from '../src/config/registry.js';
import { checkLog, rotatedFiles } from '../src/logs/rotate.js';
import { createBus } from '../src/bus.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_CONFIG = join(REPO, 'docker/asterisk/test-config');
const TEST_REGISTRY = join(REPO, 'docker/asterisk/test-registry.yaml');
const enabled = process.env.ASTER_AMI_TEST === '1' && Boolean(process.env.ASTER_APPLY_HOME);
const host = process.env.ASTER_AMI_HOST ?? '127.0.0.1';
const port = Number(process.env.ASTER_AMI_PORT ?? '5038');
const CONNECT_WITHIN_MS = 30_000;
/** Real Asterisk timing; generous for arm64 under QEMU. */
const TIMING = { settleMs: 1_500, actionTimeoutMs: 30_000, deviceTimeoutMs: 60_000, devicePollMs: 1_000, restartTimeoutMs: 300_000 };

describe('apply integration', { skip: !enabled && 'set ASTER_AMI_TEST=1 and ASTER_APPLY_HOME with the writable test-config container running (see the file header)' }, () => {
  const home = String(process.env.ASTER_APPLY_HOME);
  const configDir = join(home, 'config', 'asterisk');
  const paths = { configDir, registry: join(home, 'config', 'aster.yaml'), prevDir: join(home, 'state', 'prev'), asteriskLog: join(home, 'logs', 'asterisk', 'full') };
  /** @type {AmiClient} */
  let client;
  /** the names of every action sent, in order @type {string[]} */
  const sent = [];
  /** @type {import('node:sqlite').DatabaseSync} */
  let db;
  /** @type {import('../src/ops/runner.js').Runner} */
  let runner;
  /** @param {string} name */
  const read = (name) => readFileSync(join(configDir, name), 'utf8');
  /** @param {string} name */
  const original = (name) => readFileSync(join(TEST_CONFIG, name), 'utf8');
  /**
   * @param {string} kind
   * @param {Record<string, unknown>} params
   */
  const run = (kind, params) => runner.wait(runner.enqueue({ kind, modemId: null, params, actor: 'admin' }));

  before(async () => {
    assert.ok(existsSync(join(configDir, 'extensions.conf')), `${configDir} must hold the container's configuration`);
    assert.ok(existsSync(paths.asteriskLog), `${paths.asteriskLog} must be the container's log`);
    for (const name of ['extensions.conf', 'modules.conf', 'rtp.conf', ...GENERATED_FILES]) assert.equal(read(name), original(name), `${name} must start as in test-config`);
    client = new AmiClient({ backoffMinMs: 200, backoffMaxMs: 2_000 });
    const action = client.action.bind(client);
    client.action = (name, headers, options) => {
      sent.push(name === 'Command' ? `Command: ${String(headers?.Command)}` : name);
      return action(name, headers, options);
    };
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no AMI login at ${host}:${port} within ${CONNECT_WITHIN_MS} ms: ${client.lastError?.message ?? 'no answer'}`)), CONNECT_WITHIN_MS);
    });
    try {
      await Promise.race([client.connect({ host, port, username: 'aster', secret: 'test' }), deadline]);
    } finally {
      clearTimeout(timer);
    }
    mkdirSync(join(home, 'state'), { recursive: true });
    rmSync(paths.prevDir, { recursive: true, force: true });
    writeFileSync(paths.registry, readFileSync(TEST_REGISTRY));
    db = open(join(home, 'state', 'apply-integration.db'));
    migrate(db);
    runner = createRunner({ db, ami: client, bus: createBus() });
    createConfigOps({ paths, timing: TIMING }).register(runner);
    runner.start();
  });

  after(async () => {
    try {
      // put test-config back and make Asterisk read it again
      for (const name of ['extensions.conf', 'modules.conf', 'rtp.conf', ...GENERATED_FILES]) writeFileSync(join(configDir, name), original(name));
      if (client.connected) {
        await client.command('dialplan reload');
        await client.command('module reload res_pjsip.so');
        await client.action('QuectelReload', { When: 'gracefully' });
        await client.action('DongleReload', { When: 'gracefully' });
      }
    } finally {
      await runner?.stop();
      db?.close();
      await client?.close();
    }
  });

  test('a new modem and phone: the changed files are written, reloaded in map order and verified in Asterisk', { timeout: 300_000 }, async () => {
    const registry = /** @type {any} */ (structuredClone(parse(readFileSync(TEST_REGISTRY, 'utf8'))));
    registry.modems.push({ id: 'gsm_added', driver: 'quectel', imei: '000000000000009', enabled: false, ring: ['599'], group: 3 });
    registry.phones.push({ number: '596', secret: '596', outbound: 'gsm_added' });
    const op = await run('registry-apply', { registry, base_hash: load(paths.registry).hash });
    assert.equal(op.status, 'done', op.error ?? '');
    const result = /** @type {Record<string, any>} */ (op.result);
    assert.deepEqual(result.files_written, ['aster.d/globals.conf', 'aster.d/modems.conf', 'aster.d/phones.conf', 'aster.d/quectel-devices.conf']);
    assert.deepEqual(result.actions, ['Command: dialplan reload', 'Command: module reload res_pjsip.so', 'QuectelReload']);
    assert.deepEqual(result.log, []);
    const generated = generateAll(registry);
    for (const name of GENERATED_FILES) assert.equal(read(name), generated[name], name);
    assert.deepEqual(result.verified.contexts, sectionNames(generated['aster.d/modems.conf'] ?? ''));
    assert.deepEqual(result.verified.endpoints, ['599', '598', '597', '596']);
    assert.deepEqual(result.verified.devices, { quectel: ['gsm_added', 'gsm_test', 'gsm_uac', 'gsm_unmapped'] });
    assert.equal(load(paths.registry).registry.modems.length, 6);
    // seen from Asterisk itself
    // Taken from what the generator just wrote, so a change to the dial options cannot leave this assertion behind.
    const ringDial = /\[aster-ring-gsm_added\][\s\S]*?^exten => s,1,(Dial\(.*\))$/m.exec(generated['aster.d/modems.conf'] ?? '')?.[1];
    assert.ok(ringDial, 'the generated ring group has a Dial line');
    assert.ok((await client.command('dialplan show aster-ring-gsm_added')).join('\n').includes(ringDial),
      `Asterisk did not load ${ringDial}`);
    assert.match((await client.command('pjsip show endpoint 596')).join('\n'), /Endpoint:\s+596\/596/);
    const devices = await client.list('QuectelShowDevices', {}, 'QuectelShowDevicesComplete');
    assert.ok(devices.some((entry) => entry.get('Device') === 'gsm_added'), 'chan_quectel lists gsm_added');
  });

  test('a recipient-only change writes the registry and sends zero AMI actions', { timeout: 60_000 }, async () => {
    const before = sent.length;
    const registry = /** @type {any} */ (structuredClone(load(paths.registry).registry));
    registry.telegram.default_recipients = ['424242'];
    registry.modems[0].recipients = ['424242'];
    const op = await run('registry-apply', { registry, base_hash: load(paths.registry).hash });
    assert.equal(op.status, 'done', op.error ?? '');
    assert.deepEqual(op.result?.files_written, []);
    assert.deepEqual(op.result?.actions, []);
    assert.equal(sent.length, before, `no AMI action was sent (${sent.slice(before).join(', ')})`);
    assert.deepEqual(load(paths.registry).registry.telegram.default_recipients, ['424242']);
  });

  test('a lint-clean extensions.conf that pbx_config rejects: the WARNING lines are detected, the previous copy restored, the operation fails with the lines', { timeout: 120_000 }, async () => {
    const current = read('extensions.conf');
    const broken = `${current}\n[bad-ctx]\nexten => 100,1,NoOp()\nexten => 100,1,NoOp()\n`;
    const op = await run('config-apply', { name: 'extensions.conf', content: broken, base_hash: sha256(current) });
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'extensions.conf was not applied: Asterisk logged 2 problem line(s); the previous version is back');
    const log = /** @type {string[]} */ (op.result?.log);
    assert.equal(log.length, 2, log.join('\n'));
    assert.match(String(log[0]), /WARNING\[\d+\] pbx\.c: Unable to register extension '100' priority 1 in 'bad-ctx', already in use$/);
    assert.match(String(log[1]), /WARNING\[\d+\] pbx_config\.c: Unable to register extension at line \d+ of extensions\.conf$/);
    assert.equal(op.result?.restored, true);
    assert.deepEqual(op.result?.restore_log, []);
    assert.equal(read('extensions.conf'), current);
    assert.equal(readPrev(paths.prevDir, 'extensions.conf')?.text, current);
    await assert.rejects(client.command('dialplan show bad-ctx'), /There is no existence of 'bad-ctx' context/);
  });

  test('a crash mid-write (fault-injected rename) leaves the file intact, no temporary file behind, nothing reloaded', { timeout: 60_000 }, async () => {
    const current = read('extensions.conf');
    const before = sent.length;
    mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    let op;
    try {
      op = await run('config-apply', { name: 'extensions.conf', content: `${current}\n[ok-ctx]\nexten => s,1,Hangup()\n`, base_hash: sha256(current) });
    } finally {
      mock.restoreAll();
    }
    assert.equal(op.status, 'failed');
    assert.match(String(op.error), /^cannot write .*extensions\.conf \(nothing was replaced\): EIO: i\/o error, rename$/);
    assert.equal(read('extensions.conf'), current);
    assert.ok(!existsSync(join(configDir, 'extensions.conf.tmp')));
    assert.ok(!readdirSync(paths.prevDir).some((name) => name.endsWith('.tmp')));
    assert.equal(sent.length, before, 'nothing was reloaded');
  });

  test('a good change applies, then config-restore brings the previous version back; both reload the dialplan', { timeout: 120_000 }, async () => {
    const current = read('extensions.conf');
    const content = `${current}\n[ok-ctx]\nexten => s,1,Hangup()\n`;
    const applied = await run('config-apply', { name: 'extensions.conf', content, base_hash: sha256(current) });
    assert.equal(applied.status, 'done', applied.error ?? '');
    assert.deepEqual(applied.result?.actions, ['Command: dialplan reload']);
    assert.match((await client.command('dialplan show ok-ctx')).join('\n'), /Context 'ok-ctx' created by 'pbx_config'/);
    const restored = await run('config-restore', { name: 'extensions.conf', base_hash: sha256(content) });
    assert.equal(restored.status, 'done', restored.error ?? '');
    assert.equal(restored.result?.hash, sha256(current));
    assert.equal(restored.result?.previous_hash, sha256(content));
    assert.equal(read('extensions.conf'), current);
    assert.equal(readPrev(paths.prevDir, 'extensions.conf')?.text, content);
    await assert.rejects(client.command('dialplan show ok-ctx'), /There is no existence of 'ok-ctx' context/);
  });

  test('log rotation: above the threshold `logger rotate` runs and the rotated files beyond `keep` are removed', { timeout: 60_000 }, async () => {
    const first = await checkLog({ ami: client, path: paths.asteriskLog, maxBytes: 100, keep: 1 });
    assert.equal(first.rotated, true, first.skipped ?? '');
    assert.ok(rotatedFiles(paths.asteriskLog).length >= 1);
    await client.command('core show uptime'); // something for the new log
    const second = await checkLog({ ami: client, path: paths.asteriskLog, maxBytes: 100, keep: 1 });
    assert.equal(second.rotated, true, second.skipped ?? '');
    assert.equal(second.removed.length, 1, JSON.stringify(second));
    assert.equal(rotatedFiles(paths.asteriskLog).length, 1);
    assert.ok(existsSync(paths.asteriskLog));
  });

  test('modules.conf with restart: true restarts Asterisk gracefully; the client reconnects and the log after the boot is clean', { timeout: 600_000 }, async () => {
    const current = read('modules.conf');
    const op = await run('config-apply', { name: 'modules.conf', content: `${current}; restart check\n`, base_hash: sha256(current), restart: true });
    assert.equal(op.status, 'done', op.error ?? '');
    assert.deepEqual(op.result?.actions, ['Command: core restart gracefully']);
    assert.equal(op.result?.restart, true);
    assert.deepEqual(op.result?.log, []);
    assert.ok(client.connected);
    assert.match((await client.command('core show uptime'))[0] ?? '', /^System uptime: /);
    assert.equal(read('modules.conf'), `${current}; restart check\n`);
    assert.equal(readPrev(paths.prevDir, 'modules.conf')?.text, current);
  });
});
