// @ts-check
// Flow 4: a registry change through the API reloads exactly what changed. Enabling gsm_test rewrites one
// generated file (aster.d/quectel-devices.conf: radio off → on; a disabled modem is started with its radio off, so its
// initstate stays start) and so costs one QuectelReload and nothing else — no dialplan reload, no PJSIP reload — and
// chan_quectel then reports the device's RadioSetting as `on`; disabling it again is the same in reverse. The operation's own record is the evidence: `files_written` and
// `actions` are what the apply did, and `verified.devices.quectel` is what the driver listed afterwards.
import { assert, showDevices, waitFor } from './lib.js';

export const name = '04 modem toggle: one QuectelReload per change, the driver shows the radio setting';

/** @param {import('./lib.js').Ctx} ctx */
export async function run({ api, ami, log }) {
  const before = (await api.read('/api/modems/gsm_test')).modem;
  assert.equal(before.enabled, false);
  assert.equal(before.state, 'disabled');
  const initial = (await showDevices(ami, 'quectel')).get('gsm_test');
  assert.ok(initial, 'chan_quectel does not list gsm_test');
  log(`before: driver state ${initial.state}, current ${initial.current}, desired ${initial.desired}, radio ${initial.radio}`);
  assert.deepEqual([initial.desired, initial.radio], ['start', 'off'], 'a disabled modem is started with its radio off');

  /**
   * @param {boolean} enabled
   * @param {string} radio
   */
  async function toggle(enabled, radio) {
    const reply = await api.put('/api/modems/gsm_test', { enabled });
    assert.equal(reply.status, 200, `PUT enabled=${enabled}: ${reply.status} ${JSON.stringify(reply.data)}`);
    const { operation, modem } = reply.data;
    assert.equal(operation.kind, 'registry-apply');
    assert.equal(operation.status, 'done', JSON.stringify(operation));
    log(`operation ${operation.id}: wrote ${JSON.stringify(operation.result.files_written)}, actions ${JSON.stringify(operation.result.actions)}`);
    assert.deepEqual(operation.result.files_written, ['aster.d/quectel-devices.conf']);
    assert.deepEqual(operation.result.actions, ['QuectelReload'], 'exactly one Reload, of the one driver whose file changed');
    assert.deepEqual(operation.result.verified.devices.quectel, ['gsm_test', 'gsm_uac', 'gsm_unmapped']);
    assert.equal(modem.enabled, enabled);

    const listed = await waitFor(`chan_quectel showing gsm_test radio ${radio}`, async () => {
      const device = (await showDevices(ami, 'quectel')).get('gsm_test');
      return device?.radio === radio ? device : undefined;
    });
    log(`after enabled=${enabled}: driver state ${listed.state}, current ${listed.current}, desired ${listed.desired}, radio ${listed.radio}`);
    assert.equal(listed.desired, 'start');
    return listed;
  }

  const enabledAt = Date.now();
  await toggle(true, 'on');
  // The API's view: `disabled` comes from the registry alone, so it is gone at once; what the driver says arrives with
  // the refresher's next ShowDevices (10 s) — wait for an observation made after the change, which is never `ready`
  // without a modem.
  const seen = await waitFor('an observation of gsm_test made after it was enabled', async () => {
    const { modem } = await api.read('/api/modems/gsm_test');
    return modem.state !== 'disabled' && Number(modem.observed_at) >= enabledAt ? modem : undefined;
  }, { timeoutMs: 30_000, everyMs: 1_000 });
  log(`API state while enabled with no modem: ${seen.state} (driver_state ${JSON.stringify(seen.driver_state)}, desired ${seen.detail?.desired})`);
  assert.notEqual(seen.state, 'ready');
  assert.equal(seen.detail?.desired, 'start');
  assert.equal(seen.detail?.radio, 'on');

  await toggle(false, 'off');
  const back = await waitFor('the API calling gsm_test disabled again', async () => {
    const { modem } = await api.read('/api/modems/gsm_test');
    return modem.state === 'disabled' ? modem : undefined;
  });
  assert.equal(back.enabled, false);
}
