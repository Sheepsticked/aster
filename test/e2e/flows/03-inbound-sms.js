// @ts-check
// Flow 3: an incoming SMS. `Local/sms@smoke` sets what chan_quectel sets on its channel — a hostile
// sender (`"\;touch /tmp/aster-smoke-pwned\;"`), a Cyrillic text as SMS_BASE64, the carrier's time stamp — and enters
// the generated `sms` extension, whose aster-emit writes the spool event. The controller must store it as a `messages`
// row with the text intact and send one Telegram notification whose text is byte for byte what notify/texts.js makes of
// that row; the shell injection in the sender must have reached nothing. A second SMS whose text is not base64
// (`sms-bad@smoke`) is refused at the edge: aster-emit writes no event for it (the dialplan logs APPERROR), so nothing
// is stored, nothing is quarantined and nobody is notified.
import { assert, docker, HOST, originate, sleep, waitFor } from './lib.js';
import { smsText } from '../../../packages/controller/src/notify/texts.js';

export const name = '03 inbound SMS: messages row, the same text in Telegram, a malformed one refused by aster-emit';

const TEXT = 'Привет из smoke-теста';

/** @param {import('./lib.js').Ctx} ctx */
export async function run({ api, ami, tg, log }) {
  await tg.reset();
  const quarantined = Number((await api.read('/api/health')).quarantine ?? 0);

  await originate(ami, 'sms@smoke');
  const row = await waitFor('the SMS as an inbox row', async () => {
    const { items } = await api.read('/api/messages?direction=in&modem=gsm_test');
    return items.find((/** @type {any} */ m) => m.text === TEXT);
  });
  log(`messages row ${row.id}: from ${JSON.stringify(row.number)}, scts ${row.scts}`);
  assert.match(row.number, /touch \/tmp\/aster-smoke-pwned/, 'the sender is stored as received');
  assert.equal(row.scts, '2026-09-10 09:30:00 +0300');
  assert.equal(docker(['exec', 'aster-e2e-asterisk', 'sh', '-c', 'test -e /tmp/aster-smoke-pwned && echo pwned || echo clean']), 'clean',
    'the sender went through the dialplan and aster-emit as data, not as a command');

  const messages = await waitFor('the SMS notification at the fake Bot API', async () => {
    const list = await tg.messages();
    return list.length >= 1 ? list : undefined;
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.chatId, '100200300');
  const expected = smsText({ host: HOST, modem: 'gsm_test', sender: row.number, scts: row.scts, text: row.text });
  assert.equal(messages[0]?.text, expected, 'the Telegram text is exactly what the row makes');
  log(`telegram: ${JSON.stringify(messages[0]?.text)}`);

  // The malformed one: `SMS_BASE64=not base64!` never gets past aster-emit — it exits non-zero, the generated `sms`
  // extension logs the failure, and there is no event file for the controller to see (the spool's
  // quarantine is for a file that was written and is not an event; this one is refused before that).
  await originate(ami, 'sms-bad@smoke');
  const refused = await waitFor('the dialplan logging the refused aster-emit', async () => {
    const { lines } = await api.read('/api/logs/asterisk?lines=200&grep=aster-emit');
    const hit = lines.find((/** @type {string} */ line) => line.includes('aster-emit sms gsm_test failed: APPERROR'));
    return hit;
  });
  log(`asterisk: ${refused.replace(/^\[[^\]]*\] /, '')}`);
  await sleep(2_000);
  const { items } = await api.read('/api/messages?direction=in&modem=gsm_test');
  assert.ok(!items.some((/** @type {any} */ m) => m.number === '+375290000003'), 'a refused event never becomes a row');
  assert.equal((await tg.messages()).length, 1, 'and nobody is notified about it');
  const health = await api.read('/api/health');
  assert.equal(Number(health.quarantine ?? 0), quarantined, 'nothing reached the spool, so nothing was quarantined');
  assert.equal(Number(health.spool_backlog), 0);
}
