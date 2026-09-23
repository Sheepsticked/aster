// @ts-check
// tools/import-old-registry.js: the old driver configurations, dialplan and /temp state as a starter aster.yaml; the
// snapshots cover running it with and without the old host's temp directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parse, stringify } from '../../src/config/registry.js';
import { dialplan, driverDevices, importOld, readContext } from '../../../../tools/import-old-registry.js';
import { ROOT, snapshot } from './snapshot.js';

const OLD = new URL('../../../../test/fixtures/old/', import.meta.url);
/** @param {string} name */
const old = (name) => readFileSync(new URL(name, OLD), 'utf8');

const FILES = {
  drivers: { quectel: old('quectel.conf'), dongle: old('dongle.conf') },
  extensions: old('extensions.conf'),
  sip: old('sip.conf'),
};
/** The old host's /srv/asterisk/temp, as the repository's test/fixtures/old/temp records it. */
const TEMP = new Map(['GSM1type', 'GSM2type', 'dongleGSM1', 'dongleGSM2', 'quectelGSM1', 'quectelGSM2']
  .map((name) => [name, old(`temp/${name}`)]));

/** @param {Parameters<typeof importOld>[0]} files */
const registryOf = (files) => parse(stringify(importOld(files).registry));

describe('tools/import-old-registry.js', () => {
  test('with the old temp directory every modem fact comes from a file', () => {
    const registry = registryOf({ ...FILES, temp: TEMP });
    const [gsm1, gsm2] = registry.modems;
    assert.equal(registry.modems.length, 2);
    // GSM1type says quectel, so the IMEI is quectel.conf's and quec_uac = 1 becomes uac: true.
    assert.equal(gsm1?.id, 'gsm1');
    assert.equal(gsm1?.driver, 'quectel');
    assert.equal(gsm1?.imei, '490154203237534');
    assert.equal(gsm1?.uac, true);
    assert.equal(gsm1?.group, 1);
    assert.deepEqual([...gsm1?.ring ?? []], ['504', '505', '506', '507', '508']);
    assert.equal(gsm1?.ring_timeout, 120);
    assert.equal(gsm1?.usb_port, null, 'the old appliance records no port anywhere: Scan fills it in');
    assert.equal(gsm1?.incoming_context, null, 'the old [phones] is replaced by the generated aster-ring-gsm1');
    // GSM2type says dongle, so this one is the E173 section of dongle.conf and cannot have UAC audio.
    assert.equal(gsm2?.driver, 'dongle');
    assert.equal(gsm2?.imei, '356938035643817');
    assert.equal(gsm2?.uac, false);
    assert.equal(gsm2?.group, 2);
    assert.deepEqual([...gsm2?.ring ?? []], ['511', '512', '513', '514', '515']);
    // The desired state of the driver that was selected: quectelGSM1 is 1 while dongleGSM1 is 0, and GSM1 ran quectel.
    assert.equal(gsm1?.enabled, true);
    assert.equal(gsm2?.enabled, false, 'dongleGSM2 = 0');
    assert.deepEqual([...registry.telegram.default_recipients], ['111222333']);
    assert.equal(gsm1?.recipients, null, 'one chat id for both modems is the default, not a per-modem list');
    assert.equal(registry.phones.length, 15);
  });

  test('without it, the driver and the desired state are assumptions the report names', () => {
    const { registry, notes } = importOld(FILES);
    const [gsm1, gsm2] = parse(stringify(registry)).modems;
    assert.equal(gsm1?.driver, 'dongle', 'what the old UI itself falls back to');
    assert.equal(gsm1?.imei, '490154203237542', "so the IMEI is dongle.conf's, not quectel.conf's");
    assert.equal(gsm1?.uac, false);
    assert.equal(gsm1?.enabled, true);
    assert.equal(gsm2?.enabled, true, 'no state file, so both are assumed to have been running');

    const assumptions = notes.filter((n) => n.kind === 'assumption').map((n) => n.message).join('\n');
    assert.match(assumptions, /no temp directory was given/);
    assert.match(assumptions, /GSM1: IMEI 490154203237542 taken from \[GSM1\] of dongle\.conf/);
    assert.match(assumptions, /GSM2: IMEI 356938035643817 taken from \[GSM2\] of dongle\.conf/);
    assert.equal(notes.filter((n) => n.kind === 'mapping' && /driver|enabled|disabled/.test(n.message)).length, 0,
      'nothing about the driver or the state is reported as if it had been read');
  });

  test('a slot Aster cannot represent is left out with the reason', () => {
    /** @type {[string, string, RegExp][]} */
    const cases = [
      ['no imei', '[GSM1]\ngroup = 1\n', /has no imei/],
      ['a short imei', '[GSM1]\nimei = 12345\n', /imei=12345, which is not 15 digits/],
      ['a name that cannot be an id', '[GSM 1]\nimei = 490154203237534\n', /cannot be a modem id/],
    ];
    for (const [what, section, expected] of cases) {
      const dongle = `[general]\n[defaults]\ncontext = phones\n${section}`;
      const { registry, notes } = importOld({ ...FILES, drivers: { quectel: null, dongle } });
      assert.equal(/** @type {unknown[]} */ (registry.modems).length, 0, what);
      assert.match(notes.filter((n) => n.kind === 'problem').map((n) => n.message).join('\n'), expected, what);
    }
  });

  test('two slots naming one modem keep the slot that was running', () => {
    // The old UI can write the same IMEI into both slots with only one switched on: one modem, one entry, and the
    // phones of the lost slot go internal.
    const quectel = old('quectel.conf').replace('imei = 490154203237534', 'imei = 490154203237526');
    const temp = new Map([['GSM1type', 'quectel'], ['GSM2type', 'quectel'], ['quectelGSM1', '0\n'], ['quectelGSM2', '1\n']]);
    const { registry, notes } = importOld({ ...FILES, drivers: { quectel, dongle: old('dongle.conf') }, temp });
    const parsed = parse(stringify(registry));
    assert.deepEqual(parsed.modems.map((m) => [m.id, m.imei, m.enabled]), [['gsm2', '490154203237526', true]]);
    assert.deepEqual(parsed.phones.filter((p) => p.outbound !== null).map((p) => p.number), ['511', '512', '513', '514', '515']);
    const problems = notes.filter((n) => n.kind === 'problem').map((n) => n.message).join('\n');
    assert.match(problems, /GSM1: has the same IMEI 490154203237526 as GSM2 — one modem cannot be two entries/);
    assert.match(problems, /504: dialled out through gsm1, which is left out, so outbound: null/);
  });

  test('a ring member that is not a phone is dropped instead of making the file invalid', () => {
    const extensions = '[phones]\nexten => s,1,Dial(SIP/504&SIP/999&SIP/504,90,m)\n';
    const { registry, notes } = importOld({ ...FILES, extensions, temp: TEMP });
    const modem = /** @type {{ ring: string[], ring_timeout: number }} */ (/** @type {unknown[]} */ (registry.modems)[0]);
    assert.deepEqual(modem.ring, ['504'], 'a phone named twice is listed once — a ring group is a set');
    assert.equal(modem.ring_timeout, 90, 'the Dial timeout is the ring timeout');
    assert.match(notes.filter((n) => n.kind === 'problem').map((n) => n.message).join('\n'), /999 rang in \[phones\] but is not a phone in sip\.conf/);
    assert.match(notes.filter((n) => n.kind === 'mapping').map((n) => n.message).join('\n'), /names a phone more than once/);
    assert.doesNotThrow(() => stringify(registry), 'the file it writes is still one the appliance accepts');
  });

  test('a modem that notified somebody else keeps its own recipients', () => {
    const base = old('extensions.conf');
    const at = base.indexOf('[phones1]');
    assert.ok(at > 0);
    const extensions = base.slice(0, at) + base.slice(at).replaceAll('111222333', '-100200300');
    const registry = registryOf({ ...FILES, extensions, temp: TEMP });
    assert.deepEqual([...registry.telegram.default_recipients], ['111222333'], 'the first modem\'s chat id is the default');
    assert.equal(registry.modems[0]?.recipients, null);
    assert.deepEqual([...registry.modems[1]?.recipients ?? []], ['-100200300'], 'a negative chat id is a group');
  });

  test('a device that names its ttys itself is pointed at the ports: escape hatch', () => {
    const dongle = '[general]\n[defaults]\ncontext = phones\n[GSM1]\nimei = 490154203237534\ndata = /dev/ttyUSB2\naudio = /dev/ttyUSB1\n';
    const { registry, notes } = importOld({ ...FILES, drivers: { quectel: null, dongle } });
    const modem = /** @type {{ ports: unknown }} */ (/** @type {unknown[]} */ (registry.modems)[0]);
    assert.equal(modem.ports, null, 'the registry identifies a modem by IMEI; ports: is for one no driver can discover');
    assert.match(notes.filter((n) => n.kind === 'not carried over').map((n) => n.message).join('\n'),
      /GSM1: \[GSM1\] names its ttys directly \(data = \/dev\/ttyUSB2, audio = \/dev\/ttyUSB1\)/);
  });

  test('the pieces it reads out of the old files', () => {
    const devices = driverDevices(old('quectel.conf'));
    assert.deepEqual([...devices.keys()], ['GSM1', 'GSM2'], '[general] and [defaults] are not devices');
    assert.equal(devices.get('GSM1')?.get('autodeletesms'), 'yes', 'a [defaults] value belongs to every device');
    assert.equal(devices.get('GSM1')?.get('context'), 'phones', 'and the device overrides it');
    assert.equal(devices.get('GSM1')?.get('quec_uac'), '1');

    const contexts = dialplan(old('extensions.conf'));
    const phones = readContext(contexts.get('phones') ?? []);
    assert.deepEqual(phones.ring, ['504', '505', '506', '507', '508']);
    assert.equal(phones.ringTimeout, '120');
    assert.deepEqual(phones.dids, ['+375290000010'], '_5XX, _+. and _*X. are patterns, not DIDs');
    assert.deepEqual(phones.recipients, ['111222333']);
    assert.deepEqual(readContext(contexts.get('default') ?? []).ring, [], 'the internal context has no s extension');
  });

  test('the command line writes the registry on stdout and the report on stderr', () => {
    const run = spawnSync(process.execPath, ['tools/import-old-registry.js', 'test/fixtures/old', 'test/fixtures/old/temp'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.doesNotThrow(() => parse(run.stdout), 'the appliance can load what it printed');
    snapshot('aster.yaml', run.stdout);
    snapshot('import.report.txt', run.stderr);

    const noTemp = spawnSync(process.execPath, ['tools/import-old-registry.js', 'test/fixtures/old'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(noTemp.status, 0);
    assert.notEqual(noTemp.stdout, run.stdout, 'the driver of each slot is not the same guess as the file says');
    snapshot('import-no-temp.report.txt', noTemp.stderr);

    const noFiles = spawnSync(process.execPath, ['tools/import-old-registry.js', 'test/fixtures'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(noFiles.status, 2, 'a directory that holds none of the old files makes no registry');
    assert.match(noFiles.stderr, /none of the old appliance's files/);

    const usage = spawnSync(process.execPath, ['tools/import-old-registry.js'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: node tools\/import-old-registry\.js/);
  });
});
