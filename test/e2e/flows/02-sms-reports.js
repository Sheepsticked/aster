// @ts-check
// Flow 2: outbound SMS and the reports that follow it — and the controller catching up
// after a restart.
//   1. A send to gsm_test through the API. The device is stopped (there is no modem in CI), so chan_quectel refuses the
//      SendSMS action with `[gsm_test] Device disconnected` and the outbox row ends `failed` — the refusal path, real.
//   2. The controller is stopped. While it is down, Asterisk keeps running: a missed call and an SMS are originated and
//      their events pile up in spool/events. In the stopped controller's database two `submitted` attempts are
//      seeded — outbox 42 and 43, exactly the rows the driver would have left after `SMS queued for send` (no
//      hardware-less setup can make a driver accept an SMS).
//   3. The controller is started again: both spooled events are ingested and notified, then a status report for 42:1
//      (`Local/report@smoke`, type 1, success) makes attempt 42 `delivered`, and an expiry report for 43:1 (type 2,
//      passed as inherited channel variables into the generated `report` extension) makes 43 `undelivered_expired`.
//   4. Deleting: 43 is deleted, POST /api/sms/purge removes step 1's failed send and keeps 42 (delivered), then 42 is deleted.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert, docker, HOST, originate, sleep, waitFor } from './lib.js';

export const name = '02 outbound SMS: a refused send, reports applied, the spool caught up after a controller restart, failed ones deleted';

/**
 * Two `submitted` attempts in a stopped controller's database: what the outbox writes once the driver has queued an
 * SMS, and what a status report later moves on.
 * @param {string} home
 */
