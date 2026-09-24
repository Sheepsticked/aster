// @ts-check
// Tests for src/config/registry.js: the fixtures of test/fixtures/registry, the validation rules, stringify, and the
// atomic write with injected failures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, isUnmapped, load, parse, RegistryError, stringify, validate, write } from '../src/config/registry.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/registry/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
/** @param {string} name */
const fixture = (name) => join(FIXTURES, name);
/** @param {string | Uint8Array} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const MESSAGES = {
  context: 'must be null or an extensions.conf context name (letters, digits, _ . -; at most 79 characters; not aster-…)',
  secret: 'must be 1 to 128 printable ASCII characters without spaces or ";"',
  chatId: 'must be a quoted Telegram chat id: digits with an optional leading -',
  label: 'must be null or one line of 1 to 64 characters',
  group: 'chan_quectel and chan_dongle read a dial resource g<digit>… or r<digit>… as a group, not a device name',
};

/**
 * @param {string} number
 * @param {string | null} outbound
 * @param {boolean} [directMedia]
 */
const phone = (number, outbound, directMedia = false) => ({ number, label: null, secret: number, outbound, context: null, direct_media: directMedia });

/** The example after defaults. */
const TWO_MODEMS = {
  version: 1,
  settings: { ui_language: 'ru', timezone: 'Europe/Istanbul', retention_days: { operations: 90, notifications: 90, messages: 180, calls: 180 } },
  telegram: { default_recipients: ['111222333'], alerts: false },
  modems: [
    { id: 'gsm1', driver: 'quectel', imei: '490154203237534', enabled: true, uac: true, usb_port: '1-1.3',
      ring: ['504', '505', '506', '507', '508'], ring_timeout: 120, incoming_context: null, group: 1, recipients: null, ports: null },
    { id: 'gsm2', driver: 'dongle', imei: '490154203237542', enabled: true, uac: false, usb_port: null,
      ring: ['511', '512', '513', '514', '515'], ring_timeout: 120, incoming_context: null, group: 2, recipients: null, ports: null },
  ],
  phones: [
    phone('501', null), phone('502', null), phone('503', null),
    phone('504', 'gsm1'), phone('505', 'gsm1'), phone('506', 'gsm1'), phone('507', 'gsm1'), phone('508', 'gsm1'),
    phone('509', null, true), phone('510', null, true),
    phone('511', 'gsm2'), phone('512', 'gsm2'), phone('513', 'gsm2'), phone('514', 'gsm2'), phone('515', 'gsm2'),
  ],
};

/**
 * A fresh valid registry as plain data (the base of the invalid fixtures).
 * @returns {any}
 */
const base = () => ({
  version: 1,
  modems: [
    { id: 'gsm1', driver: 'quectel', imei: '490154203237534', enabled: true, uac: true, usb_port: '1-1.3', ring: ['504'] },
    { id: 'gsm2', driver: 'dongle', imei: '490154203237542', enabled: true, ring: ['511'] },
  ],
  phones: [
    { number: '501', secret: '501', outbound: null },
    { number: '504', secret: '504', outbound: 'gsm1' },
    { number: '511', secret: '511', outbound: 'gsm2' },
  ],
});

/**
 * Asserts that `fn` throws a RegistryError with exactly these [path, message] problems, in this order.
 * @param {() => unknown} fn
 * @param {Array<[string, string]>} expected
 */
function assertProblems(fn, expected) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof RegistryError, String(err));
    assert.deepEqual(err.errors.map((e) => [e.path, e.message]), expected);
    return true;
  });
}

