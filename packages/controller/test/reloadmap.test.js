// @ts-check
// Tests for src/config/reloadmap.js: an entry for every configuration file, reloadFor/reloadActions, and that
// docker/asterisk/smoke-test.sh runs exactly the map's reload actions.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GENERATED_FILES } from '../src/config/generators.js';
import { driverReload, RELOAD, reloadActions, reloadFor, RESTART } from '../src/config/reloadmap.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
/** @param {string} line */
const command = (line) => ({ action: 'Command', Command: line });
const QUECTEL = { action: 'QuectelReload', When: 'gracefully' };
const DONGLE = { action: 'DongleReload', When: 'gracefully' };

describe('reloadmap', () => {
  test('the reload table: restart, res_pjsip, dialplan, driver, moh, rtp, logger and cdr entries', () => {
    assert.deepEqual(RESTART, command('core restart gracefully'));
    for (const file of ['asterisk.conf', 'modules.conf']) assert.deepEqual(reloadFor(file), [RESTART], file);
    for (const file of ['pjsip.conf', 'aster.d/phones.conf']) assert.deepEqual(reloadFor(file), [command('module reload res_pjsip.so')], file);
    for (const file of ['extensions.conf', 'aster.d/globals.conf', 'aster.d/modems.conf']) assert.deepEqual(reloadFor(file), [command('dialplan reload')], file);
    for (const file of ['quectel.conf', 'aster.d/quectel-devices.conf']) assert.deepEqual(reloadFor(file), [QUECTEL], file);
    for (const file of ['dongle.conf', 'aster.d/dongle-devices.conf']) assert.deepEqual(reloadFor(file), [DONGLE], file);
    assert.deepEqual(reloadFor('musiconhold.conf'), [command('moh reload')]);
    assert.deepEqual(reloadFor('rtp.conf'), [command('module reload res_rtp_asterisk.so')]);
    assert.deepEqual(reloadFor('logger.conf'), [command('logger reload')]);
    assert.deepEqual(reloadFor('cdr.conf'), [command('module reload cdr')]);
  });

  test('the other starter files: their module\'s reload, or a restart where the module has none (ccss, stasis)', () => {
    assert.deepEqual(reloadFor('cel.conf'), [command('module reload cel')]);
    assert.deepEqual(reloadFor('features.conf'), [command('module reload features')]);
    assert.deepEqual(reloadFor('indications.conf'), [command('module reload indications')]);
    assert.deepEqual(reloadFor('acl.conf'), [command('module reload acl')]);
    assert.deepEqual(reloadFor('udptl.conf'), [command('module reload udptl')]);
    assert.deepEqual(reloadFor('pjproject.conf'), [command('module reload res_pjproject.so')]);
    assert.deepEqual(reloadFor('ccss.conf'), [RESTART]);
    assert.deepEqual(reloadFor('stasis.conf'), [RESTART]);
  });

  test('driverReload gives the driver\'s Reload action with When: gracefully', () => {
    assert.deepEqual(driverReload('quectel'), QUECTEL);
    assert.deepEqual(driverReload('dongle'), DONGLE);
  });

  test('every file of the image defaults, of test-config and of the generators has an entry', () => {
    const files = new Set([
      ...readdirSync(join(REPO, 'docker/asterisk/rootfs/etc/asterisk')),
      ...readdirSync(join(REPO, 'docker/asterisk/test-config')).filter((entry) => entry.endsWith('.conf')),
      ...GENERATED_FILES,
    ]);
    for (const file of files) assert.ok(Object.hasOwn(RELOAD, file), file);
  });

  test('an unlisted file needs a restart; manager.conf is never applied by the controller', () => {
    assert.deepEqual(reloadFor('res_parking.conf'), [RESTART]);
    assert.throws(() => reloadFor('manager.conf'), /manager\.conf is written by install\.sh only/);
  });

  test('reloadActions: each action once, dialplan → res_pjsip → quectel → dongle → the rest; any restart replaces all', () => {
    assert.deepEqual(reloadActions([]), []);
    assert.deepEqual(reloadActions(['rtp.conf', 'aster.d/dongle-devices.conf', 'aster.d/phones.conf', 'pjsip.conf', 'aster.d/quectel-devices.conf',
      'aster.d/modems.conf', 'extensions.conf', 'logger.conf']), [
      command('dialplan reload'), command('module reload res_pjsip.so'), QUECTEL, DONGLE, command('module reload res_rtp_asterisk.so'), command('logger reload'),
    ]);
    assert.deepEqual(reloadActions(['extensions.conf', 'modules.conf']), [RESTART]);
    assert.deepEqual(reloadActions(['extensions.conf', 'res_parking.conf']), [RESTART]);
    assert.throws(() => reloadActions(['extensions.conf', 'manager.conf']), /install\.sh only/);
  });

  test('the map, its lists and its actions are frozen', () => {
    assert.ok(Object.isFrozen(RELOAD));
    for (const actions of Object.values(RELOAD)) {
      if (actions === null) continue;
      assert.ok(Object.isFrozen(actions));
      for (const action of actions) assert.ok(Object.isFrozen(action));
    }
  });

  test('smoke-test.sh runs every reload action of the map except the restart', () => {
    const script = readFileSync(join(REPO, 'docker/asterisk/smoke-test.sh'), 'utf8');
    const block = /^reload_commands='([^']*)'$/m.exec(script);
    assert.ok(block, 'smoke-test.sh defines reload_commands');
    const inMap = new Set(Object.values(RELOAD).flatMap((actions) => actions ?? [])
      .flatMap((action) => ('Command' in action && action !== RESTART ? [action.Command] : [])));
    assert.deepEqual((block[1] ?? '').split('\n').sort(), [...inMap].sort());
    for (const action of ['QuectelReload', 'DongleReload']) assert.match(script, new RegExp(`Action: ${action}\nActionID: [^\n]+\nWhen: gracefully\n`));
  });
});
