// @ts-check
// Aster controller — the log routes: the newest lines of the Asterisk log (read from the file's tail only)
// and of the controller's own in-memory ring buffer, with `lines` and a plain-substring `grep`.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { logs as schema } from '../schemas/history.js';

export const MAX_LINES = 2_000;
export const DEFAULT_LINES = 200;
/** The tail read from the end of the Asterisk log; a line is at most 8190 bytes, so this holds well over MAX_LINES of them. */
export const TAIL_BYTES = 1024 * 1024;

/**
 * The last lines of a file, oldest first, without reading more than `bytes` of it.
 * @param {string} path
 * @param {{ limit: number, grep: string | null, bytes?: number }} options
 * @returns {{ lines: string[], size: number, from: number, partial: boolean }}
 */
export function tail(path, { limit, grep, bytes = TAIL_BYTES }) {
  const { size } = statSync(path);
  const from = Math.max(0, size - bytes);
  const length = size - from;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString('utf8');
    const all = text.split('\n');
    // A window that does not start at the beginning of the file starts inside a line; the last element is the unterminated tail.
    if (from > 0) all.shift();
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    const wanted = grep === null ? all : all.filter((line) => line.toLowerCase().includes(grep.toLowerCase()));
    return { lines: wanted.slice(Math.max(0, wanted.length - limit)), size, from, partial: from > 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function logRoutes(app, ctx) {
  /** @param {unknown} query */
  function ask(query) {
    const fields = /** @type {Record<string, string | undefined>} */ (query ?? {});
    const asked = Number(fields.lines ?? String(DEFAULT_LINES));
    return { limit: Math.min(MAX_LINES, Math.max(1, asked || DEFAULT_LINES)), grep: fields.grep === undefined || fields.grep === '' ? null : fields.grep };
  }

  app.get('/api/logs/asterisk', { schema }, async (request, reply) => {
    const { limit, grep } = ask(request.query);
    const path = ctx.paths.asteriskLog;
    try {
      const result = tail(path, { limit, grep });
      return reply.send({ file: path, lines: result.lines, size: result.size, truncated: result.partial, limit, grep });
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') return reply.code(503).send({ error: `the Asterisk log ${path} does not exist; the Asterisk container writes it`, file: path });
      if (code === 'EACCES') return reply.code(503).send({ error: `the Asterisk log ${path} is not readable by the controller`, file: path });
      throw err;
    }
  });

  app.get('/api/logs/controller', { schema }, async (request, reply) => {
    const { limit, grep } = ask(request.query);
    if (!ctx.logRing) return reply.code(503).send({ error: 'this controller keeps no log ring buffer; read the container log instead' });
    return reply.send({ ...ctx.logRing.stats(), lines: ctx.logRing.lines({ limit, grep }), limit, grep });
  });
}