describe('registry', () => {
  describe('fixtures', () => {
    test('valid-two-modems.yaml loads with every default applied', () => {
      const path = fixture('valid-two-modems.yaml');
      const loaded = load(path);
      assert.deepEqual(loaded.registry, TWO_MODEMS);
      assert.equal(loaded.hash, sha256(readFileSync(path)));
      assert.deepEqual(loaded.flags, []);
      const gsm1 = loaded.registry.modems[0];
      assert.ok(Object.isFrozen(loaded) && Object.isFrozen(loaded.registry) && Object.isFrozen(gsm1) && Object.isFrozen(gsm1?.ring));
      assert.ok(Object.isFrozen(loaded.registry.settings.retention_days) && Object.isFrozen(loaded.registry.phones[14]));
      assert.throws(() => /** @type {any} */ (gsm1).ring.push('509'), TypeError);
    });

    test('valid-minimal.yaml has only the required keys; every other key takes its default', () => {
      const { registry, flags } = load(fixture('valid-minimal.yaml'));
      assert.deepEqual(registry, {
        version: 1,
        settings: { ui_language: 'en', timezone: 'UTC', retention_days: { operations: 90, notifications: 90, messages: 180, calls: 180 } },
        telegram: { default_recipients: [], alerts: false },
        modems: [{ id: 'gsm1', driver: 'dongle', imei: '490154203237542', enabled: true, uac: false, usb_port: null, ring: [], ring_timeout: 120,
          incoming_context: null, group: null, recipients: null, ports: null }],
        phones: [{ number: '501', label: null, secret: '501', outbound: null, context: null, direct_media: false }],
      });
      assert.deepEqual(flags, []);
      // the documented defaults
      assert.equal(DEFAULTS.modem.ring_timeout, 120);
      assert.equal(DEFAULTS.phone.direct_media, false);
      assert.equal(DEFAULTS.modem.recipients, null);
      assert.equal(DEFAULTS.modem.incoming_context, null);
      assert.deepEqual(DEFAULTS.settings.retention_days, { operations: 90, notifications: 90, messages: 180, calls: 180 });
      assert.equal(DEFAULTS.telegram.alerts, false);
    });

    test('valid-uac-without-usb-port.yaml is valid and flagged unmapped', () => {
      const { registry, flags } = load(fixture('valid-uac-without-usb-port.yaml'));
      assert.deepEqual(registry.modems.map((modem) => [modem.id, modem.uac, modem.usb_port, isUnmapped(modem)]),
        [['gsm1', true, null, true], ['gsm2', false, null, false]]);
      assert.deepEqual(flags, [{ path: 'modems[0]', flag: 'unmapped',
        message: 'gsm1: uac is true but usb_port is not set; the modem stays stopped until Scan or Assign sets usb_port' }]);
    });

    /** @type {Array<[string, string, string]>} file, path, message */
    const INVALID = [
      ['invalid-duplicate-id.yaml', 'modems[1].id', 'duplicate modem id "gsm1" (also modems[0].id)'],
      ['invalid-duplicate-imei.yaml', 'modems[1].imei', 'duplicate IMEI "490154203237534" (also modems[0].imei)'],
      ['invalid-imei-14-digits.yaml', 'modems[0].imei', 'must be a quoted string of 15 digits (got "86710507807510")'],
      ['invalid-bad-driver.yaml', 'modems[1].driver', 'must be quectel or dongle (got "huawei")'],
      ['invalid-ring-unknown-phone.yaml', 'modems[0].ring[1]', 'phone "599" is not in phones'],
      ['invalid-outbound-unknown-modem.yaml', 'phones[1].outbound', 'modem "gsm3" is not in modems'],
      ['invalid-duplicate-phone.yaml', 'phones[3].number', 'duplicate phone number "504" (also phones[1].number)'],
      ['invalid-bad-phone-number.yaml', 'phones[0].number', 'must be a quoted string of 3 to 6 digits (got "50")'],
      ['invalid-duplicate-usb-port.yaml', 'modems[1].usb_port', 'duplicate usb_port "1-1.3" (also modems[0].usb_port)'],
      ['invalid-unknown-version.yaml', 'version', 'must be 1, the registry version this controller reads (got number 2)'],
      ['invalid-missing-modems.yaml', 'modems', 'is required'],
    ];
    for (const [file, path, message] of INVALID) {
      test(`${file} is rejected with exactly one problem at ${path}`, () => {
        const full = fixture(file);
        assert.throws(() => load(full), (err) => {
          assert.ok(err instanceof RegistryError, String(err));
          assert.deepEqual(err.errors, [{ path, message }]);
          assert.equal(err.message, `invalid registry ${full}: 1 problem\n  ${path}: ${message}`);
          return true;
        });
      });
    }

    test('every fixture file is covered by one of these tests', () => {
      const covered = ['valid-two-modems.yaml', 'valid-minimal.yaml', 'valid-uac-without-usb-port.yaml', ...INVALID.map(([file]) => file)];
      assert.deepEqual(readdirSync(FIXTURES).sort(), covered.sort());
    });

    test('install/templates/aster.yaml is a valid registry with no modems and the old appliance\'s 15 phones, all internal only', () => {
      const { registry, flags } = load(join(REPO, 'install', 'templates', 'aster.yaml'));
      const phones = Array.from({ length: 15 }, (_, index) => String(501 + index)).map((number) => ({
        number, label: null, secret: number, outbound: null, context: null, direct_media: number === '509' || number === '510',
      }));
      assert.deepEqual(registry, {
        version: 1,
        settings: { ui_language: 'en', timezone: 'Europe/Minsk', retention_days: { operations: 90, notifications: 90, messages: 180, calls: 180 } },
        telegram: { default_recipients: [], alerts: false },
        modems: [],
        phones,
      });
      assert.deepEqual(flags, []);
    });
  });

  describe('validation rules', () => {
    test('all problems are reported together, in document order, without echoing secrets', () => {
      const input = base();
      input.version = '1';
      input.modems[0].driver = 'Quectel';
      input.modems[0].imei = 490154203237534;
      input.modems[1].extra = 1;
      input.modems[1].uac = true;
      input.phones[1].outbound = 'gsm9';
      input.phones[2].secret = 'has space';
      assert.throws(() => validate(input), (err) => {
        assert.ok(err instanceof RegistryError);
        assert.deepEqual(err.errors.map((e) => [e.path, e.message]), [
          ['version', 'must be 1, the registry version this controller reads (got "1")'],
          ['modems[0].driver', 'must be quectel or dongle (got "Quectel")'],
          ['modems[0].imei', 'must be a quoted string of 15 digits (got number 490154203237534)'],
          ['modems[1].extra', 'unknown key (allowed: id, driver, imei, enabled, uac, usb_port, ring, ring_timeout, incoming_context, group, recipients, ports)'],
          ['modems[1].uac', 'must be false for a dongle modem (UAC audio is quectel only)'],
          ['phones[1].outbound', 'modem "gsm9" is not in modems'],
          ['phones[2].secret', MESSAGES.secret],
        ]);
        assert.match(err.message, /^invalid registry registry: 7 problems\n {2}version: /);
        assert.doesNotMatch(err.message, /has space/);
        return true;
      });
    });

    test('validate() takes plain data (API input), leaves it untouched and returns a deep-frozen copy in key order', () => {
      const input = base();
      const before = structuredClone(input);
      const registry = validate(input);
      assert.deepEqual(input, before);
      assert.ok(!Object.isFrozen(input.modems[0].ring));
      assert.notEqual(registry.modems[0]?.ring, input.modems[0].ring);
      assert.deepEqual(Object.keys(registry), ['version', 'settings', 'telegram', 'modems', 'phones']);
      assert.deepEqual(Object.keys(registry.modems[1] ?? {}), ['id', 'driver', 'imei', 'enabled', 'uac', 'usb_port', 'ring', 'ring_timeout',
        'incoming_context', 'group', 'recipients', 'ports']);
      assert.deepEqual(Object.keys(registry.phones[0] ?? {}), ['number', 'label', 'secret', 'outbound', 'context', 'direct_media']);
      assertProblems(() => validate(null), [['', 'must be a mapping (got null)']]);
      assert.throws(() => validate([]), { message: 'invalid registry registry: 1 problem\n  (file): must be a mapping (got a list)' });
    });

    /** @type {Array<[string, (r: any) => void, Array<[string, string]>]>} */
    const RULES = [
      ['unquoted IMEI and phone number (YAML numbers)', (r) => {
        r.modems[1].imei = 490154203237542;
        r.phones[0].number = 501;
      }, [
        ['modems[1].imei', 'must be a quoted string of 15 digits (got number 490154203237542)'],
        ['phones[0].number', 'must be a quoted string of 3 to 6 digits (got number 501)'],
      ]],
      ['an unknown key is a problem at every level (typos never fall back to defaults)', (r) => {
        r.phone = [];
        r.settings = { retention: 30 };
        r.phones[2]['direct-media'] = true;
      }, [
        ['phone', 'unknown key (allowed: version, settings, telegram, modems, phones)'],
        ['settings.retention', 'unknown key (allowed: ui_language, timezone, retention_days)'],
        ['phones[2].direct-media', 'unknown key (allowed: number, label, secret, outbound, context, direct_media)'],
      ]],
      ['phones is required like modems', (r) => {
        delete r.phones;
      }, [
        ['phones', 'is required'],
        ['modems[0].ring[0]', 'phone "504" is not in phones'],
        ['modems[1].ring[0]', 'phone "511" is not in phones'],
      ]],
      ['required modem keys', (r) => {
        r.modems[1] = { id: 'gsm2' };
      }, [
        ['modems[1].driver', 'is required'],
        ['modems[1].imei', 'is required'],
        ['modems[1].enabled', 'is required'],
      ]],
      ['lists and mappings in the wrong shape', (r) => {
        r.telegram = [];
        r.phones = { number: '501' };
      }, [
        ['telegram', 'must be a mapping (got a list)'],
        ['modems[0].ring[0]', 'phone "504" is not in phones'],
        ['modems[1].ring[0]', 'phone "511" is not in phones'],
        ['phones', 'must be a list (got a mapping)'],
      ]],
      ['id syntax', (r) => {
        r.modems[1].id = 'GSM2';
        r.phones[2].outbound = null;
      }, [
        ['modems[1].id', 'must match ^[a-z][a-z0-9_]{0,15}$ (got "GSM2")'],
      ]],
      ['reserved ids: internal, g<digit>…, r<digit>…', (r) => {
        r.modems[0].id = 'internal';
        r.modems[1].id = 'g1';
        r.modems.push({ id: 'r2d2', driver: 'dongle', imei: '490154203237543', enabled: false });
        r.phones[1].outbound = 'internal';
        r.phones[2].outbound = 'g1';
      }, [
        ['modems[0].id', '"internal" cannot be used: aster-phones-internal is the generated context of phones with outbound: null'],
        ['modems[1].id', `"g1" cannot be used: ${MESSAGES.group}`],
        ['modems[2].id', `"r2d2" cannot be used: ${MESSAGES.group}`],
      ]],
      ['ids that name Asterisk or dialplan variables', (r) => {
        r.modems[0].id = 'exten';
        r.modems[1].id = 'aster_did';
        r.phones[1].outbound = 'exten';
        r.phones[2].outbound = 'aster_did';
      }, [
        ['modems[0].id', '"exten" cannot be used: Asterisk resolves ${EXTEN} itself, so the global of this modem would never be read'],
        ['modems[1].id', '"aster_did" cannot be used: the generated dialplan reads the channel variable ${ASTER_DID}'],
      ]],
      ['uac is quectel only', (r) => {
        r.modems[1].uac = true;
      }, [
        ['modems[1].uac', 'must be false for a dongle modem (UAC audio is quectel only)'],
      ]],
      ['repeated ring members and recipients; recipients must be quoted chat ids', (r) => {
        r.modems[0].ring = ['504', '504'];
        r.modems[0].recipients = ['-1001234567890', 'abc', '-1001234567890'];
        r.telegram = { default_recipients: [111222333] };
      }, [
        ['telegram.default_recipients[0]', `${MESSAGES.chatId} (got number 111222333)`],
        ['modems[0].ring[1]', '"504" is already listed at modems[0].ring[0]'],
        ['modems[0].recipients[1]', `${MESSAGES.chatId} (got "abc")`],
        ['modems[0].recipients[2]', '"-1001234567890" is already listed at modems[0].recipients[0]'],
      ]],
      ['contexts: no aster-… names and nothing that could leave the Goto()/include argument', (r) => {
        r.modems[0].incoming_context = 'aster-ring-gsm2';
        r.modems[1].incoming_context = 'custom,s,1)';
        r.phones[0].context = '${SHELL(id)}';
        r.phones[1].context = 'from-internal';
      }, [
        ['modems[0].incoming_context', `${MESSAGES.context} (got "aster-ring-gsm2")`],
        ['modems[1].incoming_context', `${MESSAGES.context} (got "custom,s,1)")`],
        ['phones[0].context', `${MESSAGES.context} (got "\${SHELL(id)}")`],
      ]],
      ['secrets: 1 to 128 printable ASCII characters, no space or ";"', (r) => {
        r.phones[0].secret = 'pass;word';
        r.phones[1].secret = '';
        r.phones[2].secret = 'пароль';
      }, [
        ['phones[0].secret', MESSAGES.secret],
        ['phones[1].secret', MESSAGES.secret],
        ['phones[2].secret', MESSAGES.secret],
      ]],
      ['usb_port syntax; ports need both paths, under /dev, used once', (r) => {
        r.modems[0].usb_port = '1-1.3:1.2';
        r.modems[0].ports = { data: '/dev/ttyUSB2', audio: '/dev/ttyUSB2' };
        r.modems[1].ports = { data: '/dev/../etc/passwd' };
      }, [
        ['modems[0].usb_port', 'must be null or a USB port path such as "1-1.3" (got "1-1.3:1.2")'],
        ['modems[0].ports.audio', 'duplicate device path "/dev/ttyUSB2" (also modems[0].ports.data)'],
        ['modems[1].ports.audio', 'is required'],
        ['modems[1].ports.data', 'must be a device path under /dev/ (got "/dev/../etc/passwd")'],
      ]],
      ['whole numbers and booleans', (r) => {
        r.settings = { retention_days: { operations: 0.5, calls: 0 } };
        r.modems[0].enabled = 'yes';
        r.modems[0].ring_timeout = 0;
        r.modems[1].group = -1;
        r.phones[2].direct_media = 'true';
      }, [
        ['settings.retention_days.operations', 'must be a whole number of days from 1 to 36500 (got number 0.5)'],
        ['settings.retention_days.calls', 'must be a whole number of days from 1 to 36500 (got number 0)'],
        ['modems[0].enabled', 'must be true or false (got "yes")'],
        ['modems[0].ring_timeout', 'must be a whole number of seconds from 1 to 3600 (got number 0)'],
        ['modems[1].group', 'must be null or a whole number from 0 to 2147483647 (got number -1)'],
        ['phones[2].direct_media', 'must be true or false (got "true")'],
      ]],
      ['language, time zone and labels', (r) => {
        r.settings = { ui_language: 'de', timezone: 'Mars/Olympus' };
        r.phones[0].label = 'two\nlines';
        r.phones[1].label = 'x'.repeat(65);
      }, [
        ['settings.ui_language', 'must be ru or en (got "de")'],
        ['settings.timezone', 'must be an IANA time zone such as Europe/Istanbul (got "Mars/Olympus")'],
        ['phones[0].label', `${MESSAGES.label} (got "two\\nlines")`],
        ['phones[1].label', `${MESSAGES.label} (got "${'x'.repeat(40)}…")`],
      ]],
    ];
    for (const [name, mutate, expected] of RULES) {
      test(`rule: ${name}`, () => {
        const input = base();
        mutate(input);
        assertProblems(() => validate(input), expected);
      });
    }

    test('values the rules accept', () => {
      const input = base();
      input.settings = { ui_language: 'en', timezone: 'America/Argentina/Buenos_Aires', retention_days: { operations: 1, notifications: 36500, messages: 1, calls: 36500 } };
      input.telegram = { default_recipients: ['-1001234567890', '111222333'], alerts: true };
      Object.assign(input.modems[0], { ring_timeout: 3600, incoming_context: 'from-trunk.custom_1', group: 0, recipients: [] });
      Object.assign(input.modems[1], { usb_port: '3-1.2.4', ports: { data: '/dev/serial/by-path/platform-xhci-hcd.0-usb-0:1.3:1.2-port0',
        audio: '/dev/ttyUSB1' }, id: 'gsm_2' });
      // every printable ASCII character except ";" (93 of them), padded to the limit of 128
      const printable = Array.from({ length: 0x7f - 0x21 }, (_, i) => String.fromCharCode(0x21 + i)).filter((ch) => ch !== ';').join('');
      input.phones[0].label = 'Кухня "GSM" #1: \\ x';
      Object.assign(input.phones[2], { outbound: 'gsm_2', secret: printable.padEnd(128, 'a'), direct_media: true, context: '_internal',
        label: 'x'.repeat(64) });
      const registry = validate(input);
      assert.equal(registry.modems[1]?.ports?.data, '/dev/serial/by-path/platform-xhci-hcd.0-usb-0:1.3:1.2-port0');
      assert.equal(printable.length, 93);
      assert.equal(registry.phones[2]?.secret, printable.padEnd(128, 'a'));
      assert.deepEqual(parse(stringify(registry)), registry);
      input.phones[2].secret += 'a';
      assertProblems(() => validate(input), [['phones[2].secret', MESSAGES.secret]]);
    });
  });

  describe('YAML', () => {
    test('duplicate keys, several documents, unresolved tags and non-string keys are problems with line and column', () => {
      /** @type {Array<[string, string]>} */
      const cases = [
        ['version: 1\nversion: 1\nmodems: []\nphones: []\n', 'line 2, column 1: Map keys must be unique'],
        ['version: 1\nmodems: []\nphones: []\n---\nversion: 1\n', 'line 4, column 1: Source contains multiple documents; please use YAML.parseAllDocuments()'],
        ['version: 1\nmodems: !custom []\nphones: []\n', 'line 2, column 9: Unresolved tag: !custom'],
        ['version: 1\nmodems: []\nphones: []\n1: x\n', 'line 4, column 1: keys must be strings'],
      ];
      for (const [text, message] of cases) assertProblems(() => parse(text), [['', message]]);
    });

    test('a syntax error, an alias bomb and an empty file are problems too', () => {
      assert.throws(() => parse('version: 1\nmodems: [\nphones: []\n'), (err) => {
        assert.ok(err instanceof RegistryError);
        assert.ok(err.errors.length > 0);
        for (const e of err.errors) assert.match(`${e.path}|${e.message}`, /^\|line \d+, column \d+: /);
        return true;
      });
      const bomb = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
        'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]', 'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]', ''].join('\n');
      assertProblems(() => parse(bomb), [['', 'Excessive alias count indicates a resource exhaustion attack']]);
      assertProblems(() => parse(''), [['', 'must be a mapping (got null)']]);
      assertProblems(() => parse('# only a comment\n'), [['', 'must be a mapping (got null)']]);
    });

    test('YAML 1.2 core schema: yes is a string and << is an ordinary key', () => {
      assertProblems(() => parse('version: 1\nmodems:\n  - { id: gsm1, driver: dongle, imei: "490154203237542", enabled: yes }\nphones: []\n'),
        [['modems[0].enabled', 'must be true or false (got "yes")']]);
      assertProblems(() => parse('version: 1\nmodems: []\nphones:\n  - { <<: { number: "501" }, secret: "501" }\n'), [
        ['phones[0].<<', 'unknown key (allowed: number, label, secret, outbound, context, direct_media)'],
        ['phones[0].number', 'is required'],
      ]);
    });

    test('a byte-order mark and CRLF line ends are accepted; invalid UTF-8 is not', () => {
      const text = `${String.fromCharCode(0xfeff)}version: 1\r\nmodems: []\r\nphones:\r\n  - { number: "501", secret: "501" }\r\n`;
      assert.equal(parse(text).phones[0]?.number, '501');
      const dir = mkdtempSync(join(tmpdir(), 'aster-registry-utf8-'));
      try {
        const path = join(dir, 'aster.yaml');
        writeFileSync(path, Buffer.concat([Buffer.from('version: 1\nmodems: []\nphones: []\n# '), Buffer.from([0xff, 0xfe])]));
        assertProblems(() => load(path), [['', 'the file is not valid UTF-8']]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('stringify and write', () => {
    const root = mkdtempSync(join(tmpdir(), 'aster-registry-'));
    after(() => rmSync(root, { recursive: true, force: true }));
    let counter = 0;
    const target = () => {
      const dir = join(root, `case-${++counter}`);
      mkdirSync(dir);
      return join(dir, 'aster.yaml');
    };

    test('stringify writes every key in a fixed order with quoted strings; the text loads back to the same registry', () => {
      assert.equal(stringify(load(fixture('valid-minimal.yaml')).registry), [
        '# Aster registry. Written by the controller; comments are not preserved when it rewrites this file.',
        '',
        'version: 1',
        'settings:',
        '  ui_language: "en"',
        '  timezone: "UTC"',
        '  retention_days: { operations: 90, notifications: 90, messages: 180, calls: 180 }',
        'telegram:',
        '  default_recipients: []',
        '  alerts: false',
        'modems:',
        '  - id: "gsm1"',
        '    driver: "dongle"',
        '    imei: "490154203237542"',
        '    enabled: true',
        '    uac: false',
        '    usb_port: null',
        '    ring: []',
        '    ring_timeout: 120',
        '    incoming_context: null',
        '    group: null',
        '    recipients: null',
        '    ports: null',
        'phones:',
        '  - { number: "501", label: null, secret: "501", outbound: null, context: null, direct_media: false }',
        '',
      ].join('\n'));
      const two = load(fixture('valid-two-modems.yaml')).registry;
      const text = stringify(two);
      assert.deepEqual(parse(text), two);
      assert.equal(stringify(parse(text)), text);
      assert.doesNotMatch(text, /[&*]a\d/, 'no YAML anchors or aliases');
      assertProblems(() => stringify({ version: 1, modems: [] }), [['phones', 'is required']]);
    });

    test('a modem label of a file written before it was removed is read without a problem and left out of the next write', () => {
      const old = readFileSync(fixture('valid-two-modems.yaml'), 'utf8')
        .replace('  - id: gsm1                   # ^[a-z][a-z0-9_]{0,15}$ = driver device name = ${GSM1}\n', '$&    label: "GSM1 Quectel"\n')
        .replace('  - id: gsm2\n', '$&    label: 12\n');
      assert.match(old, /label: "GSM1 Quectel"\n {4}driver: quectel/);
      const registry = parse(old);
      assert.deepEqual(registry, TWO_MODEMS);
      assert.doesNotMatch(stringify(registry), /GSM1 Quectel|label: 12/);
      // only the modem label: the same key on a phone is still checked, and anything else on a modem is still unknown
      const input = base();
      input.modems[0].label = 'GSM1';
      input.modems[1].name = 'GSM2';
      input.phones[0].label = 12;
      assertProblems(() => validate(input), [
        ['modems[1].name', 'unknown key (allowed: id, driver, imei, enabled, uac, usb_port, ring, ring_timeout, incoming_context, group, recipients, ports)'],
        ['phones[0].label', `${MESSAGES.label} (got number 12)`],
      ]);
    });

    test('write goes through <path>.tmp: open, fchmod, write, fsync, close, rename, then fsync of the directory', () => {
      const path = target();
      /** @type {string[]} */
      const calls = [];
      const spied = /** @type {Record<string, (...args: unknown[]) => unknown>} */ (/** @type {unknown} */ (fs));
      for (const name of ['openSync', 'fchmodSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']) {
        const original = spied[name];
        assert.ok(original);
        mock.method(spied, name, (/** @type {unknown[]} */ ...args) => {
          // path arguments of openSync (path, flags) and renameSync (from, to); the second argument of writeFileSync is the content
          const names = name === 'openSync' || name === 'renameSync' ? args.slice(0, 2).map((arg) => basename(String(arg))) : [];
          calls.push([name, ...names].join(' '));
          return original.apply(fs, args);
        });
      }
      const umask = process.umask(0o077);
      let result;
      try {
        result = write(path, base());
      } finally {
        process.umask(umask);
        mock.restoreAll();
      }
      const dir = basename(join(path, '..'));
      assert.deepEqual(calls, ['openSync aster.yaml.tmp w', 'fchmodSync', 'writeFileSync', 'fsyncSync', 'closeSync',
        'renameSync aster.yaml.tmp aster.yaml', `openSync ${dir} r`, 'fsyncSync', 'closeSync']);
      assert.equal(existsSync(`${path}.tmp`), false);
      assert.equal(statSync(path).mode & 0o777, 0o644, 'a new file is 0644 whatever the umask');
      const bytes = readFileSync(path);
      assert.equal(bytes.toString('utf8'), stringify(base()));
      assert.equal(result.hash, sha256(bytes));
      assert.deepEqual(result.flags, []);
      assert.deepEqual(load(path), { registry: result.registry, hash: result.hash, flags: [] });
    });

    test('write rejects an invalid registry before touching the disk and leaves the previous file untouched', () => {
      const path = target();
      write(path, base());
      const before = readFileSync(path);
      const invalid = base();
      invalid.modems[1].imei = invalid.modems[0].imei;
      const opens = mock.method(fs, 'openSync');
      try {
        assertProblems(() => write(path, invalid), [['modems[1].imei', 'duplicate IMEI "490154203237534" (also modems[0].imei)']]);
        assert.equal(opens.mock.callCount(), 0);
      } finally {
        mock.restoreAll();
      }
      assert.deepEqual(readFileSync(path), before);
      assert.equal(existsSync(`${path}.tmp`), false);
    });

    test('a failing rename leaves the previous file and no .tmp behind', () => {
      const path = target();
      write(path, base());
      const before = readFileSync(path);
      const changed = base();
      changed.phones[0].secret = 'changed';
      mock.method(fs, 'renameSync', () => {
        throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      });
      try {
        assert.throws(() => write(path, changed), { message: `cannot write registry ${path} (nothing was replaced): EIO: i/o error, rename` });
      } finally {
        mock.restoreAll();
      }
      assert.deepEqual(readFileSync(path), before);
      assert.equal(existsSync(`${path}.tmp`), false);
      assert.deepEqual(load(path).registry, validate(base()));
    });

    test('a failing write or fsync of the temporary file leaves the previous file and no .tmp behind', () => {
      for (const name of /** @type {const} */ (['writeFileSync', 'fsyncSync'])) {
        const path = target();
        write(path, base());
        const before = readFileSync(path);
        const changed = base();
        changed.phones[0].secret = 'changed';
        mock.method(fs, name, () => {
          throw Object.assign(new Error(`ENOSPC: no space left on device, ${name}`), { code: 'ENOSPC' });
        });
        try {
          assert.throws(() => write(path, changed), { message: `cannot write registry ${path} (nothing was replaced): ENOSPC: no space left on device, ${name}` });
        } finally {
          mock.restoreAll();
        }
        assert.deepEqual(readFileSync(path), before, name);
        assert.equal(existsSync(`${path}.tmp`), false, name);
      }
    });

    test('a failing fsync of the directory is reported, although the new file is in place', () => {
      const path = target();
      write(path, base());
      const changed = base();
      changed.phones[0].secret = 'changed';
      const original = fs.fsyncSync;
      let n = 0;
      mock.method(fs, 'fsyncSync', (/** @type {number} */ fd) => {
        if (++n === 2) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
        return original(fd);
      });
      try {
        assert.throws(() => write(path, changed), { message: `registry ${path} was replaced, but syncing its directory failed: EIO: i/o error, fsync` });
      } finally {
        mock.restoreAll();
      }
      assert.equal(readFileSync(path, 'utf8'), stringify(changed));
    });

    test('a stale .tmp is replaced, an existing file keeps its mode, and write returns the flags', () => {
      const path = target();
      write(path, base());
      chmodSync(path, 0o600);
      writeFileSync(`${path}.tmp`, 'partial content of an interrupted write');
      const unmapped = base();
      delete unmapped.modems[0].usb_port;
      const result = write(path, unmapped);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(existsSync(`${path}.tmp`), false);
      assert.equal(result.hash, sha256(readFileSync(path)));
      assert.deepEqual(result.flags.map((flag) => [flag.path, flag.flag]), [['modems[0]', 'unmapped']]);
    });

    test('load names the path of a missing file', () => {
      const missing = join(root, 'missing', 'aster.yaml');
      assert.throws(() => load(missing), { message: `registry not found: ${missing}` });
    });
  });
});
