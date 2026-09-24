// @ts-check
// Tests for src/config/generators.js: output byte for byte against the snapshots (test/fixtures/generated/two-modems and
// docker/asterisk/test-config/aster.d) and the generator rules. ASTER_UPDATE_SNAPSHOTS=1 rewrites the snapshots.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  alsaCardId, DEVICES_HEADER, dongleDevices, GENERATED_FILES, generateAll, globals, HEADER, modems, OUTBOUND_DIAL_TIMEOUT, phones,
  quectelDevices,
} from '../src/config/generators.js';
import { lintFile } from '../src/config/lint.js';
import { parse, RegistryError, validate } from '../src/config/registry.js';
import { scan } from '../src/config/scan.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const UPDATE = process.env.ASTER_UPDATE_SNAPSHOTS === '1';
/** The line that gives a phone its jitter buffer, written out: the generated text is pinned here, not imported. */
const JITTERBUFFER = 'ExecIf($["${PHONE_JITTERBUFFER}"!=""]?Set(JITTERBUFFER(${PHONE_JITTERBUFFER})=default))';

/** @param {string} path relative to the repository */
const read = (path) => readFileSync(join(REPO, path), 'utf8');

/** The example after validation. */
const example = () => parse(read('packages/controller/test/fixtures/registry/valid-two-modems.yaml'));

/**
 * A validated registry: modem gsm1 (quectel, enabled) with `modem` merged in, and `phoneList`.
 * @param {Record<string, unknown>} [modem]
 * @param {Record<string, unknown>[]} [phoneList]
 */
const registryWith = (modem = {}, phoneList = []) =>
  validate({ version: 1, modems: [{ id: 'gsm1', driver: 'quectel', imei: '490154203237534', enabled: true, ...modem }], phones: phoneList });

/**
 * Compares `files` with the files under `dir` (relative to the repository), or writes them with ASTER_UPDATE_SNAPSHOTS=1.
 * @param {string} dir
 * @param {Readonly<Record<string, string>>} files
 */
function assertSnapshot(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const path = join(REPO, dir, name);
    if (UPDATE) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    assert.equal(readFileSync(path, 'utf8'), text, `${dir}/${name} is not the generator output (ASTER_UPDATE_SNAPSHOTS=1 rewrites it)`);
  }
  assert.deepEqual(readdirSync(join(REPO, dir, 'aster.d')).sort(), GENERATED_FILES.map((file) => file.replace('aster.d/', '')).sort());
}

/**
 * One context of a modems.conf: its header line up to the blank line after it.
 * @param {string} text
 * @param {string} context
 */
function contextOf(text, context) {
  const start = text.indexOf(`\n[${context}]`);
  if (start === -1) return '';
  const end = text.indexOf('\n\n', start + 1);
  return text.slice(start + 1, end === -1 ? undefined : end + 1);
}

