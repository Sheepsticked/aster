// @ts-check
// Tests for src/ops/runner.js with fake handlers: stored rows, ordering per modem and the global lock, outcomes, progress,
// recovery after a restart, and stop().
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createBus } from '../src/bus.js';
import { createRunner, FINAL, GLOBAL_KINDS, OperationError } from '../src/ops/runner.js';
import { migrate, open } from '../src/store/db.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../src/bus.js').OpProgress} OpProgress */
/** @typedef {import('../src/ops/runner.js').Context} Context */
/** @typedef {import('../src/ops/runner.js').RunnerOptions} RunnerOptions */

const NOW = 1789100000000;
const RESTARTED = 'the controller restarted while the operation was running';
const tmp = mkdtempSync(join(tmpdir(), 'aster-ops-'));
/** @type {DatabaseSync[]} */
const opened = [];
after(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // closed by the test itself
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

let counter = 0;
/** A migrated database; pass the path of an earlier one to reopen it the way a restarted controller does. */
function database(path = join(tmp, `ops-${++counter}.db`)) {
  const db = open(path);
  opened.push(db);
  migrate(db);
  return { db, path };
}

/**
 * A runner with a clock that advances 1 ms per call, the op.progress payloads of its bus, and the errors given to onFatal.
 * @param {DatabaseSync} db
 * @param {Partial<RunnerOptions>} [options]
 */
function make(db, options = {}) {
  let clock = NOW;
  const bus = createBus();
  /** @type {OpProgress[]} */
  const events = [];
  bus.subscribe((event) => {
    if (event.type === 'op.progress') events.push(event.payload);
  });
  /** @type {Error[]} */
  const fatal = [];
  const runner = createRunner({ db, bus, now: () => (clock += 1), onFatal: (err) => void fatal.push(err), ...options });
  return { runner, bus, events, fatal };
}

/** A handler that logs `start <params.name>` / `end <params.name>` and finishes when the test releases that name. */
function gates() {
  /** @type {string[]} */
  const log = [];
  /** @type {Map<string, { promise: Promise<void>, open: () => void }>} */
  const gatesByName = new Map();
  /** @param {string} name */
  const gate = (name) => {
    let entry = gatesByName.get(name);
    if (!entry) {
      let open = () => {};
      const promise = new Promise((resolve) => {
        open = () => resolve(undefined);
      });
      entry = { promise, open };
      gatesByName.set(name, entry);
    }
    return entry;
  };
  let active = 0;
  let maxActive = 0;
  return {
    log,
    get maxActive() {
      return maxActive;
    },
    /** @param {string} name */
    release: (name) => gate(name).open(),
    /** @param {Context} ctx */
    handler: async (ctx) => {
      const name = String(ctx.op.params?.name);
      log.push(`start ${name}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await gate(name).promise;
        if (ctx.op.params?.fail) throw new Error(`${name} failed`);
        return { name };
      } finally {
        active -= 1;
        log.push(`end ${name}`);
      }
    },
  };
}

/**
 * @param {() => boolean} predicate
 * @param {string} what
 */
async function until(predicate, what) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

const ticks = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await tick();
};

/**
 * @param {DatabaseSync} db
 * @returns {Record<number, string>}
 */
const statuses = (db) => Object.fromEntries(db.prepare('SELECT id, status FROM operations ORDER BY id').all()
  .map((row) => [Number(row.id), String(row.status)]));

/**
 * @param {DatabaseSync} db
 * @returns {number[]}
 */
const runningIds = (db) => db.prepare("SELECT id FROM operations WHERE status = 'running' ORDER BY id").all().map((row) => Number(row.id));

/**
 * @param {Record<string, unknown> | null | undefined} result
 * @returns {Record<string, unknown>}
 */
function withoutObservedAt(result) {
  const { observed_at: observedAt, ...rest } = result ?? {};
  assert.ok(Number.isSafeInteger(observedAt), 'observed_at is epoch milliseconds');
  return rest;
}

/**
 * Every row that was interrupted or ended carries observed_at; queued and running rows have no result yet.
 * @param {DatabaseSync} db
 */
function assertObservedAt(db) {
  const rows = db.prepare('SELECT id, status, result_json FROM operations').all();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const status = String(row.status);
    if (status === 'queued' || status === 'running') {
      assert.equal(row.result_json, null, `operation ${String(row.id)} is ${status} and has no result`);
    } else {
      assert.ok(FINAL.includes(status) || status === 'interrupted', status);
      const observedAt = JSON.parse(String(row.result_json)).observed_at;
      assert.ok(Number.isSafeInteger(observedAt) && observedAt > 0, `operation ${String(row.id)} (${status}) has observed_at`);
    }
  }
}

describe('ops runner', () => {
  test('enqueue stores a queued row and returns its id; the handler gets the stored params and ctx; the row ends done with observed_at', async () => {
    const { db } = database();
    const ami = /** @type {any} */ ({ fake: 'ami' });
    const { runner, bus, events } = make(db, { ami });
    /** @type {Context[]} */
    const seen = [];
    runner.register('scan', async (ctx) => {
      seen.push(ctx);
      return { found: 2 };
    });
    runner.start();
    const params = { ports: ['1-1.3'], deep: { x: 1 } };
    const id = runner.enqueue({ kind: 'scan', params, actor: 'admin' });
    assert.equal(id, 1);
    const queued = runner.get(id);
    assert.ok(queued);
    const { created_at: createdAt, ...rest } = queued;
    assert.deepEqual(rest, { id, kind: 'scan', modem_id: null, status: 'queued', params, result: null, error: null, actor: 'admin', started_at: null,
      finished_at: null });

    const done = await runner.wait(id);
    assert.equal(seen.length, 1);
    const ctx = /** @type {Context} */ (seen[0]);
    assert.deepEqual(ctx.op, { id, kind: 'scan', modemId: null, params, actor: 'admin', createdAt, interruptedAt: null });
    assert.notEqual(ctx.op.params, params);
    assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.op));
    assert.equal(ctx.db, db);
    assert.equal(ctx.ami, ami);
    assert.equal(ctx.bus, bus);
    assert.equal(done.status, 'done');
    assert.equal(done.error, null);
    assert.deepEqual(withoutObservedAt(done.result), { found: 2 });
    const observedAt = Number(done.result?.observed_at);
    assert.ok(createdAt < Number(done.started_at) && Number(done.started_at) < observedAt && observedAt < Number(done.finished_at));
    assert.deepEqual(events.map((event) => [event.id, event.status, event.message, event.error]), [
      [id, 'queued', null, null], [id, 'running', null, null], [id, 'done', null, null],
    ]);
    assert.deepEqual(events.at(-1)?.result, done.result);
    assert.deepEqual(await runner.wait(id), done);
    assertObservedAt(db);
  });

  test('operations of one modem run one at a time in id order, and a failed one does not stop the queue', async () => {
    const { db } = database();
    const { runner } = make(db);
    const g = gates();
    runner.register('at', g.handler);
    runner.start();
    const ids = ['a', 'b', 'c', 'd'].map((name) => runner.enqueue({ kind: 'at', modemId: 'gsm1', params: { name, fail: name === 'b' }, actor: 'admin' }));
    await until(() => g.log.length === 1, 'a to start');
    g.release('c');
    await ticks();
    assert.deepEqual(g.log, ['start a']);
    assert.deepEqual(statuses(db), { 1: 'running', 2: 'queued', 3: 'queued', 4: 'queued' });
    g.release('a');
    await until(() => g.log.includes('start b'), 'b to start');
    g.release('b');
    await until(() => g.log.includes('start d'), 'd to start');
    g.release('d');
    const ops = await Promise.all(ids.map((id) => runner.wait(id)));
    assert.deepEqual(g.log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start d', 'end d']);
    assert.equal(g.maxActive, 1);
    assert.deepEqual(ops.map((op) => [op.status, op.error]), [['done', null], ['failed', 'b failed'], ['done', null], ['done', null]]);
    for (let i = 1; i < ops.length; i += 1) assert.ok(Number(ops[i]?.started_at) > Number(ops[i - 1]?.finished_at));
    assertObservedAt(db);
  });

  test('operations of different modems run in parallel; operations without a modem are serialized per kind', async () => {
    const { db } = database();
    const { runner } = make(db);
    const g = gates();
    let started = 0;
    /** @type {() => void} */
    let bothStarted = () => {};
    const barrier = new Promise((resolve) => {
      bothStarted = () => resolve(undefined);
    });
    runner.register('modem-restart', async (ctx) => {
      g.log.push(`start ${String(ctx.op.modemId)}`);
      started += 1;
      if (started === 2) bothStarted();
      await barrier;
      g.log.push(`end ${String(ctx.op.modemId)}`);
    });
    runner.register('scan', g.handler);
    runner.start();
    const restarts = ['gsm1', 'gsm2'].map((modemId) => runner.enqueue({ kind: 'modem-restart', modemId, actor: 'admin' }));
    const scans = ['s1', 's2'].map((name) => runner.enqueue({ kind: 'scan', params: { name }, actor: 'system' }));
    await until(() => g.log.includes('end gsm1') && g.log.includes('end gsm2'), 'both modem operations to run at the same time');
    assert.deepEqual(g.log.slice(0, 3).sort(), ['start gsm1', 'start gsm2', 'start s1']);
    assert.deepEqual((await Promise.all(restarts.map((id) => runner.wait(id)))).map((op) => op.status), ['done', 'done']);
    await ticks();
    assert.equal(g.log.includes('start s2'), false);
    assert.deepEqual(runningIds(db), [3]);
    g.release('s1');
    await until(() => g.log.includes('start s2'), 's2 after s1');
    g.release('s2');
    assert.deepEqual((await Promise.all(scans.map((id) => runner.wait(id)))).map((op) => op.status), ['done', 'done']);
    assert.deepEqual(g.log.filter((line) => line.endsWith('s1') || line.endsWith('s2')), ['start s1', 'end s1', 'start s2', 'end s2']);
    assertObservedAt(db);
  });

  test('a global operation waits for every running modem operation, runs alone, and operations queued after it wait for it', async () => {
    const { db } = database();
    const { runner } = make(db);
    const g = gates();
    for (const kind of ['at', 'config-apply', 'registry-apply', 'scan']) runner.register(kind, g.handler);
    runner.start();
    /**
     * @param {string} kind
     * @param {string} name
     * @param {string | null} [modemId]
     */
    const add = (kind, name, modemId = null) => runner.enqueue({ kind, modemId, params: { name }, actor: 'admin' });
    add('at', 'm1', 'gsm1');
    add('at', 'm2', 'gsm2');
    add('config-apply', 'g1');
    add('at', 'm3', 'gsm2');
    add('registry-apply', 'g2');
    add('at', 'm4', 'gsm1');
    add('scan', 's1');

    await until(() => g.log.length === 2, 'm1 and m2');
    await ticks();
    assert.deepEqual(runningIds(db), [1, 2]);
    g.release('m1');
    await until(() => g.log.includes('end m1'), 'm1 to end');
    await ticks();
    assert.deepEqual(runningIds(db), [2]);
    g.release('m2');
    await until(() => g.log.includes('start g1'), 'g1');
    await ticks();
    assert.deepEqual(runningIds(db), [3]);
    g.release('g1');
    await until(() => g.log.includes('start m3'), 'm3');
    await ticks();
    assert.deepEqual(runningIds(db), [4]);
    g.release('m3');
    await until(() => g.log.includes('start g2'), 'g2');
    await ticks();
    assert.deepEqual(runningIds(db), [5]);
    g.release('g2');
    await until(() => g.log.includes('start m4') && g.log.includes('start s1'), 'm4 and s1');
    await ticks();
    assert.deepEqual(runningIds(db), [6, 7]);
    g.release('m4');
    g.release('s1');
    await until(() => g.log.length === 14, 'every operation to end');
    assert.deepEqual(g.log, ['start m1', 'start m2', 'end m1', 'end m2', 'start g1', 'end g1', 'start m3', 'end m3', 'start g2', 'end g2',
      'start m4', 'start s1', 'end m4', 'end s1']);
    await until(() => runningIds(db).length === 0, 'the last rows to be stored');
    assert.deepEqual(Object.values(statuses(db)), Array(7).fill('done'));
    assertObservedAt(db);
  });

  test('a throw ends failed with its message; an OperationError ends uncertain or failed with a partial result; unusable results end uncertain', async () => {
    const { db } = database();
    const { runner } = make(db);
    /** @type {Record<string, () => unknown>} */
    const cases = {
      error: () => {
        throw new Error('AT+CCFC answered ERROR');
      },
      'not-an-error': () => {
        throw 'plain string';
      },
      'empty-message': () => {
        throw new Error('');
      },
      partial: () => {
        throw new OperationError('no AtDone before the deadline', { status: 'uncertain', result: { lines: ['+CCFC: 1,1'] } });
      },
      'failed-partial': () => {
        throw new OperationError('ERROR', { result: { lines: ['ERROR'] } });
      },
      'bad-partial': () => {
        throw new OperationError('x', { result: /** @type {any} */ ('text') });
      },
      string: () => 'done!',
      array: () => [1, 2],
      bigint: () => ({ n: 1n }),
      'bad-observed-at': () => ({ observed_at: 'yesterday' }),
      'observed-at': () => ({ observed_at: 1234, forwarding: { status: 'enabled' } }),
      undefined: () => undefined,
      null: () => null,
      sync: () => ({ sync: true }),
    };
    runner.register('forwarding', (ctx) => cases[String(ctx.op.params?.case)]?.());
    runner.start();
    const ids = Object.keys(cases).map((name, i) => runner.enqueue({ kind: 'forwarding', modemId: `gsm${i}`, params: { case: name }, actor: 'cli' }));
    const ops = await Promise.all(ids.map((id) => runner.wait(id)));
    const notRecorded = 'the outcome was not recorded';
    assert.deepEqual(Object.fromEntries(ops.map((op) => [op.params?.case, [op.status, op.error, withoutObservedAt(op.result)]])), {
      error: ['failed', 'AT+CCFC answered ERROR', {}],
      'not-an-error': ['failed', 'plain string', {}],
      'empty-message': ['failed', 'Error', {}],
      partial: ['uncertain', 'no AtDone before the deadline', { lines: ['+CCFC: 1,1'] }],
      'failed-partial': ['failed', 'ERROR', { lines: ['ERROR'] }],
      'bad-partial': ['uncertain', `x (the handler returned string, not a result object; ${notRecorded})`, {}],
      string: ['uncertain', `the handler returned string, not a result object; ${notRecorded}`, {}],
      array: ['uncertain', `the handler returned an array, not a result object; ${notRecorded}`, {}],
      bigint: ['uncertain', `the handler's result cannot be stored (Do not know how to serialize a BigInt); ${notRecorded}`, {}],
      'bad-observed-at': ['uncertain', 'the handler returned an observed_at that is not epoch milliseconds', {}],
      'observed-at': ['done', null, { forwarding: { status: 'enabled' } }],
      undefined: ['done', null, {}],
      null: ['done', null, {}],
      sync: ['done', null, { sync: true }],
    });
    assert.equal(ops.find((op) => op.params?.case === 'observed-at')?.result?.observed_at, 1234);
    assert.throws(() => new OperationError('x', { status: /** @type {any} */ ('done') }), {
      name: 'TypeError', message: 'an OperationError ends an operation failed or uncertain, not done',
    });
    assertObservedAt(db);
  });

  test('ctx.progress publishes op.progress while the operation runs and is ignored after it ended', async () => {
    const { db } = database();
    const { runner, events } = make(db);
    const g = gates();
    /** @type {Context[]} */
    const kept = [];
    runner.register('ussd', async (ctx) => {
      kept.push(ctx);
      ctx.progress('sent *100#');
      await g.handler(ctx);
      ctx.progress('answer received');
      return { answer: 'Balance 10' };
    });
    runner.start();
    const id = runner.enqueue({ kind: 'ussd', modemId: 'gsm1', params: { name: 'u' }, actor: 'admin' });
    await until(() => events.some((event) => event.message === 'sent *100#'), 'the first progress message');
    g.release('u');
    await runner.wait(id);
    kept[0]?.progress('late');
    await ticks();
    assert.deepEqual(events.map((e) => [e.id, e.kind, e.modem_id, e.actor, e.status, e.message, e.error]), [
      [id, 'ussd', 'gsm1', 'admin', 'queued', null, null],
      [id, 'ussd', 'gsm1', 'admin', 'running', null, null],
      [id, 'ussd', 'gsm1', 'admin', 'running', 'sent *100#', null],
      [id, 'ussd', 'gsm1', 'admin', 'running', 'answer received', null],
      [id, 'ussd', 'gsm1', 'admin', 'done', null, null],
    ]);
    assert.deepEqual(events.slice(0, -1).map((event) => event.result), [null, null, null, null]);
    assert.deepEqual(withoutObservedAt(events.at(-1)?.result), { answer: 'Balance 10' });
    assert.ok(events.every((event, i) => i === 0 || event.at > Number(events[i - 1]?.at)));
  });

  test('restart mid-operation: running rows become interrupted at start() and are re-evaluated in their queues before the queued rows run', async () => {
    const { db, path } = database();
    const first = make(db);
    const g = gates();
    for (const kind of ['modem-restart', 'at', 'scan', 'modem-stop', 'config-apply']) first.runner.register(kind, g.handler);
    first.runner.start();
    first.runner.enqueue({ kind: 'modem-restart', modemId: 'gsm1', params: { name: 'restart' }, actor: 'admin' });
    first.runner.enqueue({ kind: 'at', modemId: 'gsm2', params: { name: 'at' }, actor: 'admin' });
    first.runner.enqueue({ kind: 'scan', params: { name: 'scan' }, actor: 'system' });
    first.runner.enqueue({ kind: 'modem-stop', modemId: 'gsm1', params: { name: 'stop' }, actor: 'cli' });
    first.runner.enqueue({ kind: 'config-apply', params: { name: 'apply' }, actor: 'admin' });
    await until(() => g.log.length === 3, 'three operations to run');
    assert.deepEqual(statuses(db), { 1: 'running', 2: 'running', 3: 'running', 4: 'queued', 5: 'queued' });
    const firstStartedAt = first.runner.get(1)?.started_at;
    db.close(); // the controller dies: its handlers never finish

    const { db: db2 } = database(path);
    const second = make(db2);
    /** @type {string[]} */
    const calls = [];
    /**
     * @param {string} name
     * @returns {(ctx: Context) => Promise<Record<string, unknown>>}
     */
    const record = (name) => async (ctx) => {
      const { id, modemId, params, interruptedAt } = ctx.op;
      calls.push(`${name} #${id} ${String(modemId)} ${String(params?.name)} interruptedAt=${interruptedAt === null ? 'null' : 'set'} `
        + `row=${String(second.runner.get(id)?.status)}`);
      return { by: name };
    };
    second.runner.register('modem-restart', record('restart handler'), { reevaluate: 'rerun' });
    second.runner.register('at', record('at handler'));
    second.runner.register('scan', record('scan handler'), { reevaluate: record('scan reevaluate') });
    second.runner.register('modem-stop', record('stop handler'), { reevaluate: 'rerun' });
    second.runner.register('config-apply', record('apply handler'), { reevaluate: record('apply reevaluate') });
    assert.deepEqual(second.runner.start(), { interrupted: 3, reevaluating: 2, uncertain: 1, queued: 2, unknownKind: 0 });

    assert.deepEqual(statuses(db2), { 1: 'interrupted', 2: 'uncertain', 3: 'interrupted', 4: 'queued', 5: 'queued' });
    const interruptedAt = Number(second.runner.get(1)?.result?.interrupted_at);
    assert.deepEqual([second.runner.get(1)?.result, second.runner.get(1)?.error], [{ observed_at: interruptedAt, interrupted_at: interruptedAt }, RESTARTED]);
    assert.deepEqual([second.runner.get(2)?.result, second.runner.get(2)?.error],
      [{ observed_at: interruptedAt, interrupted_at: interruptedAt }, `${RESTARTED}; the outcome is unknown`]);
    assert.deepEqual(second.events.map((event) => [event.id, event.status]), [[1, 'interrupted'], [2, 'interrupted'], [2, 'uncertain'], [3, 'interrupted']]);
    assertObservedAt(db2);

    const ops = await Promise.all([1, 2, 3, 4, 5].map((id) => second.runner.wait(id)));
    assert.deepEqual(calls, [
      'restart handler #1 gsm1 restart interruptedAt=set row=running',
      'scan reevaluate #3 null scan interruptedAt=set row=running',
      'stop handler #4 gsm1 stop interruptedAt=null row=running',
      'apply handler #5 null apply interruptedAt=null row=running',
    ]);
    assert.deepEqual(ops.map((op) => [op.id, op.status, op.error, withoutObservedAt(op.result)]), [
      [1, 'done', null, { by: 'restart handler', interrupted_at: interruptedAt }],
      [2, 'uncertain', `${RESTARTED}; the outcome is unknown`, { interrupted_at: interruptedAt }],
      [3, 'done', null, { by: 'scan reevaluate', interrupted_at: interruptedAt }],
      [4, 'done', null, { by: 'stop handler' }],
      [5, 'done', null, { by: 'apply handler' }],
    ]);
    assert.equal(ops[0]?.started_at, firstStartedAt);
    assert.ok(Number(ops[4]?.started_at) > Number(ops[3]?.finished_at));
    assertObservedAt(db2);
  });

  test('a crash during the re-evaluation leaves the row running; the next start() interrupts and re-evaluates it again', async () => {
    const { db, path } = database();
    const never = () => new Promise(() => {});
    const first = make(db);
    first.runner.register('remap', never, { reevaluate: 'rerun' });
    first.runner.start();
    const id = first.runner.enqueue({ kind: 'remap', modemId: 'gsm1', params: { port: '1-1.3' }, actor: 'system' });
    await until(() => first.runner.get(id)?.status === 'running', 'the first run');
    db.close();

    const { db: db2 } = database(path);
    const second = make(db2);
    second.runner.register('remap', never, { reevaluate: 'rerun' });
    assert.equal(second.runner.start().reevaluating, 1);
    await until(() => second.runner.get(id)?.status === 'running', 'the re-run');
    assert.equal(second.runner.get(id)?.result, null);
    db2.close();

    const { db: db3 } = database(path);
    const third = make(db3);
    /** @type {Array<Record<string, unknown> | null>} */
    const params = [];
    third.runner.register('remap', (ctx) => void params.push(ctx.op.params), { reevaluate: 'rerun' });
    assert.deepEqual(third.runner.start(), { interrupted: 1, reevaluating: 1, uncertain: 0, queued: 0, unknownKind: 0 });
    const op = await third.runner.wait(id);
    assert.deepEqual([op.status, params], ['done', [{ port: '1-1.3' }]]);
    assert.ok(Number.isSafeInteger(op.result?.interrupted_at));
    assertObservedAt(db3);
  });

  test('at start() a kind without a handler: its queued row fails and its interrupted row becomes uncertain; register() and start() afterwards throw', async () => {
    const { db } = database();
    const insert = db.prepare('INSERT INTO operations (kind, modem_id, status, actor, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('old-kind', 'gsm1', 'running', 'admin', NOW - 3, NOW - 2);
    insert.run('old-kind', null, 'queued', 'cli', NOW - 1, null);
    insert.run('scan', null, 'queued', 'cli', NOW, null);
    const { runner } = make(db);
    runner.register('scan', () => ({ ok: true }));
    assert.deepEqual(runner.start(), { interrupted: 1, reevaluating: 0, uncertain: 0, queued: 1, unknownKind: 2 });
    assert.deepEqual([1, 2].map((id) => [runner.get(id)?.status, runner.get(id)?.error]), [
      ['uncertain', `${RESTARTED}, and no handler is registered for its kind; the outcome is unknown`],
      ['failed', 'no handler is registered for operation kind old-kind; the operation did not run'],
    ]);
    assert.equal(runner.get(1)?.started_at, NOW - 2);
    assert.equal((await runner.wait(3)).status, 'done');
    assert.throws(() => runner.register('late', () => undefined), { message: 'operation handlers must be registered before start()' });
    assert.throws(() => runner.start(), { message: 'start() can be called once (the runner is started)' });
    assertObservedAt(db);
  });

  test('stop() lets running operations finish, starts nothing more, keeps queued rows for the next start() and refuses new operations', async () => {
    const { db } = database();
    const first = make(db);
    const g = gates();
    first.runner.register('at', g.handler);
    first.runner.start();
    const a = first.runner.enqueue({ kind: 'at', modemId: 'gsm1', params: { name: 'a' }, actor: 'admin' });
    const b = first.runner.enqueue({ kind: 'at', modemId: 'gsm1', params: { name: 'b' }, actor: 'admin' });
    await until(() => g.log.length === 1, 'a to start');
    const waitA = first.runner.wait(a);
    const waitB = first.runner.wait(b);
    let stopped = false;
    const stopping = first.runner.stop().then(() => {
      stopped = true;
    });
    await assert.rejects(waitB, { message: `operation ${b} did not start before the operations runner stopped` });
    await ticks();
    assert.equal(stopped, false);
    g.release('a');
    await stopping;
    assert.equal((await waitA).status, 'done');
    g.release('b');
    await ticks();
    assert.deepEqual(g.log, ['start a', 'end a']);
    assert.equal(first.runner.get(b)?.status, 'queued');
    assert.throws(() => first.runner.enqueue({ kind: 'at', modemId: 'gsm1', actor: 'admin' }), { message: 'the operations runner is stopped; at was not queued' });
    await assert.rejects(first.runner.wait(b), { message: `operation ${b} is queued and the operations runner is stopped` });

    const second = make(db);
    second.runner.register('at', (ctx) => ({ name: ctx.op.params?.name }));
    assert.equal(second.runner.start().queued, 1);
    const op = await second.runner.wait(b);
    assert.deepEqual([op.status, withoutObservedAt(op.result)], ['done', { name: 'b' }]);
    assertObservedAt(db);
  });

  test('a failed status write stops the runner and calls onFatal; the unstored outcome is not announced, the rows keep their status and the next start() re-evaluates them', async () => {
    const { db } = database();
    const { runner, events, fatal } = make(db);
    runner.register('at', () => ({ ok: true }), { reevaluate: 'rerun' });
    runner.start();
    db.exec(`CREATE TEMP TRIGGER fail_done BEFORE UPDATE OF status ON operations WHEN NEW.status = 'done'
      BEGIN SELECT RAISE(ABORT, 'disk I/O error (simulated)'); END`);
    const a = runner.enqueue({ kind: 'at', modemId: 'gsm1', actor: 'admin' });
    const b = runner.enqueue({ kind: 'at', modemId: 'gsm1', actor: 'admin' });
    await Promise.all([runner.wait(a), runner.wait(b)].map((waiting) => assert.rejects(waiting, { message: 'disk I/O error (simulated)' })));
    assert.deepEqual(fatal.map((err) => err.message), ['disk I/O error (simulated)']);
    await ticks();
    assert.deepEqual(statuses(db), { [a]: 'running', [b]: 'queued' });
    assert.deepEqual(events.map((event) => [event.id, event.status]), [[a, 'queued'], [b, 'queued'], [a, 'running']]);
    assert.throws(() => runner.enqueue({ kind: 'at', modemId: 'gsm1', actor: 'admin' }), { message: 'the operations runner is broken; at was not queued' });
    await assert.rejects(runner.wait(b), { message: `operation ${b} is queued and the operations runner is broken` });

    db.exec('DROP TRIGGER fail_done');
    const next = make(db);
    next.runner.register('at', () => ({ ok: true }), { reevaluate: 'rerun' });
    assert.deepEqual(next.runner.start(), { interrupted: 1, reevaluating: 1, uncertain: 0, queued: 1, unknownKind: 0 });
    assert.deepEqual((await Promise.all([next.runner.wait(a), next.runner.wait(b)])).map((op) => op.status), ['done', 'done']);
    assert.deepEqual(next.fatal, []);
    assertObservedAt(db);
  });

  test('a handler that awaits inside an open transaction is detected at the next status write, which is not written into that transaction', async () => {
    const { db } = database();
    const { runner, fatal } = make(db);
    const g = gates();
    runner.register('sms-send', async (ctx) => {
      ctx.db.exec('BEGIN');
      ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'x')").run();
      await g.handler(ctx);
      ctx.db.exec('ROLLBACK');
    });
    runner.register('at', () => ({ ok: true }));
    runner.start();
    const tx = runner.enqueue({ kind: 'sms-send', modemId: 'gsm1', params: { name: 'tx' }, actor: 'admin' });
    const other = runner.enqueue({ kind: 'at', modemId: 'gsm2', actor: 'admin' });
    await until(() => fatal.length === 1, 'the fatal error');
    assert.match(fatal[0]?.message ?? '', /^a transaction is open on the database connection across an await/);
    g.release('tx');
    await until(() => !db.isTransaction, 'the handler to roll back');
    await ticks();
    assert.deepEqual(statuses(db), { [tx]: 'running', [other]: 'running' });
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'probe'").get(), undefined);
  });

  test('an operation enqueued inside a transaction that rolls back never starts, also when the next operation gets the same id', async () => {
    const { db } = database();
    const { runner } = make(db);
    /** @type {unknown[]} */
    const texts = [];
    runner.register('sms-send', (ctx) => void texts.push(ctx.op.params?.text));
    runner.start();
    db.exec('BEGIN');
    const lost = runner.enqueue({ kind: 'sms-send', modemId: 'gsm1', params: { text: 'rolled back' }, actor: 'admin' });
    const waitLost = runner.wait(lost);
    db.exec('ROLLBACK');
    const kept = runner.enqueue({ kind: 'sms-send', modemId: 'gsm1', params: { text: 'kept' }, actor: 'admin' });
    assert.equal(kept, lost);
    const waitKept = runner.wait(kept);
    const op = await waitKept;
    assert.deepEqual([op.status, op.params, texts], ['done', { text: 'kept' }, ['kept']]);
    assert.deepEqual(await Promise.race([waitLost.then(() => 'settled', () => 'rejected'), ticks().then(() => 'pending')]), 'settled');

    db.exec('BEGIN');
    const alone = runner.enqueue({ kind: 'sms-send', modemId: 'gsm1', params: { text: 'alone' }, actor: 'admin' });
    const waitAlone = runner.wait(alone);
    db.exec('ROLLBACK');
    await assert.rejects(waitAlone, { message: `operation ${alone} is no longer stored and was not started` });
    assert.deepEqual(texts, ['kept']);
  });

  test('register() and enqueue() check their arguments before anything is stored; an operation enqueued before start() runs after it', async () => {
    const { db } = database();
    const { runner } = make(db);
    runner.register('at', () => undefined);
    const modemIdRule = 'an operation modemId is null or a string of 1 to 64 characters';
    /** @type {Array<[() => unknown, string]>} */
    const invalid = [
      [() => runner.register('at', () => undefined), 'a handler for operation kind at is already registered'],
      [() => runner.register('Bad_Kind', () => undefined), 'invalid operation kind: "Bad_Kind"'],
      [() => runner.register('backup', /** @type {any} */ (null)), 'the handler of operation kind backup must be a function'],
      [() => runner.register('backup', () => undefined, { lock: /** @type {any} */ ('modem') }),
        `the lock of operation kind backup must be 'global' or 'queue', not "modem"`],
      [() => runner.register('config-apply', () => undefined, { lock: 'queue' }), 'operation kind config-apply always takes the global lock'],
      [() => runner.register('backup', () => undefined, { reevaluate: /** @type {any} */ ('retry') }),
        `reevaluate of operation kind backup must be 'uncertain', 'rerun' or a function`],
      [() => runner.enqueue({ kind: 'scan', actor: 'admin' }), 'no handler is registered for operation kind "scan"'],
      [() => runner.enqueue({ kind: 'at', actor: /** @type {any} */ ('root') }), 'an operation actor is admin, cli or system, not "root"'],
      [() => runner.enqueue({ kind: 'at', modemId: /** @type {any} */ (5), actor: 'admin' }), modemIdRule],
      [() => runner.enqueue({ kind: 'at', modemId: '', actor: 'admin' }), modemIdRule],
      [() => runner.enqueue({ kind: 'at', modemId: 'm'.repeat(65), actor: 'admin' }), modemIdRule],
      [() => runner.enqueue({ kind: 'at', params: /** @type {any} */ ([1]), actor: 'admin' }), 'operation params must be an object or null'],
      [() => runner.enqueue({ kind: 'at', params: { n: 1n }, actor: 'admin' }), 'Do not know how to serialize a BigInt'],
    ];
    for (const [call, message] of invalid) assert.throws(call, { message }, message);
    assert.deepEqual(statuses(db), {});
    assert.deepEqual([...GLOBAL_KINDS], ['registry-apply', 'config-apply', 'config-restore', 'asterisk-restart']);

    const id = runner.enqueue({ kind: 'at', modemId: 'gsm1', actor: 'system' });
    await ticks();
    assert.equal(runner.get(id)?.status, 'queued');
    const done = runner.wait(id);
    assert.deepEqual(runner.start(), { interrupted: 0, reevaluating: 0, uncertain: 0, queued: 1, unknownKind: 0 });
    assert.deepEqual([(await done).status, (await done).actor], ['done', 'system']);
    await assert.rejects(runner.wait(999), { message: 'no operation 999' });
    assert.equal(runner.get(999), null);
    assertObservedAt(db);
  });
});
