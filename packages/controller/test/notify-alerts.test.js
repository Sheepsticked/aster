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
 * @param {{ alerts?: boolean, alertRecipients?: string[], modems?: Array<Record<string, unknown>> }} [options]
 * @returns {Registry}
 */
function registryWith({ alerts = true, alertRecipients, modems } = {}) {
  return validate({
    version: 1,
    settings: { timezone: 'UTC' },
    telegram: { default_recipients: ['111222333'], alerts, ...(alertRecipients ? { alert_recipients: alertRecipients } : {}) },
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

/**
 * A finished (by default successful) lifecycle operation of a modem, as the operations table keeps it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ kind: string, modemId: string, at: number, status?: string }} operation
 */
function addOperation(db, { kind, modemId, at, status = 'done' }) {
  db.prepare("INSERT INTO operations (kind, modem_id, status, actor, created_at, started_at, finished_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)")
    .run(kind, modemId, status, at - 2000, at - 1000, at);
}

describe('notify alerts', () => {
  test('a modem absent for 5 min raises one alert to its recipients; back to ready raises one recovery', () => {
    assert.deepEqual([...ALERT_STATES], ['absent', 'no-network', 'flapping', 'stopped', 'connecting']);
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
    assert.deepEqual(alerts.check().recoveries, [], 'connecting is the same outage, not a recovery');
    publish('gsm1', 'busy');
    assert.deepEqual(alerts.check().recoveries, ['gsm1']);
    assert.deepEqual(notifications().at(-1), ['111', '[aster-test] Recovered: modem gsm1 is busy (absent since 2026-09-11 09:01:00 +00:00)']);
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

  /** @type {Array<[string, string, string]>} state, how an alert names it, how a recovery names it */
  const NEW_STATES = [
    ['flapping', 'keeps restarting', 'restarting'],
    ['stopped', 'is stopped by the driver', 'stopped'],
    ['connecting', 'cannot connect', 'not connecting'],
  ];
  for (const [state, now, past] of NEW_STATES) {
    test(`a modem ${state} for 5 min raises one alert and one recovery`, () => {
      const { alerts, publish, notifications, stored, clock } = setup();
      alerts.start();
      publish('gsm1', 'ready');
      clock.now = T0 + MIN;
      publish('gsm1', state);
      clock.now = T0 + 6 * MIN - 1;
      assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null });
      clock.now = T0 + 6 * MIN;
      assert.deepEqual(alerts.check().alerts, ['gsm1']);
      assert.deepEqual(notifications(), [['111', `[aster-test] Alert: modem gsm1 ${now} since 2026-09-11 09:01:00 +00:00`]]);
      assert.deepEqual(stored(), { ami: null, modems: { gsm1: { state, since: T0 + MIN } } });
      clock.now = T0 + 30 * MIN;
      assert.deepEqual(alerts.check().alerts, [], 'one alert per problem');
      publish('gsm1', 'ready');
      assert.deepEqual(alerts.check().recoveries, ['gsm1']);
      assert.deepEqual(notifications().at(-1), ['111', `[aster-test] Recovered: modem gsm1 is ready (${past} since 2026-09-11 09:01:00 +00:00)`]);
      assert.deepEqual(stored(), { ami: null, modems: {} });
      assert.equal(notifications().length, 2);
    });
  }

  test('one outage that moves between problem states alerts once from its first start; connecting for less than 5 min sends nothing', () => {
    const { alerts, publish, notifications, clock } = setup();
    alerts.start();
    publish('gsm1', 'absent');
    clock.now = T0 + 2 * MIN;
    publish('gsm1', 'connecting');
    clock.now = T0 + 4 * MIN;
    publish('gsm1', 'flapping');
    clock.now = T0 + 5 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm1']);
    assert.deepEqual(notifications(), [['111', '[aster-test] Alert: modem gsm1 keeps restarting since 2026-09-11 09:00:00 +00:00']]);
    publish('gsm1', 'ready');
    assert.deepEqual(alerts.check().recoveries, ['gsm1']);
    assert.deepEqual(notifications().at(-1), ['111', '[aster-test] Recovered: modem gsm1 is ready (restarting since 2026-09-11 09:00:00 +00:00)']);

    clock.now = T0 + 20 * MIN;
    publish('gsm2', 'connecting');
    clock.now += 5 * MIN - 1;
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null });
    publish('gsm2', 'ready');
    clock.now += 30 * MIN;
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null });
    assert.equal(notifications().length, 2);
  });

  test('disabled and the configuration states never alert', () => {
    const { alerts, publish, notifications, stored, clock } = setup();
    alerts.start();
    for (const state of ['disabled', 'duplicate-imei', 'unmapped', 'unverified']) {
      publish('gsm1', state);
      clock.now += 30 * MIN;
      assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null }, state);
    }
    assert.equal(notifications().length, 0);
    assert.equal(stored(), null);
    assert.equal([...ALERT_STATES].includes(/** @type {any} */ ('disabled')), false);
  });

  test('alert recipients get every modem and Asterisk alert and recovery instead of the modem or default recipients', () => {
    const ami = { connected: false };
    const registry = registryWith({ alertRecipients: ['900', '901'] });
    const { alerts, publish, notifications, clock } = setup({ ami, registry });
    alerts.start();
    publish('gsm1', 'stopped');
    publish('gsm2', 'flapping');
    clock.now = T0 + 5 * MIN;
    assert.deepEqual(alerts.check().alerts.sort(), ['ami', 'gsm1', 'gsm2']);
    ami.connected = true;
    publish('gsm1', 'ready');
    publish('gsm2', 'ready');
    assert.deepEqual(alerts.check().recoveries.sort(), ['ami', 'gsm1', 'gsm2']);
    const sent = notifications();
    assert.equal(sent.length, 12, 'six messages, each to both recipients');
    assert.deepEqual([...new Set(sent.map(([chat]) => chat))].sort(), ['900', '901']);
    assert.equal(sent.filter(([, text]) => String(text).includes('Alert: ')).length, 6);
    assert.equal(sent.filter(([, text]) => String(text).includes('Recovered: ')).length, 6);
  });

  test('an empty alert recipients list keeps the modem and default routing; a list set later applies from the next message', () => {
    const ami = { connected: false };
    const { alerts, publish, notifications, clock, state } = setup({ ami, registry: registryWith({ alertRecipients: [] }) });
    alerts.start();
    publish('gsm1', 'stopped');
    publish('gsm2', 'connecting');
    clock.now = T0 + 5 * MIN;
    alerts.check();
    assert.deepEqual(notifications().map(([chat]) => chat).sort(), ['111', '111222333', '111222333']);
    state.registry = registryWith({ alertRecipients: ['900'] });
    ami.connected = true;
    publish('gsm1', 'ready');
    publish('gsm2', 'ready');
    alerts.check();
    assert.deepEqual(notifications().slice(3).map(([chat]) => chat), ['900', '900', '900']);
  });

  test('a modem stopped on request does not alert; the requested stop survives a restart of the controller', () => {
    const clock = { now: T0 };
    const first = setup({ clock });
    first.alerts.start();
    first.publish('gsm1', 'ready');
    clock.now = T0 + MIN;
    first.publish('gsm1', 'stopped');
    clock.now = T0 + 2 * MIN;
    addOperation(first.db, { kind: 'modem-stop', modemId: 'gsm1', at: clock.now });
    clock.now = T0 + 11 * MIN;
    assert.deepEqual(first.alerts.check(), { alerts: [], recoveries: [], skipped: null });
    first.alerts.stop();

    clock.now = T0 + 20 * MIN;
    const second = setup({ db: first.db, clock });
    second.alerts.start();
    second.publish('gsm1', 'stopped');
    clock.now = T0 + 40 * MIN;
    assert.deepEqual(second.alerts.check(), { alerts: [], recoveries: [], skipped: null });
    assert.equal(second.notifications().length, 0);
    assert.equal(second.stored(), null);
  });

  test('a modem stopped by the driver alerts at 5 min even when other modems were stopped on request', () => {
    const { db, alerts, publish, notifications, clock } = setup();
    alerts.start();
    addOperation(db, { kind: 'modem-stop', modemId: 'gsm2', at: T0 - MIN });
    publish('gsm1', 'stopped');
    clock.now = T0 + 5 * MIN - 1;
    assert.deepEqual(alerts.check().alerts, []);
    clock.now = T0 + 5 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm1']);
    assert.deepEqual(notifications(), [['111', '[aster-test] Alert: modem gsm1 is stopped by the driver since 2026-09-11 09:00:00 +00:00']]);
  });

  test('a stop, then a start, then a stop by the driver alerts at 5 min', () => {
    const { db, alerts, publish, notifications, clock } = setup();
    alerts.start();
    addOperation(db, { kind: 'modem-stop', modemId: 'gsm1', at: T0 - 20 * MIN });
    addOperation(db, { kind: 'modem-start', modemId: 'gsm1', at: T0 - 10 * MIN });
    publish('gsm1', 'stopped');
    clock.now = T0 + 5 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm1']);
    assert.equal(notifications().length, 1);
  });

  test('a stop on request, then the modem turns absent: the alert comes 5 min after it went absent, not after the stop', () => {
    const { db, alerts, publish, notifications, clock } = setup();
    alerts.start();
    publish('gsm1', 'stopped');
    addOperation(db, { kind: 'modem-stop', modemId: 'gsm1', at: T0 + 1000 });
    clock.now = T0 + 10 * MIN;
    assert.deepEqual(alerts.check().alerts, []);
    publish('gsm1', 'absent');
    clock.now = T0 + 15 * MIN - 1;
    assert.deepEqual(alerts.check().alerts, []);
    clock.now = T0 + 15 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm1']);
    assert.deepEqual(notifications(), [['111', '[aster-test] Alert: modem gsm1 is absent since 2026-09-11 09:10:00 +00:00']]);
  });

  test('after a stop on request a start that fails leaves the modem stopped and it alerts 5 min later; a failed stop never exempts', () => {
    const { db, alerts, publish, notifications, clock } = setup();
    alerts.start();
    addOperation(db, { kind: 'modem-stop', modemId: 'gsm1', at: T0 - MIN });
    publish('gsm1', 'stopped');
    clock.now = T0 + 10 * MIN;
    assert.deepEqual(alerts.check().alerts, []);
    addOperation(db, { kind: 'modem-start', modemId: 'gsm1', at: T0 + 10 * MIN, status: 'failed' });
    clock.now = T0 + 10 * MIN + 5000;
    assert.deepEqual(alerts.check().alerts, [], 'the 5 min start with the failed start');
    clock.now = T0 + 15 * MIN + 5000;
    assert.deepEqual(alerts.check().alerts, ['gsm1']);
    assert.deepEqual(notifications(), [['111', '[aster-test] Alert: modem gsm1 is stopped by the driver since 2026-09-11 09:10:05 +00:00']]);

    publish('gsm2', 'stopped');
    addOperation(db, { kind: 'modem-stop', modemId: 'gsm2', at: clock.now, status: 'failed' });
    clock.now += 5 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm2']);
  });

  test('a stop on request after an alert was raised leaves that alert alone; every other state still alerts after a stop on request', () => {
    const { db, alerts, publish, notifications, clock } = setup();
    alerts.start();
    publish('gsm1', 'stopped');
    clock.now = T0 + 5 * MIN;
    assert.deepEqual(alerts.check().alerts, ['gsm1']);
    addOperation(db, { kind: 'modem-stop', modemId: 'gsm1', at: clock.now });
    clock.now = T0 + 30 * MIN;
    assert.deepEqual(alerts.check(), { alerts: [], recoveries: [], skipped: null }, 'neither a second alert nor a recovery');
    publish('gsm1', 'ready');
    assert.deepEqual(alerts.check().recoveries, ['gsm1']);
    assert.equal(notifications().length, 2);

    addOperation(db, { kind: 'modem-stop', modemId: 'gsm2', at: clock.now });
    for (const state of ['flapping', 'connecting', 'no-network']) {
      publish('gsm2', 'ready');
      alerts.check();
      publish('gsm2', state);
      clock.now += 5 * MIN;
      assert.deepEqual(alerts.check().alerts, ['gsm2'], state);
      publish('gsm2', 'ready');
      assert.deepEqual(alerts.check().recoveries, ['gsm2'], state);
    }
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
