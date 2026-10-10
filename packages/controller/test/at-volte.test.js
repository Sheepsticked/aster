// @ts-check
// Tests for src/at/volte.js: the commands and answer parsers, and both operations through a real runner with a scripted modem
// that keeps its settings and applies them only when it restarts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { GENERIC_PROFILE, LIST_PROFILES, QUERY, createVolteOps, imsOf, latest, profilesOf, selectCommand, setCommand } from '../src/at/volte.js';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi } from './devices-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-volte-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

const REGISTRY = validate({ version: 1, modems: [
  { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true },
  { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true },
], phones: [] });
const SELECT = selectCommand(GENERIC_PROFILE);

/**
 * @param {{ mode?: number, profiles?: Array<{ name: string, selected: boolean, active: boolean }> | null, network?: boolean, state?: string,
 *   comesBack?: boolean }} [options]  network: the operator accepts VoLTE from this SIM
 */
function harness({ mode = 0, profiles = [{ name: GENERIC_PROFILE, selected: false, active: false }, { name: 'Commercial-DT', selected: false, active: false }],
  network = true, state = 'Free', comesBack = true } = {}) {
  const db = open(join(tmp, `volte-${++counter}.db`));
  migrate(db);
  const ami = new FakeDriverAmi();
  const device = ami.addDevice('gsm1', 'quectel', { state, current: 'start', desired: 'start' });
  ami.addDevice('gsm2', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
  /** the modem: the mode it keeps and the one in use, the profiles; VoLTE is ready only with both in use */
  const modem = { saved: mode, used: mode, profiles: profiles === null ? null : profiles.map((entry) => ({ ...entry })) };
  const ready = () => network && modem.used !== 2 && (modem.profiles?.some((entry) => entry.active) ?? true) && (modem.used === 1 || modem.profiles !== null);
  /** @type {Record<string, { lines?: string[], result?: 'OK' | 'ERROR' | 'TIMEOUT' | 'silent', error?: string }>} */
  const overrides = {};
  ami.at = (_device, command) => {
    if (overrides[command]) return overrides[command];
    if (command === QUERY) return { lines: [`+QCFG: "ims",${modem.saved},${ready() ? 1 : 0}`] };
    if (command === LIST_PROFILES) {
      if (modem.profiles === null) return { result: 'ERROR', error: 'ERROR' };
      return { lines: modem.profiles.map((entry, index) => `+QMBNCFG: "List",${index},${entry.selected ? 1 : 0},${entry.active ? 1 : 0},"${entry.name}",0x0501081F,201901141`) };
    }
    const set = /^AT\+QCFG="ims",([0-2])$/.exec(command);
    if (set) {
      modem.saved = Number(set[1]);
      return {};
    }
    const select = /^AT\+QMBNCFG="Select","([^"]+)"$/.exec(command);
    if (select && modem.profiles) {
      for (const entry of modem.profiles) entry.selected = entry.name === select[1];
      return {};
    }
    return { result: 'ERROR', error: 'ERROR' };
  };
  // The fake drops the device at a reset; the modem then boots with what it kept and the driver connects again.
  ami.onAction = (name) => {
    if (name !== 'QuectelReset' || !comesBack) return undefined;
    setTimeout(() => {
      modem.used = modem.saved;
      for (const entry of modem.profiles ?? []) entry.active = entry.selected;
      device.state = 'Free';
      device.current = 'start';
      ami.emitStatus('gsm1', 'Connect');
    }, 30);
    return undefined;
  };
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
  createVolteOps({ registry: () => REGISTRY, timing: { graceMs: 50, actionTimeoutMs: 500, timeoutS: 1, goneTimeoutMs: 300, backTimeoutMs: 1_000, pollMs: 10,
    readyPollMs: 10, readyReads: 3 } }).register(runner);
  runner.start();
  /** @param {string | undefined} mode @param {string} [modemId] */
  const run = (mode, modemId = 'gsm1') => runner.wait(runner.enqueue(mode === undefined
    ? { kind: 'volte-query', modemId, params: {}, actor: 'admin' }
    : { kind: 'volte', modemId, params: { mode }, actor: 'admin' }));
  const commands = () => ami.atCommands.map((entry) => entry.command);
  const resets = () => ami.calls.filter((call) => call.startsWith('QuectelReset')).length;
  return { ami, db, modem, overrides, run, commands, resets, stop: async () => { await runner.stop(); db.close(); } };
}