describe('generators', () => {
  describe('snapshots', () => {
    test('the example generates test/fixtures/generated/two-modems/aster.d/*', () => {
      assertSnapshot('packages/controller/test/fixtures/generated/two-modems', generateAll(example()));
    });

    test('docker/asterisk/test-registry.yaml generates docker/asterisk/test-config/aster.d/* (loaded by smoke-test.sh)', () => {
      assertSnapshot('docker/asterisk/test-config', generateAll(parse(read('docker/asterisk/test-registry.yaml'))));
    });
  });

  describe('rules', () => {
    test('generateAll returns the five files in GENERATED_FILES order and validates its input first', () => {
      assert.deepEqual(Object.keys(generateAll(example())), [...GENERATED_FILES]);
      const hostile = { version: 1, modems: [{ id: 'x;System(id)', driver: 'quectel', imei: '490154203237534', enabled: true }], phones: [] };
      assert.throws(() => generateAll(hostile), RegistryError);
    });

    test('every file starts with its header line, has LF line ends and ends with exactly one LF', () => {
      for (const [name, text] of Object.entries(generateAll(example()))) {
        assert.equal(text.split('\n')[0], name.endsWith('-devices.conf') ? DEVICES_HEADER : HEADER, name);
        assert.ok(text.endsWith('\n') && !text.endsWith('\n\n') && !text.includes('\r'), name);
      }
    });

    test('an empty registry gives the headers, aster-phones-internal, aster-outgoing and aster-hangup', () => {
      const files = generateAll({ version: 1, modems: [], phones: [] });
      assert.equal(files['aster.d/globals.conf'], `${HEADER}\n`);
      assert.equal(files['aster.d/phones.conf'], `${HEADER}\n`);
      assert.equal(files['aster.d/quectel-devices.conf'], `${DEVICES_HEADER}\n`);
      assert.equal(files['aster.d/dongle-devices.conf'], `${DEVICES_HEADER}\n`);
      assert.deepEqual(scan(files['aster.d/modems.conf'] ?? '').sections.map((section) => section.name), ['aster-phones-internal', 'aster-jitterbuffer', 'aster-outgoing', 'aster-hangup']);
    });

    test('enabled selects the radio: a disabled modem is started with its radio off, an enabled unmapped one is stopped', () => {
      assert.match(quectelDevices(registryWith({ enabled: true })), /\ninitstate = start\nradio = on\n$/);
      assert.match(quectelDevices(registryWith({ enabled: false })), /\ninitstate = start\nradio = off\n$/);
      assert.match(quectelDevices(registryWith({ enabled: true, uac: true })), /\ninitstate = stop\nradio = on\n$/);
      assert.match(quectelDevices(registryWith({ enabled: false, uac: true })), /\ninitstate = start\nradio = off\n$/);
    });

    test('uac with usb_port writes quec_uac and alsadev; an unmapped modem (uac without usb_port) is stopped without them', () => {
      assert.equal(quectelDevices(registryWith({ uac: true, usb_port: '1-2' })),
        `${DEVICES_HEADER}\n[gsm1]\ncontext = aster-in-gsm1\nimei = 490154203237534\nquec_uac = 1\nalsadev = plughw:CARD=q_1_2\ninitstate = start\nradio = on\n`);
      assert.equal(quectelDevices(registryWith({ uac: true, enabled: true })),
        `${DEVICES_HEADER}\n[gsm1]\ncontext = aster-in-gsm1\nimei = 490154203237534\ninitstate = stop\nradio = on\n`);
    });

    test('ports replace imei with data and audio', () => {
      assert.equal(dongleDevices(registryWith({ driver: 'dongle', ports: { data: '/dev/ttyUSB6', audio: '/dev/ttyUSB5' } })),
        `${DEVICES_HEADER}\n[gsm1]\ncontext = aster-in-gsm1\ndata = /dev/ttyUSB6\naudio = /dev/ttyUSB5\ninitstate = start\nradio = on\n`);
    });

    test('group null writes no group line, group 0 is written', () => {
      assert.doesNotMatch(quectelDevices(registryWith()), /group/);
      assert.match(quectelDevices(registryWith({ group: 0 })), /\ngroup = 0\n/);
    });

    test('each modem is written only to its driver\'s device file; device sections are separated by one blank line', () => {
      const files = generateAll(example());
      assert.deepEqual(scan(files['aster.d/quectel-devices.conf'] ?? '').sections.map((section) => section.name), ['gsm1']);
      assert.deepEqual(scan(files['aster.d/dongle-devices.conf'] ?? '').sections.map((section) => section.name), ['gsm2']);
      const two = quectelDevices(validate({ version: 1, phones: [], modems: [
        { id: 'a', driver: 'quectel', imei: '490154203237534', enabled: true },
        { id: 'b', driver: 'quectel', imei: '490154203237535', enabled: false },
      ] }));
      assert.equal(two, `${DEVICES_HEADER}\n[a]\ncontext = aster-in-a\nimei = 490154203237534\ninitstate = start\nradio = on\n\n[b]\ncontext = aster-in-b\nimei = 490154203237535\ninitstate = start\nradio = off\n`);
    });

    test('incoming_context receives s and the DID extension, and no aster-ring-<id> is generated', () => {
      const text = modems(registryWith({ incoming_context: 'from-gsm' }));
      assert.equal(text.match(/ same => n,Goto\(from-gsm,s,1\)\n/g)?.length, 2);
      assert.doesNotMatch(text, /aster-ring-gsm1/);
    });

    test('the ring group dials the ring members in order with ring_timeout; ring: [] hangs up at once', () => {
      const phoneList = [{ number: '504', secret: 'x' }, { number: '505', secret: 'y' }];
      const header = '[aster-ring-gsm1]                     ; generated from modems[].ring (used when incoming_context is null)';
      assert.equal(contextOf(modems(registryWith({ ring: ['505', '504'], ring_timeout: 45 }, phoneList)), 'aster-ring-gsm1'),
        `${header}\nexten => s,1,Dial(PJSIP/505&PJSIP/504,45,mb(aster-jitterbuffer^s^1))\n same => n,Hangup()\n`);
      assert.equal(contextOf(modems(registryWith()), 'aster-ring-gsm1'), `${header}\nexten => s,1,Hangup()\n`);
    });

    test('the outbound patterns dial the modem\'s global with OUTBOUND_DIAL_TIMEOUT, whatever ring_timeout is', () => {
      const record = (/** @type {string} */ number) => ` same => n,GosubIf($["\${ASTER_MODEM}"=""]?aster-outgoing,s,1(gsm1,${number}))\n`;
      assert.equal(contextOf(modems(registryWith({ ring_timeout: 30 })), 'aster-out-gsm1'),
        `[aster-out-gsm1]\nexten => _+X.,1,${JITTERBUFFER}\n${record('${EXTEN}')} same => n,Dial(\${GSM1}/\${EXTEN},${OUTBOUND_DIAL_TIMEOUT})\n same => n,Hangup()\n`
        + `exten => _*X.,1,${JITTERBUFFER}\n${record('${EXTEN:1}')} same => n,Dial(\${GSM1}/\${EXTEN:1},${OUTBOUND_DIAL_TIMEOUT})\n same => n,Hangup()\n`);
    });

    test('an outgoing call is recorded: aster-outgoing sets the modem, the number dialed and the direction, then pushes aster-hangup', () => {
      const text = modems(registryWith());
      assert.equal(contextOf(text, 'aster-outgoing'), ['[aster-outgoing]', 'exten => s,1,Set(ASTER_MODEM=${ARG1})', ' same => n,Set(ASTER_DID=${ARG2})',
        ' same => n,Set(ASTER_DIRECTION=out)', ' same => n,Set(CHANNEL(hangup_handler_push)=aster-hangup,s,1)', ' same => n,Return()', ''].join('\n'));
      // the direction is the last field, so a line from an older dialplan without it still decodes
      assert.match(contextOf(text, 'aster-hangup'), /"\$\{BASE64_ENCODE\(x\$\{DIALEDTIME\}\)\}" "\$\{ASTER_DIRECTION\}"\)\n/);
    });

    test('a phone gets its jitter buffer from the hand-owned global PHONE_JITTERBUFFER: the caller in aster-out-<id>, a called phone in Dial\'s b() handler', () => {
      const text = modems(registryWith({ ring: ['504'] }, [{ number: '504', secret: 'x' }]));
      assert.equal(contextOf(text, 'aster-jitterbuffer'), `[aster-jitterbuffer]\nexten => s,1,${JITTERBUFFER}\n same => n,Return()\n`);
      assert.match(contextOf(text, 'aster-ring-gsm1'), /,mb\(aster-jitterbuffer\^s\^1\)\)\n/);
      // an empty or missing global sets nothing, and no modem can be given the global's name
      assert.match(JITTERBUFFER, /^ExecIf\(\$\["\$\{PHONE_JITTERBUFFER\}"!=""\]\?Set\(/);
      assert.throws(() => validate({ version: 1, modems: [{ id: 'phone_jitterbuffer', driver: 'dongle', imei: '490154203237534' }] }), RegistryError);
    });

    test('endpoint context: phones[].context, else aster-phones-<outbound>, else aster-phones-internal; direct_media; labels are not written', () => {
      const text = phones(validate({ version: 1, modems: [{ id: 'gsm1', driver: 'quectel', imei: '490154203237534', enabled: true }], phones: [
        { number: '501', secret: 's1', outbound: null, label: 'Reception ;-- desk' },
        { number: '502', secret: 's2', outbound: 'gsm1', direct_media: true },
        { number: '503', secret: 's3', outbound: 'gsm1', context: 'custom' },
      ] }));
      assert.equal(text, [HEADER,
        '[501](aster-phone)', 'context=aster-phones-internal', 'auth=501', 'aors=501', 'callerid=501', '[501](aster-auth)', 'username=501', 'password=s1', '[501](aster-aor)', '',
        '[502](aster-phone)', 'context=aster-phones-gsm1', 'auth=502', 'aors=502', 'callerid=502', 'direct_media=yes', '[502](aster-auth)', 'username=502', 'password=s2', '[502](aster-aor)', '',
        '[503](aster-phone)', 'context=custom', 'auth=503', 'aors=503', 'callerid=503', '[503](aster-auth)', 'username=503', 'password=s3', '[503](aster-aor)', ''].join('\n'));
    });

    test('every character a secret may hold reads back unchanged, a leading ">" included', () => {
      /** @type {string[]} */
      const allowed = [];
      for (let code = 0x21; code <= 0x7e; code++) if (code !== 0x3b) allowed.push(String.fromCharCode(code));
      const secrets = [allowed.join(''), ...allowed.map((ch) => `${ch}${ch}x`), '>', '=>x', '\\', '--', '#include'];
      const text = phones(validate({ version: 1, modems: [], phones: secrets.map((secret, index) => ({ number: String(100 + index), secret })) }));
      assert.match(text, /\npassword= >>x\n/);
      assert.deepEqual(scan(text).lines.filter((line) => line.key === 'password').map((line) => line.value), secrets);
    });

    test('registry order is kept and the output is deterministic', () => {
      const reg = example();
      assert.deepEqual(scan(globals({ ...reg, modems: [...reg.modems].reverse() })).lines.slice(1).map((line) => line.key), ['GSM2', 'GSM1']);
      assert.deepEqual(generateAll(example()), generateAll(example()));
    });

    test('the generated files scan without errors and lint clean', () => {
      for (const registry of [example(), parse(read('docker/asterisk/test-registry.yaml'))]) {
        for (const [name, text] of Object.entries(generateAll(registry))) {
          const { lines, problems } = scan(text);
          assert.deepEqual([...problems, ...lines.filter((line) => line.error !== undefined)], [], name);
          assert.deepEqual(lintFile(name, text), [], name);
        }
      }
    });
  });

  describe('alsaCardId', () => {
    test('q_<port> with - and . as _; above 15 characters qh_ and 12 hex digits of sha1(port)', () => {
      assert.equal(alsaCardId('1-1.3'), 'q_1_1_3');
      assert.equal(alsaCardId('1-2'), 'q_1_2');
      assert.equal(alsaCardId('10-1.2.3.4.56'), 'q_10_1_2_3_4_56');
      assert.equal(alsaCardId('10-1.2.3.4.567'), 'qh_d70fe89e6896');
    });

    test('agrees with install/udev/alsa-name, which udev runs for the sound card', () => {
      for (const port of ['1-1.3', '1-2', '3-1.4.2', '10-1.2.3.4.56', '10-1.2.3.4.567', '2-1.1.1.1.1.1.1']) {
        const devpath = `/devices/platform/scb/fd500000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0/usb1/${port}/${port}:1.4/sound/card2`;
        assert.equal(execFileSync('sh', [join(REPO, 'install/udev/alsa-name'), devpath], { encoding: 'utf8' }), `${alsaCardId(port)}\n`, port);
      }
    });
  });
});
