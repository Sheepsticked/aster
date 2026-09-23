// @ts-check
// Aster controller — GET /api/events: the event bus as one text/event-stream per client, with a heartbeat comment.
// A client that stops reading gets events dropped instead of buffered, then `event: dropped` so the UI refetches.
import { TYPES } from '../bus.js';

export const DEFAULTS = Object.freeze(/** @type {Readonly<{ heartbeatMs: number, maxBufferBytes: number, retryMs: number }>} */ ({
  heartbeatMs: 25_000,
  maxBufferBytes: 1024 * 1024,
  retryMs: 3_000, // what the browser's EventSource waits before reconnecting after a controller restart
}));

/** @typedef {import('../bus.js').Bus} Bus */
/** @typedef {import('../log.js').Logger} Logger */

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * @param {{ bus: Bus, log?: Logger, timing?: Partial<typeof DEFAULTS> }} options
 */
export function createSse({ bus, log = SILENT, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };
  /** @type {Set<{ end: () => void }>} */
  const streams = new Set();
  let closing = false;

  /**
   * The route handler: hijacks the reply and keeps the socket until the client or stop() closes it.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  function handler(request, reply) {
    if (closing) {
      void reply.code(503).send({ error: 'the controller is stopping' });
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let dropped = 0;
    /** @param {string} frame */
    const write = (frame) => {
      if (!res.writableEnded) res.write(frame);
    };
    write(`retry: ${t.retryMs}\n\n`);

    const unsubscribe = bus.subscribe((event) => {
      if (res.writableEnded) return;
      if (res.writableLength > t.maxBufferBytes) {
        dropped += 1;
        return;
      }
      /** @type {string} */
      let data;
      try {
        data = JSON.stringify(event.payload ?? null);
      } catch (err) {
        log.warn('an event could not be serialized for a client', { type: event.type, err });
        return;
      }
      if (dropped > 0) {
        write(`event: dropped\ndata: ${JSON.stringify({ count: dropped })}\n\n`);
        dropped = 0;
      }
      write(`event: ${event.type}\ndata: ${data}\n\n`);
    });

    const heartbeat = setInterval(() => write(': ping\n\n'), t.heartbeatMs);
    heartbeat.unref();
    const stream = {
      end() {
        if (!streams.delete(stream)) return;
        clearInterval(heartbeat);
        unsubscribe();
        if (!res.writableEnded) res.end();
      },
    };
    streams.add(stream);
    res.on('close', () => stream.end());
    res.on('error', (err) => {
      log.debug('an event stream failed', { err });
      stream.end();
    });
    log.debug('event stream opened', { streams: streams.size, ip: request.ip });
  }

  return {
    /** The bus event types a client can receive. */
    types: TYPES,
    handler,
    /** Open streams. */
    count: () => streams.size,
    /** Ends every open stream, so the server can close (a client reconnects by itself). */
    stop() {
      closing = true;
      for (const stream of [...streams]) stream.end();
    },
  };
}
