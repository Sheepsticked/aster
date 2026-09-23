// @ts-check
// Tests for src/bus.js: the event types, synchronous delivery in subscription order, unsubscribe, and isolation of failing
// subscribers.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createBus, TYPES } from '../src/bus.js';

/** @typedef {import('../src/log.js').Logger} Logger */
/** @typedef {import('../src/bus.js').BusEvent} BusEvent */
/** @typedef {import('../src/bus.js').OpProgress} OpProgress */

/** A logger that keeps its error lines. */
function recorder() {
  /** @type {Array<{ msg: string, fields: Record<string, unknown> }>} */
  const errors = [];
  /** @type {Logger} */
  const log = { debug() {}, info() {}, warn() {}, error: (msg, fields = {}) => void errors.push({ msg, fields }), child: () => log };
  return { log, errors };
}

/** @type {OpProgress} */
const PROGRESS = { id: 1, kind: 'scan', modem_id: null, actor: 'admin', status: 'queued', message: null, result: null, error: null, at: 1 };

describe('bus', () => {
  test('the event types are exactly these', () => {
    assert.deepEqual([...TYPES], ['modem.state', 'op.progress', 'message.new', 'call.new', 'notification.result', 'health', 'phone.state']);
  });

  test('publish hands a frozen { type, payload } to every subscriber in subscription order before it returns; unsubscribe ends one subscription', () => {
    const bus = createBus();
    /** @type {string[]} */
    const seen = [];
    /**
     * @param {string} name
     * @returns {(event: BusEvent) => void}
     */
    const record = (name) => (event) => {
      assert.ok(Object.isFrozen(event));
      seen.push(`${name} ${event.type} ${JSON.stringify(event.payload)}`);
    };
    const offA = bus.subscribe(record('a'));
    const b = record('b');
    const offB = bus.subscribe(b);
    bus.subscribe(b);
    bus.publish('health', { ok: true });
    assert.deepEqual(seen, ['a health {"ok":true}', 'b health {"ok":true}', 'b health {"ok":true}']);
    offA();
    offB();
    offB();
    seen.length = 0;
    bus.publish('call.new', { id: 7 });
    assert.deepEqual(seen, ['b call.new {"id":7}']);
  });

  test('an unknown event type throws a TypeError and reaches no subscriber; a subscriber must be a function', () => {
    const bus = createBus();
    let calls = 0;
    bus.subscribe(() => {
      calls += 1;
    });
    assert.throws(() => bus.publish(/** @type {any} */ ('modem.gone'), {}), { name: 'TypeError', message: 'unknown bus event type: "modem.gone"' });
    assert.equal(calls, 0);
    assert.throws(() => bus.subscribe(/** @type {any} */ (null)), { name: 'TypeError', message: 'a bus subscriber must be a function' });
  });

  test('a subscriber that throws or rejects is logged with the event type; the publisher and the other subscribers are unaffected', async () => {
    const { log, errors } = recorder();
    const bus = createBus({ log });
    /** @type {string[]} */
    const seen = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(async () => {
      throw new Error('async boom');
    });
    bus.subscribe((event) => void seen.push(event.type));
    assert.doesNotThrow(() => bus.publish('op.progress', PROGRESS));
    assert.deepEqual(seen, ['op.progress']);
    await tick();
    assert.deepEqual(errors.map(({ msg, fields }) => [msg, fields.type, /** @type {Error} */ (fields.err).message]), [
      ['bus subscriber failed', 'op.progress', 'boom'],
      ['bus subscriber failed', 'op.progress', 'async boom'],
    ]);
  });

  test('an event published by a subscriber is delivered after the current event has reached every subscriber', () => {
    const bus = createBus();
    /** @type {string[]} */
    const seen = [];
    bus.subscribe((event) => {
      seen.push(`a ${event.type}`);
      if (event.type === 'modem.state') bus.publish('health', { from: 'a' });
    });
    bus.subscribe((event) => void seen.push(`b ${event.type}`));
    bus.publish('modem.state', { modem_id: 'gsm1' });
    assert.deepEqual(seen, ['a modem.state', 'b modem.state', 'a health', 'b health']);
  });

  test('a subscription removed during a delivery misses that event; one added during it starts with the next event; many subscribers work', () => {
    const bus = createBus();
    /** @type {string[]} */
    const seen = [];
    let offB = () => {};
    let added = false;
    bus.subscribe(() => {
      seen.push('a');
      offB();
      if (!added) {
        added = true;
        bus.subscribe(() => void seen.push('late'));
      }
    });
    offB = bus.subscribe(() => void seen.push('b'));
    for (let i = 0; i < 20; i += 1) bus.subscribe(() => void seen.push('x'));
    bus.publish('message.new', { id: 1 });
    assert.deepEqual(seen, ['a', ...Array(20).fill('x')]);
    seen.length = 0;
    bus.publish('notification.result', { id: 2 });
    assert.deepEqual(seen, ['a', ...Array(20).fill('x'), 'late']);
  });
});
