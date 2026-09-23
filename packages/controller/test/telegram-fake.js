// @ts-check
// A fake Telegram Bot API: records every request and answers with `tg.script` (default: sendMessage success). Also used by
// test/e2e/telegram-server.mjs. Usage: const tg = await startFakeTelegram(); tg.requests; await tg.close()
import { createServer } from 'node:http';
import { once } from 'node:events';

/**
 * @typedef {object} FakeRequest
 * @property {string} token
 * @property {string} method        Bot API method (sendMessage)
 * @property {string} contentType
 * @property {Record<string, unknown> | null} body  parsed JSON body (null when it is not JSON)
 * @property {string | null} chatId  body.chat_id
 * @property {string | null} text    body.text
 * @property {number} at             Date.now() on arrival
 * @property {number} index          0-based arrival order
 */
/** @typedef {{ status?: number, body?: unknown, headers?: Record<string, string> } | 'hang' | 'destroy'} FakeReply */
/** @typedef {(request: FakeRequest) => FakeReply | undefined} Script  undefined → the default success */

/**
 * @param {{ port?: number, host?: string }} [listen]  default: a free port on 127.0.0.1
 * @returns {Promise<{ url: string, requests: FakeRequest[], script: Script, messages: () => Array<{ chatId: string | null, text: string | null }>,
 *   error: (status: number, description: string, parameters?: Record<string, unknown>) => FakeReply, close: () => Promise<void> }>}
 */
export async function startFakeTelegram({ port = 0, host = '127.0.0.1' } = {}) {
  /** @type {FakeRequest[]} */
  const requests = [];
  /** @type {Set<import('node:http').ServerResponse>} */
  const hanging = new Set();
  let messageId = 1000;
  const fake = {
    url: '',
    requests,
    /** @type {Script} */
    script: () => undefined,
    /** The successfully answered sendMessage requests, in order. */
    messages: () => requests.filter((request) => request.method === 'sendMessage' && /** @type {any} */ (request).answered === 200)
      .map((request) => ({ chatId: request.chatId, text: request.text })),
    /**
     * @param {number} status
     * @param {string} description
     * @param {Record<string, unknown>} [parameters]
     * @returns {FakeReply}
     */
    error: (status, description, parameters) => ({ status, body: { ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) } }),
    close: async () => {
      for (const response of hanging) response.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
  const server = createServer((req, res) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const match = /^\/bot([^/]*)\/([A-Za-z]+)$/.exec(req.url ?? '');
      /** @type {Record<string, unknown> | null} */
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      /** @type {FakeRequest & { answered?: number }} */
      const request = {
        token: decodeURIComponent(match?.[1] ?? ''),
        method: match?.[2] ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        body,
        chatId: typeof body?.chat_id === 'string' ? body.chat_id : null,
        text: typeof body?.text === 'string' ? body.text : null,
        at: Date.now(),
        index: requests.length,
      };
      requests.push(request);
      if (!match) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
        return;
      }
      const reply = fake.script(request) ?? { status: 200, body: { ok: true, result: { message_id: (messageId += 1), chat: { id: Number(request.chatId) }, text: request.text } } };
      if (reply === 'hang') {
        hanging.add(res);
        return;
      }
      if (reply === 'destroy') {
        req.socket.destroy();
        return;
      }
      const status = reply.status ?? 200;
      request.answered = status;
      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? { ok: true, result: {} });
      res.writeHead(status, { 'content-type': typeof reply.body === 'string' ? 'text/html' : 'application/json', ...reply.headers }).end(payload);
    });
  });
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake Telegram server has no port');
  fake.url = `http://${host}:${address.port}`;
  return fake;
}
