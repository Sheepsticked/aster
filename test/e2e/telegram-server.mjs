// Aster — the fake Telegram Bot API as a service of test/e2e/compose.e2e.yaml. It serves the controller tests' fake
// (packages/controller/test/telegram-fake.js, mounted beside this file as telegram-fake.mjs) listening on a fixed port
// on the host network, where the controller is pointed at it with ASTER_TELEGRAM_API — so the notifications of the
// end-to-end run go where real ones would go, minus the internet, and what arrived can be read back.
//
// Two listeners on 127.0.0.1: the Bot API on ASTER_E2E_TELEGRAM_PORT (default 8090) answering /bot<token>/sendMessage
// the way api.telegram.org does, and an inspection API on the next port for the flows:
//   GET    /health     {ok, port, requests}   (the compose healthcheck)
//   GET    /messages   {messages: [{chatId, text}]}   the sendMessage requests that were answered 200, in order
//   GET    /requests   {requests: [...]}      every request, answered or not
//   DELETE /requests   forgets them all (a flow starts from zero)
// Runs inside the controller image (it has Node and nothing else is needed): node /e2e/telegram-server.mjs
import { createServer } from 'node:http';
import { startFakeTelegram } from './telegram-fake.mjs';

const port = Number(process.env.ASTER_E2E_TELEGRAM_PORT ?? 8090);
const fake = await startFakeTelegram({ port });

const inspection = createServer((req, res) => {
  /** @param {number} status @param {unknown} body */
  const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/health') return json(200, { ok: true, port, requests: fake.requests.length });
  if (req.method === 'GET' && url === '/messages') return json(200, { messages: fake.messages() });
  if (req.method === 'GET' && url === '/requests') return json(200, { requests: fake.requests });
  if (req.method === 'DELETE' && url === '/requests') {
    fake.requests.splice(0);
    return json(200, { ok: true });
  }
  return json(404, { error: `no ${req.method} ${url} here; GET /health, /messages, /requests or DELETE /requests` });
});
inspection.listen(port + 1, '127.0.0.1');

console.log(`fake Telegram Bot API on ${fake.url}; inspection on http://127.0.0.1:${port + 1}`);
process.on('SIGTERM', () => {
  inspection.close();
  fake.close().then(() => process.exit(0), () => process.exit(0));
});