function seedSubmitted(home) {
  const db = new DatabaseSync(join(home, 'state', 'aster.db'));
  const at = Date.now();
  /** @type {Array<[number, string, string]>} */
  const rows = [[42, '+375290000042', 'e2e: a status report delivers this one'], [43, '+375290000043', 'e2e: an expiry report ends this one']];
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const [id, number, text] of rows) {
      db.prepare("INSERT INTO sms_outbox (id, modem_id, number, text, status, attempt_no, created_at, updated_at) VALUES (?, 'gsm_test', ?, ?, 'submitted', 1, ?, ?)")
        .run(id, number, text, at, at);
      db.prepare("INSERT INTO sms_attempts (outbox_id, attempt_no, submitted_at, ami_result, status) VALUES (?, 1, ?, '[gsm_test] SMS queued for send', 'submitted')")
        .run(id, at);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** @param {import('./lib.js').Ctx} ctx */
export async function run({ api, ami, tg, env, log }) {
  // 1. The refusal path.
  const sent = await api.post('/api/sms', { modem_id: 'gsm_test', number: '+1234567890', text: 'e2e: refused by a stopped device' });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  const op = await api.operation(sent.data.operation.id);
  log(`sms-send operation ${op.id}: ${op.status} — ${op.error}`);
  assert.equal(op.status, 'failed');
  assert.match(op.error, /Device disconnected/);
  const refused = (await api.read(`/api/sms/${sent.data.id}`)).sms;
  assert.equal(refused.status, 'failed');
  assert.equal(refused.attempts.length, 1);
  assert.equal(refused.attempts[0].status, 'failed');

  // 2. Down: events spool up, rows are seeded.
  const spool = join(env.home, 'spool', 'events');
  await tg.reset();
  log(`stopping ${env.controller}`);
  docker(['stop', '-t', '20', env.controller]);
  seedSubmitted(env.home);
  log('seeded outbox 42 and 43 as submitted attempts');
  await originate(ami, 'call@smoke');
  await originate(ami, 'sms@smoke');
  const files = await waitFor('two spooled events while the controller is down', async () => {
    const names = existsSync(spool) ? readdirSync(spool).filter((n) => n.endsWith('.evt')) : [];
    return names.length >= 2 ? names : undefined;
  });
  log(`spool/events while down: ${files.join(', ')}`);
  assert.equal((await tg.messages()).length, 0, 'nothing is notified while the controller is down');

  // 3. Up again: the backlog first.
  log(`starting ${env.controller}`);
  docker(['start', env.controller]);
  await waitFor('the controller back with the AMI up', async () => {
    const health = await api.read('/api/health');
    return health.status === 'ok' && health.ami?.state === 'up';
  }, { timeoutMs: 90_000, everyMs: 1_000 });
  await waitFor('the backlog ingested (spool/events empty)', async () => {
    const health = await api.read('/api/health');
    return Number(health.spool_backlog) === 0 && (!existsSync(spool) || readdirSync(spool).filter((n) => n.endsWith('.evt')).length === 0);
  });
  const caughtUp = await waitFor('both notifications after the restart', async () => {
    const list = await tg.messages();
    return list.length >= 2 ? list : undefined;
  });
  const kinds = caughtUp.map((m) => (m.text?.startsWith(`[${HOST}] Missed call`) ? 'call' : m.text?.startsWith(`[${HOST}] SMS `) ? 'sms' : 'other')).sort();
  assert.deepEqual(kinds, ['call', 'sms'], `one for the call and one for the SMS, got ${JSON.stringify(caughtUp)}`);

  // The status report: payload 42:1, type 1, success — what the smoke `report` helper sets.
  await originate(ami, 'report@smoke');
  const delivered = await waitFor('outbox 42 delivered', async () => {
    const { sms } = await api.read('/api/sms/42');
    return sms.status === 'delivered' ? sms : undefined;
  });
  assert.equal(delivered.attempts[0].status, 'delivered');
  assert.equal(delivered.attempts[0].report1_success, 1);
  assert.equal(delivered.attempts[0].report_raw, '+CDS: 6');
  log('outbox 42: submitted → delivered by the type-1 report');

  // The expiry: the generated `report` extension with the variables the driver would set, inherited into the Local leg.
  await originate(ami, 'report@aster-in-gsm_test', { variables: {
    SMS_REPORT_PAYLOAD: '43:1', SMS_REPORT_TYPE: 't', SMS_REPORT_SUCCESS: '0', SMS_REPORT_TS: '', SMS_REPORT_DT: '', SMS_REPORT: '',
  } });
  const expired = await waitFor('outbox 43 undelivered_expired', async () => {
    const { sms } = await api.read('/api/sms/43');
    return sms.status === 'undelivered_expired' ? sms : undefined;
  });
  assert.equal(expired.attempts[0].status, 'undelivered_expired');
  assert.equal(expired.last_error, 'no delivery report within the validity period');
  log('outbox 43: submitted → undelivered_expired by the type-2 report');

  // A retry of an expired one needs confirmation (the message may have reached the recipient after all): 409 first.
  const unconfirmed = await api.post('/api/sms/43/retry', {});
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.data.code, 'confirm-required');

  // 4. Deleting: the purge keeps a delivered SMS and takes step 1's refused send; one delivered or expired SMS goes with its attempts.
  const removed = await api.call('DELETE', '/api/sms/43');
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.deepEqual(removed.data, { deleted: 43, status: 'undelivered_expired' });
  assert.equal((await api.get('/api/sms/43')).status, 404);
  const purged = await api.post('/api/sms/purge', {});
  assert.equal(purged.status, 200, JSON.stringify(purged.data));
  assert.ok(purged.data.deleted >= 1, JSON.stringify(purged.data));
  assert.equal((await api.get(`/api/sms/${sent.data.id}`)).status, 404);
  assert.equal((await api.read('/api/sms/42')).sms.status, 'delivered');
  const deliveredGone = await api.call('DELETE', '/api/sms/42');
  assert.equal(deliveredGone.status, 200, JSON.stringify(deliveredGone.data));
  assert.deepEqual(deliveredGone.data, { deleted: 42, status: 'delivered' });
  assert.equal((await api.get('/api/sms/42')).status, 404);
  log(`outbox 43 deleted, the purge deleted ${purged.data.deleted} failed SMS and kept delivered 42, then 42 deleted`);
  await sleep(500);
}
