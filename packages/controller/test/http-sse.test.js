// @ts-check
// Tests for GET /api/events over a real socket (the handler hijacks the reply), and its backpressure rule against a stubbed
// response: a client that stops reading costs a counter, not memory.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { createBus } from '../src/bus.js';
import { createSse } from '../src/http/sse.js';
import { harness } from './http-harness.js';
import { until } from './devices-fake.js';

/**
 * Reads from a stream until `text` contains the marker, or the stream ends.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {RegExp} marker
 */
async function readUntil(reader, marker) {
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < 100; i += 1) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: true });
    if (marker.test(text) || done) return text;
  }
  return text;
}

describe('http event stream routes', () => {
  test('the stream carries the bus events of the session it belongs to, then the heartbeat', async () => {
    const h = await harness({ timing: { heartbeatMs: 40 } });
    /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
    let reader = null;
    try {
      const url = await h.server.listen();
      const { cookie } = await h.login();
      const response = await fetch(`${url}/api/events`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
      assert.match(await readUntil(reader, /retry: /), /^retry: 3000\n\n$/);
      await until(() => h.server.sse.count() === 1, 2000, 'the stream to be registered');

      // A heartbeat every 40 ms can share a read with the event, so each frame is looked for rather than being the whole read;
      // what is checked is that the stream carries the frame and nothing but heartbeats besides it.
      /** @param {string} read @param {string} frame */
      const carries = (read, frame) => {
        assert.ok(read.includes(frame), read);
        assert.equal(read.replace(frame, '').replaceAll(': ping\n\n', ''), '', `only heartbeats may share the read: ${read}`);
      };
      h.bus.publish('modem.state', { modem_id: 'gsm1', state: 'ready' });
      carries(await readUntil(reader, /modem\.state/), 'event: modem.state\ndata: {"modem_id":"gsm1","state":"ready"}\n\n');

      h.bus.publish('op.progress', /** @type {any} */ ({ id: 7, kind: 'scan', status: 'done' }));
      carries(await readUntil(reader, /op\.progress/), 'event: op.progress\ndata: {"id":7,"kind":"scan","status":"done"}\n\n');
      const before = Date.now();
      assert.match(await readUntil(reader, /ping/), /^(?:: ping\n\n)+$/, 'the heartbeat keeps the connection open');
      assert.ok(Date.now() - before < 1_500, `the heartbeat waited ${Date.now() - before} ms although heartbeatMs is 40`);

      // Closing the server ends the stream: a client that is still reading sees the end instead of hanging.
      await h.server.close();
      const { done } = await reader.read();
      assert.equal(done, true);
      assert.equal(h.server.sse.count(), 0);
    } finally {
      await reader?.cancel().catch(() => {});
      await h.stop();
    }
  });

  test('a client that stops reading is counted, not buffered, and is told to refetch when it reads again', () => {
    const real = createBus();
    let subscriptions = 0; // a stream that does not unsubscribe would leak one per client
    const bus = { publish: real.publish, subscribe: (/** @type {any} */ fn) => {
      subscriptions += 1;
      const off = real.subscribe(fn);
      return () => {
        subscriptions -= 1;
        off();
      };
    } };
    const sse = createSse({ bus, timing: { maxBufferBytes: 100, heartbeatMs: 60_000 } });
    /** @type {string[]} */
    const frames = [];
    const raw = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writableLength: 0,
      /** @param {Record<string, string>} _headers */
      writeHead(/** @type {number} */ _code, _headers) {
        return raw;
      },
      /** @param {string} frame */
      write(frame) {
        frames.push(frame);
        return true;
      },
      end() {
        raw.writableEnded = true;
      },
    });
    let hijacked = 0;
    const reply = /** @type {any} */ ({ hijack: () => { hijacked += 1; }, raw });
    sse.handler(/** @type {any} */ ({ ip: '127.0.0.1' }), reply);
    assert.deepEqual([hijacked, frames, sse.count()], [1, ['retry: 3000\n\n'], 1]);

    bus.publish('message.new', { id: 1 });
    assert.equal(frames.length, 2);
    raw.writableLength = 101; // the client stopped reading
    for (let i = 0; i < 50; i += 1) bus.publish('message.new', { id: i });
    assert.equal(frames.length, 2, 'nothing is written while the buffer is above the limit');
    raw.writableLength = 0;
    bus.publish('call.new', { id: 2 });
    assert.deepEqual(frames.slice(2), ['event: dropped\ndata: {"count":50}\n\n', 'event: call.new\ndata: {"id":2}\n\n']);

    // A payload that cannot be serialized is logged and skipped, not thrown at the publisher.
    /** @type {any} */
    const circular = { id: 3 };
    circular.self = circular;
    bus.publish('notification.result', circular);
    assert.equal(frames.length, 4);

    assert.equal(subscriptions, 1);
    raw.emit('close');
    assert.deepEqual([sse.count(), subscriptions], [0, 0], 'the closed stream let go of the bus');
    bus.publish('call.new', { id: 4 });
    assert.equal(frames.length, 4, 'a closed stream is unsubscribed');
    sse.stop();
  });
});
