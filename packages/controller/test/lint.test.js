// @ts-check
// Tests for src/config/lint.js: one problem per fixture of test/fixtures/lint (linted as the name after the first dot),
// files that must lint clean, every rule, and lintRegistryRefs.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintFile, lintRegistryRefs } from '../src/config/lint.js';
import { validate } from '../src/config/registry.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/lint/', import.meta.url));
const FATAL = ' — Asterisk rejects the whole file';

/** existsInclude where only the generated files exist. @param {string} target */
const generatedOnly = (target) => target.startsWith('aster.d/');

/**
 * existsInclude for the files of a configuration directory (mounted on /etc/asterisk).
 * @param {string} dir
 */
const inDirectory = (dir) => (/** @type {string} */ target) => {
  const path = join(dir, target.startsWith('/etc/asterisk/') ? target.slice('/etc/asterisk/'.length) : target);
  return existsSync(path) && statSync(path).isFile();
};

/**
 * @param {string} name
 * @param {string[]} lines
 * @param {Parameters<typeof lintFile>[2]} [options]
 */
const lint = (name, lines, options = { existsInclude: generatedOnly }) => lintFile(name, `${lines.join('\n')}\n`, options);

const WIRING = {
  globals: 'no #include aster.d/globals.conf inside [globals]: without it the modem globals (GSM1=Quectel/gsm1, …) are not defined',
  modems: 'no #include aster.d/modems.conf: without it the generated modem contexts are not loaded',
  phones: 'no #include aster.d/phones.conf: without it no phone of aster.yaml can register',
  quectel: 'no #include aster.d/quectel-devices.conf: without it no quectel modem of aster.yaml is configured',
  dongle: 'no #include aster.d/dongle-devices.conf: without it no dongle modem of aster.yaml is configured',
};

/** Fixture → the one problem lintFile must report. */
const EXPECTED = {
  'missing-include.extensions.conf': [{ line: 18, message: `#include custom/contexts.conf: no such file${FATAL}` }],
  'exec.extensions.conf': [{ line: 18, message: '#exec is not allowed: it would run a program each time the file is loaded' }],
  'globals-outside.extensions.conf': [
    { line: 12, message: '#include aster.d/globals.conf must be inside [globals]: its lines are read as lines of the section above them' },
  ],
  'imei.quectel.conf': [{ line: 10, message: 'imei belongs to a device: it is set per modem in aster.yaml' }],
  'device-section.dongle.conf': [
    { line: 13, message: '[gsm3] is a device section: modems are configured in aster.yaml, which generates aster.d/dongle-devices.conf' },
  ],
  'unbalanced-bracket.dongle.conf': [{ line: 8, message: `no closing ]${FATAL}` }],
  'no-type.pjsip.conf': [{ line: 28, message: '[office-trunk] has no type = line — res_pjsip ignores this section' }],
  'missing-template.pjsip.conf': [
    { line: 23, message: `[aster-aor](!) must be defined above this line: the generated phone sections inherit from it${FATAL}` },
  ],
};

