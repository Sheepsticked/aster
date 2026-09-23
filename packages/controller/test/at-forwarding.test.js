// @ts-check
// Tests for src/at/forwarding.js: commands per condition, normalize() and fromQuery(), and the operation through a real runner
// with a scripted modem that keeps a forwarding state per reason.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ACTIONS, CONDITIONS, createForwardingOps, fromQuery, mutationCommand, normalize, NUMBER, queryCommand, REASONS, TIMES } from '../src/at/forwarding.js';
import { createBus } from '../src/bus.js';
import { validate } from '../src/config/registry.js';
import { createDeviceState } from '../src/devices/state.js';
import { createRunner } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';
import { FakeDriverAmi, until } from './devices-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-fwd-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

const REGISTRY = validate({ version: 1, modems: [
  { id: 'gsm1', driver: 'quectel', imei: '490154203237518', enabled: true },
  { id: 'gsm2', driver: 'dongle', imei: '356938031234560', enabled: true },
], phones: [] });
const NUM = '+1234567890';
const QUERY = 'AT+CCFC=0,2';

/** @param {Partial<import('../src/at/client.js').Transaction>} fields */
const transaction = (fields) => /** @type {import('../src/at/client.js').Transaction} */ ({ action_id: 'at-1.2', device: 'gsm1', command: QUERY, timeout_s: 15, reply: '[gsm1] AT command queued',
  outcome: 'OK', error: null, lines: [], sent_at: 1, observed_at: 2, ...fields });

/** @param {{ connected?: boolean, stopped?: boolean }} [options] */
function harness({ connected = true, stopped = false } = {}) {
  const db = open(join(tmp, `fwd-${++counter}.db`));
  migrate(db);
  const ami = new FakeDriverAmi({ connected });
  ami.addDevice('gsm1', 'quectel', stopped ? {} : { state: 'Free', current: 'start', desired: 'start' });
  ami.addDevice('gsm2', 'dongle', { state: 'Free', current: 'start', desired: 'start' });
  /** the modem's forwarding state per reason 0–3 @type {Record<string, { enabled: boolean, number: string | null, time: number | null }>} */
  const modem = Object.fromEntries(['0', '1', '2', '3'].map((reason) => [reason, { enabled: false, number: null, time: null }]));
  /** @type {Record<string, { lines?: string[], result?: 'OK' | 'ERROR' | 'TIMEOUT' | 'silent', error?: string }>} */
  const overrides = {};
  ami.at = (_device, command) => {
    if (overrides[command]) return overrides[command];
    const match = /^AT\+CCFC=(\d),(\d)(?:,"(\+\d+)",145(?:,7,,,(\d+))?)?$/.exec(command);
    if (!match) return { result: 'ERROR', error: 'ERROR' };
    const [, reason = '', mode, number = null, time] = match;
    const covered = reason === '4' ? ['0', '1', '2', '3'] : reason === '5' ? ['1', '2', '3'] : [reason];
    const states = covered.map((code) => modem[code]).filter((state) => state !== undefined);
    if (mode === '2') {
      const state = modem[reason];
      if (!state?.enabled) return { lines: ['+CCFC: 0,255'] };
      return { lines: [`+CCFC: 1,1,"${state.number}",145${state.time ? `,,,${state.time}` : ''}`, `+CCFC: 1,2,"${state.number}",145`] };
    }
    if (mode === '1' && states.some((state) => !state.number)) return { result: 'ERROR', error: '+CME ERROR: 30' };
    for (const [index, state] of states.entries()) {
      if (mode === '3') Object.assign(state, { enabled: true, number, time: time && covered[index] === '2' ? Number(time) : null });
      else if (mode === '1') state.enabled = true;
      else if (mode === '0') state.enabled = false;
      else Object.assign(state, { enabled: false, number: null, time: null });
    }
    return {};
  };
  const runner = createRunner({ db, ami: /** @type {any} */ (ami), bus: createBus() });
  createForwardingOps({ db, registry: () => REGISTRY, timing: { graceMs: 50, actionTimeoutMs: 500, timeoutS: 1 } }).register(runner);
  runner.start();
  /** @param {Record<string, unknown>} params @param {string} [modemId] */
  const run = (params, modemId = 'gsm1') => runner.wait(runner.enqueue({ kind: 'forwarding', modemId, params, actor: 'admin' }));
  /** @param {string} [modemId] */
  const stored = (modemId = 'gsm1') => {
    const row = /** @type {any} */ (db.prepare('SELECT forwarding_json AS f FROM modem_forwarding WHERE modem_id = ?').get(modemId));
    return row?.f ? JSON.parse(row.f) : null;
  };
  return { db, ami, runner, modem, overrides, run, stored, stop: async () => { await runner.stop(); db.close(); } };
}

