// @ts-check
// Tests for src/notify/alerts.js on a migrated database with a scripted AMI state and a clock the test moves: one alert per
// problem, one recovery, and the state kept across restarts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { ALERT_STATES, createAlerts, DEFAULTS, SETTINGS_KEY } from '../src/notify/alerts.js';
import { migrate, open } from '../src/store/db.js';

/** @typedef {import('../src/config/registry.js').Registry} Registry */

const T0 = Date.UTC(2026, 8, 11, 9, 0, 0);
const MIN = 60_000;

const tmp = mkdtempSync(join(tmpdir(), 'aster-notify-alerts-'));
/** @type {Array<() => void>} */
const cleanups = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * @param {{ alerts?: boolean, modems?: Array<Record<string, unknown>> }} [options]
 * @returns {Registry}
 */
function registryWith({ alerts = true, modems } = {}) {
  return validate({
    version: 1,
    settings: { timezone: 'UTC' },
    telegram: { default_recipients: ['111222333'], alerts },
    modems: modems ?? [
      { id: 'gsm1', driver: 'quectel', imei: '490154203237534', enabled: true, recipients: ['111'] },
      { id: 'gsm2', driver: 'dongle', imei: '490154203237542', enabled: true },
    ],
    phones: [],
  });
}

/**
 * @param {{ db?: import('node:sqlite').DatabaseSync, ami?: { connected: boolean } | null, registry?: Registry | null, clock?: { now: number } }} [options]
 */
function setup({ db, ami = { connected: true }, registry = registryWith(), clock = { now: T0 } } = {}) {
  const database = db ?? open(join(mkdtempSync(join(tmp, 'case-')), 'aster.db'));
  if (!db) {
    migrate(database);
    cleanups.push(() => database.close());
  }
  const bus = createBus();
  const state = { registry };
  const alerts = createAlerts({ db: database, bus, ami, registry: () => state.registry, now: () => clock.now, host: () => 'aster-test' });
  cleanups.unshift(() => alerts.stop());
  /** @param {string} modemId @param {string} uiState */
  const publish = (modemId, uiState) => bus.publish('modem.state', { modem_id: modemId, state: uiState });
  const notifications = () => database.prepare("SELECT chat_id, text FROM notifications WHERE source_kind = 'alert' ORDER BY id").all()
    .map((row) => [row.chat_id, row.text]);
  const stored = () => JSON.parse(String(database.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY)?.value ?? 'null'));
  return { db: database, bus, alerts, publish, notifications, stored, clock, state, ami };
}

