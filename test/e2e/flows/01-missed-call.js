// @ts-check
// Flow 1: an incoming call nobody answers. `Local/call@smoke` enters the generated ingress
// context of gsm_test exactly as the driver would, with the hostile caller id of the smoke test (`` `id`;$(id) ``);
// phone 599 is not registered, so the generated ring group's Dial ends CHANUNAVAIL and the hangup handler spools a
// call-end event. The controller must turn that into a `calls` row with outcome `missed` and send exactly one Telegram
// notification with the caller written as received; a DID call (`did@smoke`, `+1234567890`) does the same through
// the DID pattern of the ingress context.
import { assert, HOST, originate, sleep, waitFor } from './lib.js';

export const name = '01 missed call: outcome missed, one notification per call, the DID route too';

const HOSTILE = '`id`;$(id)';
const RECIPIENT = '100200300';
const TAG = `[${HOST}] `;
const MISSED = /^Missed call gsm_test from (.+) \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+00:00\] \(no phone reachable\)$/;

/** @param {import('./lib.js').Ctx} ctx */
export async function run({ api, ami, tg, log }) {
  await tg.reset();
  /** @param {(row: any) => boolean} match */
  const callRow = (match) => waitFor('the call-end event as a calls row', async () => {
    const { items } = await api.read('/api/calls?modem=gsm_test');
    return items.find(match);
  });

  await originate(ami, 'call@smoke');
  const call = await callRow((row) => row.caller === HOSTILE && row.did === null);
  log(`calls row ${call.id}: outcome ${call.outcome}, dialstatus ${call.dialstatus}, disposition ${call.disposition}`);
  assert.equal(call.outcome, 'missed');
  assert.equal(call.dialstatus, 'CHANUNAVAIL', 'phone 599 is not registered, so the Dial cannot reach it');
  assert.equal(call.modem_id, 'gsm_test');

  const first = await waitFor('the missed-call notification at the fake Bot API', async () => {
    const messages = await tg.messages();
    return messages.length >= 1 ? messages : undefined;
  });
  assert.equal(first.length, 1, 'exactly one message for one missed call');
  assert.equal(first[0]?.chatId, RECIPIENT);
  const text = first[0]?.text ?? '';
  log(`telegram: ${JSON.stringify(text)}`);
  assert.ok(text.startsWith(TAG), `the text starts with the host name ${TAG}`);
  assert.match(text.slice(TAG.length), MISSED);
  assert.equal(MISSED.exec(text.slice(TAG.length))?.[1], HOSTILE, 'the caller id reaches Telegram as text, uninterpreted');

  // The controller's own record of the delivery: one notification row for the call, sent, with Telegram's message id.
  const { items: notifications } = await api.read('/api/notifications?kind=call');
  const row = notifications.find((/** @type {any} */ n) => n.source_id === call.id);
  assert.ok(row, `no notification row for call ${call.id}`);
  assert.equal(row.status, 'sent');
  assert.equal(row.chat_id, RECIPIENT);
  assert.ok(Number.isInteger(row.tg_message_id), `tg_message_id ${JSON.stringify(row.tg_message_id)}`);

  // The DID route: the literal number the carrier dialled goes through `_[+0-9].` of the ingress context.
  await originate(ami, 'did@smoke');
  const did = await callRow((r) => r.did === '+1234567890');
  log(`calls row ${did.id}: caller ${did.caller}, did ${did.did}, outcome ${did.outcome}`);
  assert.equal(did.caller, '+375290000001');
  assert.equal(did.outcome, 'missed');
  const second = await waitFor('the second notification', async () => {
    const messages = await tg.messages();
    return messages.length >= 2 ? messages : undefined;
  });
  assert.equal(second[1]?.chatId, RECIPIENT);
  assert.ok(second[1]?.text?.startsWith(`${TAG}Missed call gsm_test from +375290000001 [`), `got ${JSON.stringify(second[1]?.text)}`);

  // "Exactly one per missed call": nothing else arrives once both are delivered.
  await sleep(3_000);
  assert.equal((await tg.messages()).length, 2);
}