describe('lint', () => {
  describe('fixtures: one problem each', () => {
    test('every fixture file has its expected problem', () => {
      assert.deepEqual(readdirSync(FIXTURES).sort(), Object.keys(EXPECTED).sort());
    });

    for (const [file, expected] of Object.entries(EXPECTED)) {
      test(`${file} is rejected with its message`, () => {
        const name = file.slice(file.indexOf('.') + 1);
        assert.deepEqual(lintFile(name, readFileSync(join(FIXTURES, file), 'utf8'), { existsInclude: generatedOnly }), expected);
      });
    }
  });

  describe('files that lint clean', () => {
    test('the hand-owned files of docker/asterisk/test-config', () => {
      const dir = join(REPO, 'docker/asterisk/test-config');
      for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.conf'))) {
        assert.deepEqual(lintFile(file, readFileSync(join(dir, file), 'utf8'), { existsInclude: inDirectory(dir) }), [], file);
      }
    });

    test('the starter extensions.conf that install.sh writes', () => {
      const starter = readFileSync(join(REPO, 'install/templates/asterisk/extensions.conf'), 'utf8');
      assert.deepEqual(lintFile('extensions.conf', starter, { existsInclude: generatedOnly }), []);
    });

    test('the image\'s built-in defaults lack only the includes of the generated files', () => {
      const dir = join(REPO, 'docker/asterisk/rootfs/etc/asterisk');
      /** @type {Record<string, string[]>} */
      const missing = { 'extensions.conf': [WIRING.globals, WIRING.modems], 'pjsip.conf': [WIRING.phones], 'quectel.conf': [WIRING.quectel], 'dongle.conf': [WIRING.dongle] };
      for (const file of readdirSync(dir)) {
        const expected = (missing[file] ?? []).map((message) => ({ line: 0, message }));
        assert.deepEqual(lintFile(file, readFileSync(join(dir, file), 'utf8'), { existsInclude: inDirectory(dir) }), expected, file);
      }
    });
  });

  describe('every file', () => {
    test('a key line above the first section makes a top-level file invalid; an #include\'d fragment may start with one', () => {
      assert.deepEqual(lint('rtp.conf', ['rtpstart=10000', 'junk', '[general]']), [
        { line: 1, message: `key line above the first [section]${FATAL}` },
        { line: 2, message: `key line above the first [section]${FATAL}` },
      ]);
      assert.deepEqual(lint('custom/globals.conf', ['GSM9=Quectel/gsm9']), []);
    });

    test('bases and (+) targets must be defined above (a (+) cannot extend a template) unless an #include above may define them', () => {
      assert.deepEqual(lint('rtp.conf', ['[a](missing)', 'x=1', '[b](+)', '[t](!)', '[t](+)']), [
        { line: 1, message: `[a] inherits from "missing", which is not defined above${FATAL}` },
        { line: 3, message: `[b](+) adds to a section that is not defined above${FATAL}` },
        { line: 5, message: `[t](+) adds to a section that is not defined above${FATAL}` },
      ]);
      assert.deepEqual(lint('rtp.conf', ['[T](!)', 'x=1', '[a](t)', '[A](+)', 'y=2']), []);
      assert.deepEqual(lint('rtp.conf', ['#include templates.conf', '[a](missing)', '[b](+)'], { existsInclude: () => true }), []);
    });

    test('empty names', () => {
      assert.deepEqual(lint('rtp.conf', ['[a]()', '[]', 'x=1', '[b](,)']), [
        { line: 1, message: `empty name in the (…) of [a]${FATAL}` },
        { line: 2, message: 'empty section name []' },
      ]);
    });

    test('#include targets must exist, #tryinclude targets need not; without existsInclude no target is checked', () => {
      assert.deepEqual(lint('rtp.conf', ['[general]', '#include a.conf', '#tryinclude b.conf', '#include "c d.conf"'], { existsInclude: (target) => target === 'c d.conf' }), [
        { line: 2, message: `#include a.conf: no such file${FATAL}` },
      ]);
      assert.deepEqual(lint('rtp.conf', ['[general]', '#include a.conf'], {}), []);
    });

    test('#exec is rejected and the scanner\'s findings are reported', () => {
      assert.deepEqual(lint('rtp.conf', ['[general]', '#exec /bin/true', '#tryexec /bin/true', 'rtpstart', 'a = b --; c', 'd = e', ';--', ';-- open']), [
        { line: 2, message: '#exec is not allowed: it would run a program each time the file is loaded' },
        { line: 3, message: 'unknown directive #tryexec — Asterisk ignores this line' },
        { line: 4, message: 'no = in this line — Asterisk ignores it' },
        { line: 5, message: '--; closes no ;-- comment — Asterisk reads the lines after it as a comment' },
        { line: 8, message: ';-- opens a comment that no --; closes — Asterisk ignores the rest of the file' },
      ]);
    });
  });

  describe('extensions.conf', () => {
    /** @param {string[]} body lines after [internal] */
    const wired = (body) => ['[general]', 'static=yes', '[globals]', '#include aster.d/globals.conf', '[internal]',
      'exten => _5XX,1,Dial(PJSIP/${EXTEN},60)', ' same => n,Hangup()', ...body, '#include aster.d/modems.conf'];

    test('a starter file with both generated includes is clean', () => {
      assert.deepEqual(lint('extensions.conf', wired([])), []);
    });

    test('contexts take only dialplan lines (case-insensitive); [general] and [globals] take any key', () => {
      assert.deepEqual(lint('extensions.conf', wired(['[custom]', 'exten => s,1,NoOp()', 'include => internal', 'ignorepat => 9',
        'switch => Realtime/x', 'lswitch => Realtime/y', 'eswitch => Realtime/z', 'autohints = yes', 'foo = bar', 'Exten => t,1,NoOp()', '[Globals]', 'GSM9 = x'])), [
        { line: 16, message: 'foo is not a dialplan line (exten, same, include, ignorepat, switch) — Asterisk ignores it in [custom]' },
      ]);
    });

    test('same => needs an exten => above it in its context; a section with bases or (+) may continue one', () => {
      assert.deepEqual(lint('extensions.conf', wired(['[a]', ' same => n,NoOp()', '[t](!)', 'exten => s,1,NoOp()', '[c](t)',
        ' same => n,Hangup()', '[internal](+)', ' same => n,NoOp()', '[d]', 'exten => s,1,NoOp()', '[e]', ' same => n,NoOp()'])), [
        { line: 9, message: 'same => has no exten => above it in [a] — Asterisk ignores it' },
        { line: 19, message: 'same => has no exten => above it in [e] — Asterisk ignores it' },
      ]);
    });

    test('context names starting with aster- are reserved (any case)', () => {
      assert.deepEqual(lint('extensions.conf', wired(['[aster-custom]', 'exten => s,1,NoOp()', '[ASTER-x](!)'])), [
        { line: 8, message: '[aster-custom]: names starting with aster- are reserved for the generated contexts of aster.d/modems.conf' },
        { line: 10, message: '[ASTER-x]: names starting with aster- are reserved for the generated contexts of aster.d/modems.conf' },
      ]);
    });

    test('[internal] must exist unless a hand-owned #include may define it', () => {
      const base = ['[general]', '[globals]', '#include aster.d/globals.conf', '#include aster.d/modems.conf'];
      assert.deepEqual(lint('extensions.conf', base), [{ line: 0, message: 'no [internal] context: the generated aster-phones-* contexts include it' }]);
      assert.deepEqual(lint('extensions.conf', ['[Internal]', ...base]), [{ line: 0, message: 'no [internal] context: the generated aster-phones-* contexts include it' }]);
      assert.deepEqual(lint('extensions.conf', [...base, '#include custom.conf'], { existsInclude: () => true }), []);
    });

    test('generated includes: globals.conf inside [globals], each once (also as #tryinclude or absolute path), no other generated file', () => {
      assert.deepEqual(lint('extensions.conf', ['[general]', '[internal]', 'exten => s,1,NoOp()', '#include aster.d/globals.conf',
        '#include aster.d/phones.conf', '#include "/etc/asterisk/aster.d/modems.conf"', '#tryinclude aster.d/modems.conf', '#include aster.d/*.conf'], { existsInclude: () => true }), [
        { line: 4, message: '#include aster.d/globals.conf must be inside [globals]: its lines are read as lines of the section above them' },
        { line: 5, message: '#include aster.d/phones.conf: extensions.conf must not include this generated file (its own: aster.d/globals.conf and aster.d/modems.conf)' },
        { line: 7, message: '#include aster.d/modems.conf repeats line 6: the generated sections would be defined twice' },
        { line: 8, message: '#include aster.d/*.conf: extensions.conf must not include this generated file (its own: aster.d/globals.conf and aster.d/modems.conf)' },
      ]);
    });

    test('missing generated includes are problems of the file as a whole', () => {
      assert.deepEqual(lint('extensions.conf', ['[general]', '[internal]', 'exten => s,1,NoOp()']), [
        { line: 0, message: WIRING.globals },
        { line: 0, message: WIRING.modems },
      ]);
    });
  });

  describe('pjsip.conf', () => {
    const templates = ['[aster-phone](!)', 'type = endpoint', '[aster-auth](!)', 'type = auth', '[aster-aor](!)', 'type = aor'];

    test('a starter file with the phone templates above #include aster.d/phones.conf is clean', () => {
      assert.deepEqual(lint('pjsip.conf', ['[transport-udp]', 'type = transport', ...templates, '#include aster.d/phones.conf']), []);
    });

    test('every section needs a type of its own or inherited; a base that an #include may define is not judged', () => {
      assert.deepEqual(lint('pjsip.conf', [...templates, '[trunk]', 'contact = sip:x', '[600](aster-phone)', '[global]', 'type = global',
        '#include hand.conf', '[601](hand-template)', '[602](aster-aor)', 'max_contacts = 1', '#include aster.d/phones.conf'], { existsInclude: () => true }), [
        { line: 7, message: '[trunk] has no type = line — res_pjsip ignores this section' },
      ]);
    });

    test('two objects of one type may not share a name; other types may', () => {
      assert.deepEqual(lint('pjsip.conf', [...templates, '[600]', 'type = endpoint', '[600]', 'type = aor', '[600](aster-phone)', '#include aster.d/phones.conf']), [
        { line: 11, message: '[600] is the second endpoint of this name (line 7) — res_pjsip rejects every endpoint' },
      ]);
    });

    test('the phone templates must be templates of the right type above #include aster.d/phones.conf', () => {
      assert.deepEqual(lint('pjsip.conf', ['[aster-phone]', 'type = endpoint', '[aster-auth](!)', 'type = aor', '#include aster.d/phones.conf',
        '[aster-aor](!)', 'type = aor']), [
        { line: 1, message: '[aster-phone] must be a template, written [aster-phone](!): as a section res_pjsip also loads it as an object of type endpoint' },
        { line: 3, message: '[aster-auth] must have type = auth: the generated phone sections take their type from it' },
        { line: 5, message: `[aster-aor](!) must be defined above this line: the generated phone sections inherit from it${FATAL}` },
      ]);
      assert.deepEqual(lint('pjsip.conf', ['#include hand-templates.conf', '#include aster.d/phones.conf'], { existsInclude: () => true }), []);
    });
  });

  describe('quectel.conf and dongle.conf', () => {
    test('only [general] and [defaults]: device sections, (+) additions to devices, device keys and initstate in [general] are rejected', () => {
      assert.deepEqual(lint('quectel.conf', ['[general]', 'interval = 15', 'initstate = start', '[defaults]', 'initstate = stop', 'context = default',
        'data = /dev/ttyUSB2', '[t](!)', 'rxgain = 2', '[gsm1]', 'imei = 490154203237534', '#include aster.d/quectel-devices.conf', '[gsm1](+)',
        'rxgain = 3', '[General](+)', 'csmsttl = 600']), [
        { line: 3, message: 'initstate has no effect in [general]: a default belongs in [defaults], each modem\'s state comes from aster.yaml' },
        { line: 7, message: 'data belongs to a device: it is set per modem in aster.yaml' },
        { line: 10, message: '[gsm1] is a device section: modems are configured in aster.yaml, which generates aster.d/quectel-devices.conf' },
        { line: 13, message: '[gsm1] is a device section: modems are configured in aster.yaml, which generates aster.d/quectel-devices.conf' },
      ]);
    });

    test('radio is generated per modem from enabled: rejected in [general] and in [defaults]', () => {
      const message = 'radio is set per modem from enabled in aster.yaml: a disabled modem is kept with its radio off';
      assert.deepEqual(lint('dongle.conf', ['[general]', 'radio = on', '[defaults]', 'radio = off', '#include aster.d/dongle-devices.conf']), [
        { line: 2, message },
        { line: 4, message },
      ]);
    });

    test('each driver file includes its own generated file and no other; other files include none', () => {
      assert.deepEqual(lint('dongle.conf', ['[general]', '#include aster.d/quectel-devices.conf']), [
        { line: 0, message: WIRING.dongle },
        { line: 2, message: '#include aster.d/quectel-devices.conf: dongle.conf must not include this generated file (its own: aster.d/dongle-devices.conf)' },
      ]);
      assert.deepEqual(lint('musiconhold.conf', ['[default]', 'mode=files', '#include aster.d/modems.conf']), [
        { line: 3, message: '#include aster.d/modems.conf: musiconhold.conf must not include this generated file' },
      ]);
    });
  });

  describe('lintRegistryRefs', () => {
    const reg = validate({
      version: 1,
      modems: [
        { id: 'gsm1', driver: 'quectel', imei: '490154203237534', enabled: true, incoming_context: 'from-gsm1' },
        { id: 'gsm2', driver: 'dongle', imei: '490154203237542', enabled: true, incoming_context: 'Internal' },
      ],
      phones: [
        { number: '501', secret: '501', context: 'internal' },
        { number: '502', secret: '502', context: 'office' },
        { number: '503', secret: '503', context: 'tmpl' },
        { number: '504', secret: '504', context: 'general' },
      ],
    });
    const extensions = ['[general]', '[globals]', '[internal]', '[tmpl](!)', '#include custom/office.conf', '#include aster.d/modems.conf'].join('\n');

    test('contexts must exist: names are case-sensitive; templates, [general] and [globals] are not contexts', () => {
      assert.deepEqual(lintRegistryRefs(reg, extensions), [
        { path: 'modems[0].incoming_context', message: 'context "from-gsm1" is not defined in extensions.conf' },
        { path: 'modems[1].incoming_context', message: 'context "Internal" is not defined in extensions.conf' },
        { path: 'phones[1].context', message: 'context "office" is not defined in extensions.conf' },
        { path: 'phones[2].context', message: 'context "tmpl" is not defined in extensions.conf' },
        { path: 'phones[3].context', message: 'context "general" is not defined in extensions.conf' },
      ]);
    });

    test('contexts of hand-owned includes count: followed recursively, each file once, generated files never read', () => {
      /** @type {Record<string, string>} */
      const files = {
        'custom/office.conf': '[office]\n#include custom/more.conf\n#include custom/office.conf\n',
        'custom/more.conf': '[from-gsm1]\n[tmpl]\n[general]\n',
      };
      /** @type {string[]} */
      const read = [];
      const readInclude = (/** @type {string} */ target) => {
        read.push(target);
        return files[target] ?? null;
      };
      assert.deepEqual(lintRegistryRefs(reg, extensions, { readInclude }), [
        { path: 'modems[1].incoming_context', message: 'context "Internal" is not defined in extensions.conf' },
        { path: 'phones[3].context', message: 'context "general" is not defined in extensions.conf' },
      ]);
      assert.deepEqual(read, ['custom/office.conf', 'custom/more.conf']);
    });

    test('pjsip.conf must not define an endpoint, auth or aor named like a registry phone', () => {
      const pjsipText = ['[aster-phone](!)', 'type = endpoint', '[501](aster-phone)', '[502]', 'type = transport', '[503]', 'type = aor', '[599]',
        'type = endpoint', '[504](!)', 'type = auth'].join('\n');
      assert.deepEqual(lintRegistryRefs(reg, '[internal]\n[office]\n[tmpl]\n[from-gsm1]\n[Internal]\n[general-x]\n', { pjsipText }).filter((p) => p.path.endsWith('.number')), [
        { path: 'phones[0].number', message: 'pjsip.conf already defines the endpoint [501] (line 3); with the generated one res_pjsip rejects every endpoint' },
        { path: 'phones[2].number', message: 'pjsip.conf already defines the aor [503] (line 6); with the generated one res_pjsip rejects every aor' },
      ]);
    });
  });
});