describe('notify alerts', () => {
  test('a modem absent for 5 min raises one alert to its recipients; back to ready raises one recovery', () => {
    assert.deepEqual([...ALERT_STATES], ['absent', 'no-network']);
    assert.deepEqual({ ...DEFAULTS }, { checkMs: 5000, modemMs: 300_000, amiMs: 120_000 });
    const { alerts, publish, notifications, stored, clock } = setup();
    alerts.start();
    publish('gsm1', 'ready');
    clock.now = T0 + MIN;
    publish('gsm1', 'absent');
    clock.now = T0 + 6 * MIN - 1;
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null });
    clock.now = T0 + 6 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm1']);
    assert.deepEqual(notifications(), [['111', '[aster-test] Alert: modem gsm1 is absent since 2026-09-11 09:01:00 +00:00']]);
    assert.deepEqual(stored(), { ami: null, modems: { gsm1: { state: 'absent', since: T0 + MIN } } });
    clock.now = T0 + 30 * MIN;
    assert.deepEqual(alerts.check().alerts, [], 'one alert per problem');
    publish('gsm1', 'connecting');
    assert.deepEqual(alerts.check().recoveries, ['gsm1']);
    assert.deepEqual(notifications().at(-1), ['111', '[aster-test] Recovered: modem gsm1 is connecting (absent since 2026-09-11 09:01:00 +00:00)']);
    assert.deepEqual(stored(), { ami: null, modems: {} });
    alerts.check();
    assert.equal(notifications().length, 2);
  });

  test('absent ↔ no-network and an unverified interval keep the start of the problem; unverified is no recovery', () => {
    const { alerts, publish, notifications, clock } = setup();
    alerts.start();
    publish('gsm2', 'no-network');
    clock.now = T0 + 2 * MIN;
    publish('gsm2', 'unverified');
    clock.now = T0 + 3 * MIN;
    publish('gsm2', 'absent');
    clock.now = T0 + 5 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm2']);
    assert.deepEqual(notifications(), [['111222333', '[aster-test] Alert: modem gsm2 is absent since 2026-09-11 09:00:00 +00:00']]);
    publish('gsm2', 'unverified');
    clock.now = T0 + 20 * MIN;
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null });
    publish('gsm2', 'no-network');
    publish('gsm2', 'ready');
    assert.deepEqual(alerts.check().recoveries, ['gsm2']);
    assert.deepEqual(notifications().at(-1), ['111222333', '[aster-test] Recovered: modem gsm2 is ready (absent since 2026-09-11 09:00:00 +00:00)']);
    // a short problem never alerts
    publish('gsm2', 'no-network');
    clock.now += 4 * MIN;
    publish('gsm2', 'ready');
    clock.now += 10 * MIN;
    alerts.check();
    assert.equal(notifications().length, 2);
  });

  test('AMI not up for 2 min raises one alert to the default recipients; up again raises one recovery', () => {
    const ami = { connected: false };
    const { alerts, notifications, stored, clock } = setup({ ami });
    alerts.start();
    clock.now = T0 + 2 * MIN - 1;
    assert.deepEqual(alerts.check().alerts, []);
    clock.now = T0 + 2 * MIN;
    assert.deepEqual(alerts.check().alerts, ['ami']);
    assert.deepEqual(notifications(), [['111222333', '[aster-test] Alert: Asterisk is unreachable (no AMI connection) since 2026-09-11 09:00:00 +00:00']]);
    assert.deepEqual(stored().ami, { since: T0 });
    clock.now = T0 + 10 * MIN;
    alerts.check();
    ami.connected = true;
    assert.deepEqual(alerts.check().recoveries, ['ami']);
    assert.deepEqual(notifications().at(-1), ['111222333', '[aster-test] Recovered: Asterisk is reachable again (unreachable since 2026-09-11 09:00:00 +00:00)']);
    // a drop seen by one check and gone by the next is no alert
    ami.connected = false;
    clock.now += MIN;
    alerts.check();
    ami.connected = true;
    clock.now += 5 * MIN;
    alerts.check();
    assert.equal(notifications().length, 2);
  });

  test('without AMI there is no Asterisk alert', () => {
    const { alerts, notifications, clock } = setup({ ami: null });
    alerts.start();
    clock.now = T0 + 60 * MIN;
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null });
    assert.equal(notifications().length, 0);
  });

  test('with alerts off nothing is sent or activated; turning them on during a long problem alerts at the next check; a recovery while off is silent', () => {
    const ami = { connected: false };
    const { alerts, publish, notifications, stored, clock, state } = setup({ ami, registry: registryWith({ alerts: false }) });
    alerts.start();
    publish('gsm1', 'absent');
    clock.now = T0 + 30 * MIN;
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null });
    assert.equal(notifications().length, 0);
    assert.equal(stored(), null, 'nothing active, nothing stored');
    state.registry = registryWith({ alerts: true });
    assert.deepEqual(alerts.check().alerts.sort(), ['ami', 'gsm1']);
    assert.deepEqual(notifications(), [
      ['111222333', '[aster-test] Alert: Asterisk is unreachable (no AMI connection) since 2026-09-11 09:00:00 +00:00'],
      ['111', '[aster-test] Alert: modem gsm1 is absent since 2026-09-11 09:00:00 +00:00'],
    ]);
    state.registry = registryWith({ alerts: false });
    ami.connected = true;
    publish('gsm1', 'ready');
    assert.deepEqual(alerts.check().recoveries.sort(), ['ami', 'gsm1']);
    assert.equal(notifications().length, 2, 'no recovery message while alerts are off');
    assert.deepEqual(stored(), { ami: null, modems: {} });
  });

  test('a restart keeps the active alerts: no second alert for the same problem, and the recovery still comes', () => {
    const clock = { now: T0 };
    const first = setup({ clock });
    first.alerts.start();
    first.publish('gsm1', 'no-network');
    clock.now = T0 + 5 * MIN;
    assert.deepEqual(first.alerts.check().alerts, ['gsm1']);
    first.alerts.stop();

    clock.now = T0 + 7 * MIN;
    const second = setup({ db: first.db, clock });
    second.alerts.start();
    assert.deepEqual(second.alerts.active(), { ami: null, modems: { gsm1: { state: 'no-network', since: T0 } } });
    second.publish('gsm1', 'no-network');
    clock.now = T0 + 20 * MIN;
    assert.deepEqual(second.alerts.check().alerts, [], 'the problem that outlived the restart is not alerted again');
    second.publish('gsm1', 'ready');
    assert.deepEqual(second.alerts.check().recoveries, ['gsm1']);
    assert.deepEqual(second.notifications(), [
      ['111', '[aster-test] Alert: modem gsm1 has no GSM network since 2026-09-11 09:00:00 +00:00'],
      ['111', '[aster-test] Recovered: modem gsm1 is ready (without GSM network since 2026-09-11 09:00:00 +00:00)'],
    ]);
  });

  test('an unreadable stored value starts without active alerts; a modem removed from the registry drops its alert silently', () => {
    const { db, alerts, publish, notifications, stored, clock, state } = setup();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SETTINGS_KEY, '{not json');
    alerts.start();
    assert.deepEqual(alerts.active(), { ami: null, modems: {} });
    publish('gsm2', 'absent');
    clock.now = T0 + 5 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm2']);
    state.registry = registryWith({ modems: [{ id: 'gsm1', driver: 'quectel', imei: '490154203237534', enabled: true }] });
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null });
    assert.deepEqual(stored(), { ami: null, modems: {} });
    // re-added later: a new problem starts from its own next event
    state.registry = registryWith();
    publish('gsm2', 'absent');
    clock.now += 4 * MIN;
    assert.deepEqual(alerts.check().alerts, []);
    assert.equal(notifications().length, 1);
  });

  test('while the registry cannot be loaded the check waits and keeps its state', () => {
    const { alerts, publish, notifications, clock, state } = setup();
    alerts.start();
    publish('gsm1', 'absent');
    state.registry = null;
    clock.now = T0 + 10 * MIN;
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: 'registry' });
    state.registry = registryWith();
    assert.deepEqual(alerts.check().alerts, ['gsm1']);
    assert.equal(notifications().length, 1);
  });

  test('start() subscribes and checks on a timer; stop() ends both; a second start() is refused', async () => {
    const clock = { now: T0 };
    const db = open(join(mkdtempSync(join(tmp, 'case-')), 'aster.db'));
    migrate(db);
    cleanups.push(() => db.close());
    const bus = createBus();
    const alerts = createAlerts({ db, bus, ami: null, registry: () => registryWith(), now: () => clock.now, timing: { checkMs: 20, modemMs: 0 } });
    cleanups.unshift(() => alerts.stop());
    alerts.start();
    assert.throws(() => alerts.start(), /already started/);
    bus.publish('modem.state', { modem_id: 'gsm1', state: 'absent' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(alerts.active().modems, { gsm1: { state: 'absent', since: T0 } }, 'the timer checked');
    alerts.stop();
    bus.publish('modem.state', { modem_id: 'gsm1', state: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(Object.keys(alerts.active().modems), ['gsm1'], 'no check and no subscription after stop()');
    alerts.check();
    assert.deepEqual(Object.keys(alerts.active().modems), ['gsm1'], 'the ready state published after stop() was not seen');
  });
});