describe('at volte', () => {
  test('the commands, and what they read from an answer', () => {
    assert.deepEqual([setCommand('default'), setCommand('on'), setCommand('off')], ['AT+QCFG="ims",0', 'AT+QCFG="ims",1', 'AT+QCFG="ims",2']);
    assert.equal(SELECT, 'AT+QMBNCFG="Select","ROW_Generic_3GPP"');
    assert.deepEqual(imsOf(['+QCFG: "ims",1,1']), { mode: 'on', ready: true });
    assert.deepEqual(imsOf(['+QCFG: "ims",0,0']), { mode: 'default', ready: false });
    assert.deepEqual(imsOf(['+QCFG: "IMS",2']), { mode: 'off', ready: null }, 'a firmware that leaves the state out');
    assert.deepEqual(imsOf(['+QCFG: "ims",7,0']), { mode: null, ready: false }, 'a mode outside the documented ones');
    assert.equal(imsOf(['+QCFG: "nwscanmode",0']), null);
    assert.deepEqual(profilesOf(['+QMBNCFG: "List",0,1,1,"ROW_Generic_3GPP",0x0501081F,201901141', '+QMBNCFG: "List",1,0,0,"Commercial-DT",0x05010820,202406011']),
      [{ name: GENERIC_PROFILE, selected: true, active: true }, { name: 'Commercial-DT', selected: false, active: false }]);
    assert.deepEqual(profilesOf(['+QMBNCFG: "AutoSel",0']), []);
  });

  test('a query reads the mode and the profiles, sends nothing else and is what GET shows next', async () => {
    const h = harness({ mode: 1, profiles: [{ name: GENERIC_PROFILE, selected: true, active: true }] });
    try {
      const op = await h.run(undefined);
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(h.commands(), [QUERY, LIST_PROFILES]);
      const volte = /** @type {any} */ (op.result).volte;
      assert.deepEqual([volte.mode, volte.ready, volte.profile, volte.selected], ['on', true, GENERIC_PROFILE, GENERIC_PROFILE]);
      assert.deepEqual(latest(h.db, 'gsm1'), volte);
      assert.equal(latest(h.db, 'gsm2'), null);
      assert.equal(h.resets(), 0);
    } finally {
      await h.stop();
    }
  });

  test('on, with no profile in use: selects the generic one, turns VoLTE on, resets the modem and reads it ready', async () => {
    const h = harness();
    try {
      const op = await h.run('on');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(h.commands(), [QUERY, LIST_PROFILES, SELECT, setCommand('on'), QUERY, LIST_PROFILES]);
      assert.equal(h.resets(), 1);
      const result = /** @type {any} */ (op.result);
      assert.deepEqual([result.changed, result.reset], [['profile', 'mode'], true]);
      assert.deepEqual([result.volte.mode, result.volte.ready, result.volte.profile], ['on', true, GENERIC_PROFILE]);
      assert.deepEqual(latest(h.db, 'gsm1'), result.volte);
    } finally {
      await h.stop();
    }
  });

  test('on, with an operator profile in use already: only the mode changes', async () => {
    const h = harness({ profiles: [{ name: GENERIC_PROFILE, selected: false, active: false }, { name: 'Commercial-DT', selected: true, active: true }] });
    try {
      const op = await h.run('on');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.ok(!h.commands().includes(SELECT));
      assert.deepEqual(/** @type {any} */ (op.result).changed, ['mode']);
      assert.equal(/** @type {any} */ (op.result).volte.profile, 'Commercial-DT');
    } finally {
      await h.stop();
    }
  });

  test('a mode the modem has already: nothing is sent past the reads and the modem is not reset', async () => {
    const h = harness({ mode: 2 });
    try {
      const op = await h.run('off');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(h.commands(), [QUERY, LIST_PROFILES]);
      assert.deepEqual([/** @type {any} */ (op.result).changed, h.resets()], [[], 0]);
    } finally {
      await h.stop();
    }
  });

  test('off: sets the mode, resets the modem and reads it once (nothing to wait for)', async () => {
    const h = harness({ mode: 1, profiles: [{ name: GENERIC_PROFILE, selected: true, active: true }] });
    try {
      const op = await h.run('off');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(h.commands(), [QUERY, LIST_PROFILES, setCommand('off'), QUERY, LIST_PROFILES]);
      assert.deepEqual([/** @type {any} */ (op.result).volte.mode, /** @type {any} */ (op.result).volte.ready], ['off', false]);
    } finally {
      await h.stop();
    }
  });

  test('a network that does not accept VoLTE: done, read again a few times, and reported not ready', async () => {
    const h = harness({ network: false });
    try {
      const op = await h.run('on');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(h.commands().filter((command) => command === QUERY).length, 1 + 3);
      assert.deepEqual([/** @type {any} */ (op.result).volte.mode, /** @type {any} */ (op.result).volte.ready], ['on', false]);
    } finally {
      await h.stop();
    }
  });

  test('a firmware without profiles: the mode alone is set', async () => {
    const h = harness({ profiles: null });
    try {
      const op = await h.run('on');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(h.commands(), [QUERY, LIST_PROFILES, setCommand('on'), QUERY, LIST_PROFILES]);
      assert.equal(/** @type {any} */ (op.result).volte.profile, null);
    } finally {
      await h.stop();
    }
  });

  test('a modem in a call is not touched', async () => {
    const h = harness({ state: 'Active' });
    try {
      const op = await h.run('on');
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'gsm1 is "Active"; VoLTE is changed only while the modem is connected and in no call');
      assert.deepEqual([h.commands(), h.resets()], [[], 0]);
    } finally {
      await h.stop();
    }
  });

  test('a mode the modem refuses: failed with its error, no reset', async () => {
    const h = harness({ profiles: [{ name: 'Commercial-DT', selected: true, active: true }] });
    h.overrides[setCommand('on')] = { result: 'ERROR', error: '+CME ERROR: operation not allowed' };
    try {
      const op = await h.run('on');
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+QCFG="ims",1: +CME ERROR: operation not allowed; VoLTE was not changed');
      assert.equal(h.resets(), 0);
    } finally {
      await h.stop();
    }
  });

  test('a modem that does not come back after the reset: uncertain, and says it keeps the setting', async () => {
    const h = harness({ comesBack: false });
    try {
      const op = await h.run('on');
      assert.equal(op.status, 'uncertain');
      assert.match(op.error ?? '', /^gsm1 restarted but was not connected again within 1 s \(Not connected\); it keeps the new setting$/);
      assert.equal(/** @type {any} */ (op.result).reset, true);
    } finally {
      await h.stop();
    }
  });

  test('VoLTE is a Quectel setting: a dongle is refused before anything is sent', async () => {
    const h = harness();
    try {
      const op = await h.run('on', 'gsm2');
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'VoLTE is a setting of Quectel modems; gsm2 uses chan_dongle');
      assert.deepEqual(h.commands(), []);
    } finally {
      await h.stop();
    }
  });
});