describe('at forwarding', () => {
  test('the verdicts are stored as one modem_forwarding row per modem, merged per condition', async () => {
    const h = harness();
    try {
      const rows = () => Number(/** @type {any} */ (h.db.prepare('SELECT count(*) AS n FROM modem_forwarding').get()).n);
      const op = await h.run({ action: 'query' });
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(Object.keys(h.stored()), ['unconditional']);
      assert.deepEqual([h.stored().unconditional.verified, h.stored().unconditional.enabled], [true, false]);
      assert.equal(rows(), 1);
      const second = await h.run({ action: 'set', reason: 'busy', number: NUM });
      assert.equal(second.status, 'done', second.error ?? '');
      assert.deepEqual(Object.keys(h.stored()), ['unconditional', 'busy'], 'the busy verdict joins the stored one');
      assert.deepEqual([h.stored().busy.verified, h.stored().busy.number, h.stored().unconditional.enabled], [true, NUM, false]);
      assert.equal(rows(), 1, 'the same row, not a second one');
    } finally {
      await h.stop();
    }
  });

  test('mutationCommand(), queryCommand(), REASONS, CONDITIONS, TIMES, NUMBER, ACTIONS', () => {
    assert.equal(mutationCommand('set', 'unconditional', NUM), `AT+CCFC=0,3,"${NUM}",145`);
    assert.equal(mutationCommand('set', undefined, NUM), `AT+CCFC=0,3,"${NUM}",145`, 'unconditional by default');
    assert.equal(mutationCommand('set', 'busy', NUM), `AT+CCFC=1,3,"${NUM}",145`);
    assert.equal(mutationCommand('set', 'no_reply', NUM, 20), `AT+CCFC=2,3,"${NUM}",145,7,,,20`);
    assert.equal(mutationCommand('set', 'not_reachable', NUM), `AT+CCFC=3,3,"${NUM}",145`);
    assert.equal(mutationCommand('set', 'conditional', NUM, 15), `AT+CCFC=5,3,"${NUM}",145,7,,,15`);
    assert.equal(mutationCommand('enable', 'no_reply'), 'AT+CCFC=2,1');
    assert.equal(mutationCommand('disable', 'conditional'), 'AT+CCFC=5,0');
    assert.equal(mutationCommand('erase', 'busy'), 'AT+CCFC=1,4');
    assert.equal(mutationCommand('enable'), 'AT+CCFC=0,1');
    assert.equal(mutationCommand('disable'), 'AT+CCFC=0,0');
    assert.equal(mutationCommand('erase'), 'AT+CCFC=0,4');
    assert.equal(mutationCommand('query', 'busy'), null);
    assert.deepEqual(CONDITIONS.map(queryCommand), ['AT+CCFC=0,2', 'AT+CCFC=1,2', 'AT+CCFC=2,2', 'AT+CCFC=3,2']);
    assert.deepEqual({ ...REASONS }, { unconditional: 0, busy: 1, no_reply: 2, not_reachable: 3, all: 4, conditional: 5 });
    assert.deepEqual([...TIMES], [5, 10, 15, 20, 25, 30]);
    assert.deepEqual([...ACTIONS], ['set', 'enable', 'disable', 'erase', 'query']);
    for (const ok of ['+1234567890', '+123456', '+123456789012345']) assert.ok(NUMBER.test(ok), ok);
    for (const bad of ['1234567890', '+12345', '+1234567890123456', '+375 29', '*21#', '']) assert.ok(!NUMBER.test(bad), bad);
  });

  test('normalize(): a verdict stored before conditions existed is the unconditional one; unknown keys and junk are dropped', () => {
    const verdict = fromQuery(transaction({ lines: ['+CCFC: 0,255'] }), 5);
    assert.deepEqual(normalize(verdict), { unconditional: verdict });
    assert.deepEqual(normalize({ busy: verdict, no_reply: null, other: verdict }), { busy: verdict });
    for (const junk of [null, 1, 'x', [], {}, { other: verdict }]) assert.equal(normalize(junk), null, JSON.stringify(junk));
  });

  test('fromQuery(): verified only for an OK answer with a usable line; the no-reply wait; error, timeout, refusal; no verdict; unparseable', () => {
    let f = fromQuery(transaction({ lines: ['+CCFC: 1,1,"+1234567890",145'] }), 5);
    assert.deepEqual(f, { verified: true, outcome: 'ok', enabled: true, number: '+1234567890', type: 145, class: 1, time: null, entries: [{ status: 1, class: 1, number: '+1234567890', type: 145, time: null }],
      lines: ['+CCFC: 1,1,"+1234567890",145'], error: null, observed_at: 5 });
    f = fromQuery(transaction({ command: 'AT+CCFC=2,2', lines: ['+CCFC: 1,1,"+1234567890",145,,,20'] }), 5);
    assert.deepEqual([f.verified, f.enabled, f.time], [true, true, 20]);
    f = fromQuery(transaction({ lines: ['+CCFC: 0,255'] }), 5);
    assert.deepEqual([f.verified, f.outcome, f.enabled, f.number, f.class, f.time], [true, 'ok', false, null, 255, null]);
    f = fromQuery(transaction({ outcome: 'ERROR', error: '+CME ERROR: 30' }), 5);
    assert.deepEqual([f.verified, f.outcome, f.enabled, f.error], [false, 'error', null, '+CME ERROR: 30']);
    f = fromQuery(transaction({ outcome: 'refused', error: 'Device not connected' }), 5);
    assert.deepEqual([f.verified, f.outcome, f.error], [false, 'error', 'Device not connected']);
    f = fromQuery(transaction({ outcome: 'TIMEOUT', error: 'timeout' }), 5);
    assert.deepEqual([f.verified, f.outcome, f.error], [false, 'timeout', 'timeout']);
    for (const outcome of /** @type {const} */ (['disconnected', 'down', 'deadline'])) {
      f = fromQuery(transaction({ outcome, error: `no verdict: ${outcome}` }), 5);
      assert.deepEqual([f.verified, f.outcome, f.error], [false, 'uncertain', `no verdict: ${outcome}`], outcome);
    }
    f = fromQuery(null, 5);
    assert.deepEqual([f.verified, f.outcome, f.error, f.lines], [false, 'uncertain', 'the query did not run', []]);
    f = fromQuery(transaction({ lines: ['+CCFC: x'] }), 5);
    assert.deepEqual([f.verified, f.outcome, f.error, f.lines], [false, 'uncertain', 'malformed +CCFC line: "+CCFC: x"', ['+CCFC: x']]);
    f = fromQuery(transaction({ lines: [] }), 5);
    assert.deepEqual([f.outcome, f.error], ['uncertain', 'the answer holds no +CCFC line']);
    f = fromQuery(transaction({ lines: ['+CCFC: 1,2,"+1",145', '+CCFC: 0,4'] }), 5);
    assert.deepEqual([f.verified, f.enabled, f.number, f.entries.length], [true, false, null, 2], 'no line covers voice: voice is not forwarded');
  });

  test('set, query, enable, disable, erase: the mutation then the query with their own ActionIDs; the result and the stored state come from the query', async () => {
    const h = harness();
    try {
      let op = await h.run({ action: 'set', number: NUM });
      assert.equal(op.status, 'done', op.error ?? '');
      let result = /** @type {any} */ (op.result);
      assert.deepEqual(h.ami.atCommands.map((c) => [c.command, c.actionId]), [[`AT+CCFC=0,3,"${NUM}",145`, `at-${op.id}.1`], [QUERY, `at-${op.id}.2`]]);
      assert.deepEqual([result.modem_id, result.driver, result.action, result.reason, result.number, result.time, result.mutation.outcome, result.mutation.command, result.queries.length, result.queries[0].outcome, result.queries[0].lines],
        ['gsm1', 'quectel', 'set', 'unconditional', NUM, null, 'OK', `AT+CCFC=0,3,"${NUM}",145`, 1, 'OK', [`+CCFC: 1,1,"${NUM}",145`, `+CCFC: 1,2,"${NUM}",145`]]);
      const verdict = result.forwarding.unconditional;
      assert.deepEqual(Object.keys(result.forwarding), ['unconditional']);
      assert.deepEqual([verdict.verified, verdict.outcome, verdict.enabled, verdict.number, verdict.type, verdict.class, verdict.entries.length], [true, 'ok', true, NUM, 145, 1, 2]);
      assert.equal(typeof result.observed_at, 'number');
      assert.deepEqual(h.stored(), result.forwarding);
      op = await h.run({ action: 'query' });
      assert.equal(op.status, 'done', op.error ?? '');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.mutation, result.number, result.queries[0].action_id, result.forwarding.unconditional.enabled, result.forwarding.unconditional.number], [null, null, `at-${op.id}.2`, true, NUM]);
      assert.equal(h.ami.atCommands.length, 3);
      op = await h.run({ action: 'disable' });
      assert.equal(op.status, 'done', op.error ?? '');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.mutation.command, result.forwarding.unconditional.enabled, result.forwarding.unconditional.number, result.forwarding.unconditional.class], ['AT+CCFC=0,0', false, null, 255]);
      assert.deepEqual([h.stored().unconditional.enabled, h.stored().unconditional.observed_at], [false, result.forwarding.unconditional.observed_at]);
      op = await h.run({ action: 'enable' });
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual([/** @type {any} */ (op.result).mutation.command, /** @type {any} */ (op.result).forwarding.unconditional.enabled], ['AT+CCFC=0,1', true]);
      op = await h.run({ action: 'erase' });
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual([/** @type {any} */ (op.result).mutation.command, /** @type {any} */ (op.result).forwarding.unconditional.enabled, h.modem['0']?.number], ['AT+CCFC=0,4', false, null]);
      // enable without a stored number: the modem rejects it, the query still runs and the stored state is the verified one
      op = await h.run({ action: 'enable' });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CCFC=0,1: +CME ERROR: 30');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.mutation.outcome, result.mutation.error, result.queries[0].outcome, result.forwarding.unconditional.verified, result.forwarding.unconditional.enabled],
        ['ERROR', '+CME ERROR: 30', 'OK', true, false]);
      assert.equal(h.ami.atCommands.at(-1)?.command, QUERY);
      assert.deepEqual(h.stored(), result.forwarding);
      // the dongle modem uses its own action
      op = await h.run({ action: 'query' }, 'gsm2');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(h.ami.calls.at(-1), 'DongleAtCommand gsm2');
      assert.deepEqual(h.stored('gsm2').unconditional.verified, true);
    } finally {
      await h.stop();
    }
  });

  test('no reply with a wait, conditional (busy, no reply, unreachable at once) and a query of all four conditions', async () => {
    const h = harness();
    try {
      let op = await h.run({ action: 'set', reason: 'no_reply', number: NUM, time: 20 });
      assert.equal(op.status, 'done', op.error ?? '');
      let result = /** @type {any} */ (op.result);
      assert.deepEqual(h.ami.atCommands.map((c) => [c.command, c.actionId]), [[`AT+CCFC=2,3,"${NUM}",145,7,,,20`, `at-${op.id}.1`], ['AT+CCFC=2,2', `at-${op.id}.2`]]);
      assert.deepEqual([result.reason, result.time, Object.keys(result.forwarding)], ['no_reply', 20, ['no_reply']]);
      assert.deepEqual([result.forwarding.no_reply.enabled, result.forwarding.no_reply.number, result.forwarding.no_reply.time], [true, NUM, 20]);
      const other = '+375297654321';
      const before = h.ami.atCommands.length;
      op = await h.run({ action: 'set', reason: 'conditional', number: other, time: 15 });
      assert.equal(op.status, 'done', op.error ?? '');
      result = /** @type {any} */ (op.result);
      assert.deepEqual(h.ami.atCommands.slice(before).map((c) => [c.command, c.actionId]), [
        [`AT+CCFC=5,3,"${other}",145,7,,,15`, `at-${op.id}.1`], ['AT+CCFC=1,2', `at-${op.id}.2`], ['AT+CCFC=2,2', `at-${op.id}.3`], ['AT+CCFC=3,2', `at-${op.id}.4`],
      ]);
      assert.deepEqual(Object.keys(result.forwarding), ['busy', 'no_reply', 'not_reachable']);
      assert.deepEqual(Object.values(result.forwarding).map((f) => [f.enabled, f.number, f.time]), [[true, other, null], [true, other, 15], [true, other, null]]);
      assert.deepEqual(Object.keys(h.stored()), ['no_reply', 'busy', 'not_reachable']);
      op = await h.run({ action: 'disable', reason: 'busy' });
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual([h.stored().busy.enabled, h.stored().no_reply.enabled], [false, true]);
      op = await h.run({ action: 'query', reason: 'all' });
      assert.equal(op.status, 'done', op.error ?? '');
      result = /** @type {any} */ (op.result);
      assert.deepEqual(result.queries.map((/** @type {any} */ q) => [q.command, q.action_id]),
        [['AT+CCFC=0,2', `at-${op.id}.2`], ['AT+CCFC=1,2', `at-${op.id}.3`], ['AT+CCFC=2,2', `at-${op.id}.4`], ['AT+CCFC=3,2', `at-${op.id}.5`]]);
      assert.deepEqual(Object.entries(result.forwarding).map(([key, f]) => [key, f.enabled]), [['unconditional', false], ['busy', false], ['no_reply', true], ['not_reachable', true]]);
      assert.deepEqual(h.stored(), { ...result.forwarding });
      op = await h.run({ action: 'erase', reason: 'conditional' });
      assert.equal(op.status, 'done', op.error ?? '');
      assert.deepEqual(Object.values(/** @type {any} */ (op.result).forwarding).map((f) => [f.enabled, f.number]), [[false, null], [false, null], [false, null]]);
    } finally {
      await h.stop();
    }
  });

  test('a rejected query does not stop the round (failed with its text); a query the modem does not answer ends it and keeps what was stored', async () => {
    const h = harness();
    try {
      let op = await h.run({ action: 'query', reason: 'all' });
      assert.equal(op.status, 'done', op.error ?? '');
      h.overrides['AT+CCFC=1,2'] = { result: 'ERROR', error: '+CME ERROR: 3' };
      op = await h.run({ action: 'query', reason: 'all' });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CCFC=1,2: +CME ERROR: 3');
      let result = /** @type {any} */ (op.result);
      assert.deepEqual(Object.entries(result.forwarding).map(([key, f]) => [key, f.outcome]), [['unconditional', 'ok'], ['busy', 'error'], ['no_reply', 'ok'], ['not_reachable', 'ok']]);
      const first = h.stored();
      h.overrides['AT+CCFC=1,2'] = { result: 'TIMEOUT' };
      op = await h.run({ action: 'query', reason: 'all' });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CCFC=1,2: timeout');
      result = /** @type {any} */ (op.result);
      assert.deepEqual(result.queries.map((/** @type {any} */ q) => q.command), ['AT+CCFC=0,2', 'AT+CCFC=1,2'], 'no query after a timeout');
      assert.deepEqual(Object.keys(result.forwarding), ['unconditional', 'busy']);
      assert.deepEqual([h.stored().busy.outcome, h.stored().no_reply, h.stored().not_reachable], ['timeout', first.no_reply, first.not_reachable], 'a query that did not run keeps the stored verdict');
      // after a mutation, what it covers but no query read is not verified any more
      h.overrides['AT+CCFC=1,2'] = { result: 'silent' };
      op = await h.run({ action: 'disable', reason: 'conditional' });
      assert.equal(op.status, 'uncertain');
      assert.match(op.error ?? '', /^AT\+CCFC=1,2: no AtDone within 1 s/);
      result = /** @type {any} */ (op.result);
      assert.deepEqual(Object.entries(result.forwarding).map(([key, f]) => [key, f.outcome, f.error]),
        [['busy', 'uncertain', result.forwarding.busy.error], ['no_reply', 'uncertain', 'the query did not run'], ['not_reachable', 'uncertain', 'the query did not run']]);
      assert.deepEqual(h.stored().not_reachable.error, 'the query did not run');
    } finally {
      await h.stop();
    }
  });

  test('a rejected or timed-out query is failed with an unverified state; a mutation timeout is failed and the query runs; a refusal skips the query; no verdict is uncertain', async () => {
    const h = harness();
    try {
      h.overrides[QUERY] = { result: 'ERROR', error: '+CME ERROR: 30' };
      let op = await h.run({ action: 'query' });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CCFC=0,2: +CME ERROR: 30');
      let result = /** @type {any} */ (op.result);
      assert.deepEqual([result.forwarding.unconditional.verified, result.forwarding.unconditional.outcome, result.forwarding.unconditional.error], [false, 'error', '+CME ERROR: 30']);
      assert.deepEqual(h.stored(), result.forwarding);
      h.overrides[QUERY] = { result: 'TIMEOUT' };
      op = await h.run({ action: 'query' });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CCFC=0,2: timeout');
      assert.deepEqual([/** @type {any} */ (op.result).forwarding.unconditional.outcome, h.stored().unconditional.outcome], ['timeout', 'timeout']);
      delete h.overrides[QUERY];
      h.overrides['AT+CCFC=0,0'] = { result: 'TIMEOUT' };
      h.overrides[QUERY] = { result: 'ERROR', error: 'queue flushed' };
      op = await h.run({ action: 'disable' });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CCFC=0,0: no final line within 1 s; the driver restarts the modem after an AT timeout');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.mutation.outcome, result.queries[0].outcome, result.queries[0].error, result.forwarding.unconditional.outcome], ['TIMEOUT', 'ERROR', 'queue flushed', 'error']);
      delete h.overrides[QUERY];
      delete h.overrides['AT+CCFC=0,0'];
      h.overrides['AT+CCFC=0,1'] = { result: 'silent' };
      const before = h.ami.atCommands.length;
      op = await h.run({ action: 'enable' });
      assert.equal(op.status, 'uncertain');
      assert.equal(op.error, 'AT+CCFC=0,1: no AtDone within 1 s + 0.05 s; whether the modem changed the forwarding is unknown');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.mutation.outcome, result.queries, result.forwarding.unconditional.outcome, result.forwarding.unconditional.error], ['deadline', [], 'uncertain', 'the query did not run']);
      assert.equal(h.ami.atCommands.length - before, 1, 'no query after a mutation without a verdict');
      assert.deepEqual(h.stored(), result.forwarding);
      delete h.overrides['AT+CCFC=0,1'];
      h.overrides[QUERY] = { lines: ['+CCFC: x'] };
      op = await h.run({ action: 'query' });
      assert.equal(op.status, 'uncertain');
      assert.equal(op.error, 'AT+CCFC=0,2: malformed +CCFC line: "+CCFC: x"; the forwarding state is not verified');
      h.overrides[QUERY] = { lines: ['+CSQ: 1,1'] };
      op = await h.run({ action: 'query' });
      assert.equal(op.status, 'uncertain');
      assert.equal(op.error, 'AT+CCFC=0,2: the answer holds no +CCFC line; the forwarding state is not verified');
      h.overrides[QUERY] = { result: 'silent' };
      const pending = h.run({ action: 'query' });
      await until(() => h.ami.atCommands.at(-1)?.command === QUERY && h.ami.atCommands.length === before + 4);
      h.ami.emitStatus('gsm1', 'Disconnect');
      op = await pending;
      assert.equal(op.status, 'uncertain');
      assert.match(op.error ?? '', /the device disconnected before the command completed; the forwarding state is not verified/);
      assert.deepEqual(h.stored().unconditional.outcome, 'uncertain');
    } finally {
      await h.stop();
    }
  });

  test('a stopped device refuses the mutation: failed, no query, the stored state unverified; AMI down; parameter checks send nothing', async () => {
    const h = harness({ stopped: true });
    try {
      let op = await h.run({ action: 'set', number: NUM });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, `AT+CCFC=0,3,"${NUM}",145: Device not connected`);
      let result = /** @type {any} */ (op.result);
      assert.deepEqual([result.mutation.outcome, result.queries, result.forwarding.unconditional.verified, result.forwarding.unconditional.error], ['refused', [], false, 'the query did not run']);
      assert.deepEqual(h.stored(), result.forwarding);
      op = await h.run({ action: 'query' });
      assert.equal(op.status, 'failed');
      assert.equal(op.error, 'AT+CCFC=0,2: Device not connected');
      result = /** @type {any} */ (op.result);
      assert.deepEqual([result.queries[0].outcome, result.forwarding.unconditional.outcome, result.forwarding.unconditional.error], ['refused', 'error', 'Device not connected']);
      const sent = h.ami.calls.length;
      op = await h.run({ action: 'forward' });
      assert.match(op.error ?? '', /action must be one of set, enable, disable, erase, query, not "forward"/);
      op = await h.run({ action: 'query', reason: 'sometimes' });
      assert.match(op.error ?? '', /reason must be one of unconditional, busy, no_reply, not_reachable, all, conditional, not "sometimes"/);
      op = await h.run({ action: 'disable', reason: 'all' });
      assert.match(op.error ?? '', /reason "all" is only for a query/);
      op = await h.run({ action: 'set', reason: 'busy', number: NUM, time: 20 });
      assert.match(op.error ?? '', /a wait applies only to no_reply and conditional, not busy/);
      op = await h.run({ action: 'set', reason: 'no_reply', number: NUM, time: 7 });
      assert.match(op.error ?? '', /time must be one of 5, 10, 15, 20, 25, 30 seconds, not 7/);
      op = await h.run({ action: 'set' });
      assert.match(op.error ?? '', /set needs a number like \+1234567890 \(\+ and 6 to 15 digits\), not undefined/);
      op = await h.run({ action: 'set', number: '1234567890' });
      assert.match(op.error ?? '', /set needs a number/);
      op = await h.run({ action: 'query' }, 'ghost');
      assert.match(op.error ?? '', /modem ghost is not in the registry/);
      op = await h.runner.wait(h.runner.enqueue({ kind: 'forwarding', modemId: null, params: { action: 'query' }, actor: 'admin' }));
      assert.match(op.error ?? '', /forwarding needs the modem id/);
      assert.equal(h.ami.calls.length, sent);
      h.ami.up = false;
      op = await h.run({ action: 'query' });
      assert.match(op.error ?? '', /not connected over AMI \(connecting\); the forwarding was not changed/);
      assert.equal(h.ami.calls.length, sent);
      // a device outside the registry with the driver given: the operation runs, nothing is stored
      h.ami.up = true;
      h.ami.addDevice('extra', 'quectel', { state: 'Free', current: 'start', desired: 'start' });
      op = await h.run({ action: 'query', driver: 'quectel' }, 'extra');
      assert.equal(op.status, 'done', op.error ?? '');
      assert.equal(h.stored('extra'), null);
    } finally {
      await h.stop();
    }
  });

  test('the state refresher keeps the stored forwarding across a refresh and reads a row stored before conditions existed', async () => {
    const h = harness();
    try {
      const op = await h.run({ action: 'set', reason: 'no_reply', number: NUM, time: 25 });
      assert.equal(op.status, 'done', op.error ?? '');
      const forwarding = /** @type {any} */ (op.result).forwarding;
      const devices = createDeviceState({ db: h.db, ami: /** @type {any} */ (h.ami), bus: createBus(), registry: () => REGISTRY, sysfsRoot: join(tmp, 'no-sys') });
      let result = await devices.refresh();
      assert.equal(result.skipped, null);
      assert.deepEqual(h.stored(), forwarding, 'the row was rewritten with the forwarding kept');
      assert.deepEqual(devices.states().get('gsm1')?.detail.forwarding, forwarding);
      assert.equal(devices.states().get('gsm2')?.detail.forwarding, null);
      assert.equal(devices.states().get('gsm1')?.state, 'ready');
      const old = fromQuery(transaction({ lines: [`+CCFC: 1,1,"${NUM}",145`] }), 9);
      h.db.prepare('UPDATE modem_forwarding SET forwarding_json = ? WHERE modem_id = ?').run(JSON.stringify(old), 'gsm1');
      result = await devices.refresh();
      assert.deepEqual(devices.states().get('gsm1')?.detail.forwarding, { unconditional: old });
    } finally {
      await h.stop();
    }
  });
});
