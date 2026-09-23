// @ts-check
// The registry config/aster.yaml: load and validate (every problem in one RegistryError), and atomic write in a fixed
// key order (comments are not preserved). One writer at a time is assumed; registry changes run as operations.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { writeAtomic } from './atomic.js';
import { Document, isMap, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml';

/** @typedef {{ path: string, message: string }} Problem  path such as `modems[1].imei`; '' is the file as a whole */
/** @typedef {{ path: string, flag: 'unmapped', message: string }} Flag */
/**
 * @typedef {object} Modem
 * @property {string} id
 * @property {'quectel' | 'dongle'} driver
 * @property {string} imei
 * @property {boolean} enabled
 * @property {boolean} uac
 * @property {string | null} usb_port
 * @property {readonly string[]} ring
 * @property {number} ring_timeout
 * @property {string | null} incoming_context
 * @property {number | null} group
 * @property {readonly string[] | null} recipients
 * @property {{ readonly data: string, readonly audio: string } | null} ports
 */
/**
 * @typedef {object} Phone
 * @property {string} number
 * @property {string | null} label
 * @property {string} secret
 * @property {string | null} outbound
 * @property {string | null} context
 * @property {boolean} direct_media
 */
/**
 * @typedef {object} Registry
 * @property {1} version
 * @property {{ ui_language: 'ru' | 'en', timezone: string, retention_days: { operations: number, notifications: number } }} settings
 * @property {{ default_recipients: readonly string[], alerts: boolean }} telegram
 * @property {readonly Modem[]} modems
 * @property {readonly Phone[]} phones
 */

/** Keys in the order they are written. */
const KEYS = {
  top: ['version', 'settings', 'telegram', 'modems', 'phones'],
  settings: ['ui_language', 'timezone', 'retention_days'],
  retention: ['operations', 'notifications'],
  telegram: ['default_recipients', 'alerts'],
  modem: ['id', 'driver', 'imei', 'enabled', 'uac', 'usb_port', 'ring', 'ring_timeout', 'incoming_context', 'group', 'recipients', 'ports'],
  ports: ['data', 'audio'],
  phone: ['number', 'label', 'secret', 'outbound', 'context', 'direct_media'],
};
/** Keys an older file may still have: read and dropped, so the next write leaves them out. */
const DROPPED = { modem: ['label'] };

/**
 * Values of absent keys. Required keys (version, modems, phones; modem id, driver, imei, enabled; phone number, secret) have none.
 * @type {Readonly<{ settings: Registry['settings'], telegram: Registry['telegram'],
 *   modem: Omit<Modem, 'id' | 'driver' | 'imei' | 'enabled'>, phone: Omit<Phone, 'number' | 'secret'> }>}
 */
export const DEFAULTS = deepFreeze({
  settings: { ui_language: 'en', timezone: 'UTC', retention_days: { operations: 90, notifications: 90 } },
  telegram: { default_recipients: [], alerts: false },
  modem: { uac: false, usb_port: null, ring: [], ring_timeout: 120, incoming_context: null, group: null, recipients: null, ports: null },
  phone: { label: null, outbound: null, context: null, direct_media: false },
});

const ID = /^[a-z][a-z0-9_]{0,15}$/;
const IMEI = /^[0-9]{15}$/;
const USB_PORT = /^[0-9]+-[0-9]+(?:\.[0-9]+)*$/;
const NUMBER = /^[0-9]{3,6}$/;
const CHAT_ID = /^-?[0-9]+$/;
const CONTEXT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,78}$/;
const DEVICE = /^\/dev(?:\/[A-Za-z0-9_.:+@-]+)+$/;
const SECRET = /^[\x21-\x3a\x3c-\x7e]{1,128}$/;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
/** @param {string} value  true when it contains a C0/C1 control character, DEL, or U+2028/U+2029 */
const hasControlCharacter = (value) =>
  [...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });

const MESSAGE = {
  bool: 'must be true or false',
  label: 'must be null or one line of 1 to 64 characters',
  context: 'must be null or an extensions.conf context name (letters, digits, _ . -; at most 79 characters; not aster-…)',
  chatId: 'must be a quoted Telegram chat id: digits with an optional leading -',
  number: 'must be a quoted string of 3 to 6 digits',
  device: 'must be a device path under /dev/',
};

/** Variables Asterisk 20 resolves before any global (main/pbx_variables.c, pbx_retrieve_variable). */
const ASTERISK_VARIABLES = new Set(['CALLINGPRES', 'CALLINGANI2', 'CALLINGTON', 'CALLINGTNS', 'HINT', 'HINTNAME', 'EXTEN', 'CONTEXT',
  'PRIORITY', 'CHANNEL', 'UNIQUEID', 'HANGUPCAUSE', 'EPOCH', 'SYSTEMNAME', 'ASTCACHEDIR', 'ASTETCDIR', 'ASTMODDIR', 'ASTVARLIBDIR',
  'ASTDBDIR', 'ASTKEYDIR', 'ASTDATADIR', 'ASTAGIDIR', 'ASTSPOOLDIR', 'ASTRUNDIR', 'ASTLOGDIR', 'ASTSBINDIR', 'ENTITYID']);
/** Channel variables the generated dialplan reads; while one is unset, a global of that name answers. */
const DIALPLAN_VARIABLES = new Set(['ASTER_MODEM', 'ASTER_DID', 'DIALSTATUS', 'ANSWEREDTIME', 'DIALEDTIME', 'SYSTEMSTATUS', 'SMS_BASE64',
  'SMS_TS', 'SMS_REPORT', 'SMS_REPORT_TYPE', 'SMS_REPORT_TS', 'SMS_REPORT_DT', 'PHONE_JITTERBUFFER']);

/**
 * Why an id that matches ID still cannot name a modem (it becomes the device name, `${<ID>}` and aster-*-<id> contexts), or null.
 * @param {string} id
 */
function reservedId(id) {
  const name = id.toUpperCase();
  if (id === 'internal') return 'aster-phones-internal is the generated context of phones with outbound: null';
  if (/^[gr][0-9]/.test(id)) return 'chan_quectel and chan_dongle read a dial resource g<digit>… or r<digit>… as a group, not a device name';
  if (ASTERISK_VARIABLES.has(name)) return `Asterisk resolves \${${name}} itself, so the global of this modem would never be read`;
  if (DIALPLAN_VARIABLES.has(name)) return `the generated dialplan reads the channel variable \${${name}}`;
  return null;
}

/** Thrown for an invalid registry; `errors` lists every problem found. */
export class RegistryError extends Error {
  /**
   * @param {string} source file path, or a name for input that did not come from a file
   * @param {Problem[]} errors
   */
  constructor(source, errors) {
    const lines = errors.map((e) => `\n  ${e.path || '(file)'}: ${e.message}`).join('');
    super(`invalid registry ${source}: ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'}${lines}`);
    this.name = 'RegistryError';
    this.source = source;
    /** @type {readonly Readonly<Problem>[]} */
    this.errors = deepFreeze(errors.map(({ path, message }) => ({ path, message })));
  }
}

/** @param {unknown} err */
const reason = (err) => (err instanceof Error ? err.message : String(err));
/** @param {string | Uint8Array} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** @param {string} path @param {string} key */
const join = (path, key) => (path === '' ? key : `${path}.${key}`);

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainMapping(value) {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {unknown} value */
function describe(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (isPlainMapping(value)) return 'a mapping';
  if (typeof value === 'object') return `a ${value.constructor?.name ?? 'object'}`;
  return `${typeof value} ${String(value)}`;
}

/** @param {RegExp} pattern */
function matching(pattern) {
  /**
   * @param {unknown} value
   * @returns {value is string}
   */
  function accept(value) {
    return typeof value === 'string' && pattern.test(value);
  }
  return accept;
}
/**
 * @template T
 * @param {(value: unknown) => value is T} accept
 * @returns {(value: unknown) => value is T | null}
 */
const nullable = (accept) => (value) => value === null || accept(value);
/** @param {number} min @param {number} max */
function integer(min, max) {
  /**
   * @param {unknown} value
   * @returns {value is number}
   */
  function accept(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  }
  return accept;
}
/** @type {(value: unknown) => value is boolean} */
const isBoolean = (value) => typeof value === 'boolean';
/** @type {(value: unknown) => value is Modem['driver']} */
const isDriver = (value) => value === 'quectel' || value === 'dongle';
/** @type {(value: unknown) => value is Registry['settings']['ui_language']} */
const isLanguage = (value) => value === 'ru' || value === 'en';
/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isLabel(value) {
  return typeof value === 'string' && value !== '' && [...value].length <= 64 && !hasControlCharacter(value);
}
/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isContext(value) {
  return typeof value === 'string' && CONTEXT.test(value) && !/^aster-/i.test(value);
}
/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isDevice(value) {
  return typeof value === 'string' && value.length <= 255 && DEVICE.test(value) && !value.split('/').some((part) => part === '.' || part === '..');
}

/** @type {(value: unknown) => value is string} */
function isTimezone(value) {
  if (typeof value !== 'string' || !TIMEZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

class Checker {
  /** @type {Problem[]} */
  problems = [];

  /** @param {string} path @param {string} message */
  fail(path, message) {
    this.problems.push({ path, message });
  }

  /**
   * True when `value` is a mapping; its unknown and missing required keys are reported without making it false.
   * @param {unknown} value
   * @param {string} path
   * @param {readonly string[]} keys
   * @param {readonly string[]} [required]
   * @param {readonly string[]} [dropped]  keys taken without a problem and then ignored (DROPPED)
   * @returns {value is Record<string, unknown>}
   */
  mapping(value, path, keys, required = [], dropped = []) {
    if (!isPlainMapping(value)) {
      this.fail(path, `must be a mapping (got ${describe(value)})`);
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key) && !dropped.includes(key)) this.fail(join(path, key), `unknown key (allowed: ${keys.join(', ')})`);
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) this.fail(join(path, key), 'is required');
    }
    return true;
  }

  /**
   * obj[key] when `accept` takes it; `fallback` when the key is absent or (after reporting `message`) rejected.
   * @template T
   * @param {Record<string, unknown>} obj
   * @param {string} key
   * @param {string} path path of obj
   * @param {T} fallback
   * @param {(value: unknown) => value is T} accept
   * @param {string} message
   * @param {{ hideValue?: boolean }} [options] hideValue: do not quote the rejected value (secrets)
   * @returns {T}
   */
  field(obj, key, path, fallback, accept, message, { hideValue = false } = {}) {
    if (!Object.hasOwn(obj, key)) return fallback;
    const value = obj[key];
    if (accept(value)) return value;
    this.fail(join(path, key), hideValue ? message : `${message} (got ${describe(value)})`);
    return fallback;
  }

  /**
   * A list of distinct strings taken by `accept`; other items and repeats are reported. `each` sees every accepted item.
   * @param {unknown} value
   * @param {string} path
   * @param {(item: unknown) => item is string} accept
   * @param {string} message
   * @param {(item: string, path: string) => void} [each]
   * @returns {string[]}
   */
  list(value, path, accept, message, each) {
    if (!Array.isArray(value)) {
      this.fail(path, `must be a list (got ${describe(value)})`);
      return [];
    }
    /** @type {Map<string, string>} */
    const seen = new Map();
    /** @type {string[]} */
    const out = [];
    for (const [index, item] of value.entries()) {
      const itemPath = `${path}[${index}]`;
      if (!accept(item)) {
        this.fail(itemPath, `${message} (got ${describe(item)})`);
        continue;
      }
      const first = seen.get(item);
      if (first !== undefined) {
        this.fail(itemPath, `${JSON.stringify(item)} is already listed at ${first}`);
        continue;
      }
      seen.set(item, itemPath);
      each?.(item, itemPath);
      out.push(item);
    }
    return out;
  }

  /**
   * Reports `value` when another entry already has it.
   * @param {Map<string, string>} seen value → path of its first use
   * @param {string} value
   * @param {string} path
   * @param {string} what
   */
  unique(seen, value, path, what) {
    const first = seen.get(value);
    if (first === undefined) seen.set(value, path);
    else this.fail(path, `duplicate ${what} ${JSON.stringify(value)} (also ${first})`);
  }
}

/**
 * @param {Checker} c
 * @param {unknown} raw
 * @param {string} path
 * @param {{ ids: Map<string, string>, imeis: Map<string, string>, usbPorts: Map<string, string>, devices: Map<string, string>,
 *   phoneNumbers: Set<string> }} seen
 * @returns {Modem | undefined}
 */
function normalizeModem(c, raw, path, seen) {
  if (!c.mapping(raw, path, KEYS.modem, ['id', 'driver', 'imei', 'enabled'], DROPPED.modem)) return undefined;
  const d = DEFAULTS.modem;
  const id = c.field(raw, 'id', path, '', matching(ID), `must match ${ID.source}`);
  if (id !== '') {
    const why = reservedId(id);
    if (why !== null) c.fail(`${path}.id`, `${JSON.stringify(id)} cannot be used: ${why}`);
    c.unique(seen.ids, id, `${path}.id`, 'modem id');
  }
  const driver = c.field(raw, 'driver', path, /** @type {Modem['driver']} */ ('quectel'), isDriver, 'must be quectel or dongle');
  const imei = c.field(raw, 'imei', path, '', matching(IMEI), 'must be a quoted string of 15 digits');
  if (imei !== '') c.unique(seen.imeis, imei, `${path}.imei`, 'IMEI');
  const enabled = c.field(raw, 'enabled', path, false, isBoolean, MESSAGE.bool);
  const uac = c.field(raw, 'uac', path, d.uac, isBoolean, MESSAGE.bool);
  if (uac && raw.driver === 'dongle') c.fail(`${path}.uac`, 'must be false for a dongle modem (UAC audio is quectel only)');
  const usbPort = c.field(raw, 'usb_port', path, d.usb_port, nullable(matching(USB_PORT)), 'must be null or a USB port path such as "1-1.3"');
  if (usbPort !== null) c.unique(seen.usbPorts, usbPort, `${path}.usb_port`, 'usb_port');
  const ring = Object.hasOwn(raw, 'ring')
    ? c.list(raw.ring, `${path}.ring`, matching(NUMBER), MESSAGE.number, (number, itemPath) => {
      if (!seen.phoneNumbers.has(number)) c.fail(itemPath, `phone ${JSON.stringify(number)} is not in phones`);
    })
    : [];
  const ringTimeout = c.field(raw, 'ring_timeout', path, d.ring_timeout, integer(1, 3600), 'must be a whole number of seconds from 1 to 3600');
  const incomingContext = c.field(raw, 'incoming_context', path, d.incoming_context, nullable(isContext), MESSAGE.context);
  const group = c.field(raw, 'group', path, d.group, nullable(integer(0, 2147483647)), 'must be null or a whole number from 0 to 2147483647');
  const recipients = Object.hasOwn(raw, 'recipients') && raw.recipients !== null
    ? c.list(raw.recipients, `${path}.recipients`, matching(CHAT_ID), MESSAGE.chatId)
    : d.recipients;
  /** @type {Modem['ports']} */
  let ports = d.ports;
  const rawPorts = raw.ports;
  if (Object.hasOwn(raw, 'ports') && rawPorts !== null && c.mapping(rawPorts, `${path}.ports`, KEYS.ports, KEYS.ports)) {
    const data = c.field(rawPorts, 'data', `${path}.ports`, '', isDevice, MESSAGE.device);
    const audio = c.field(rawPorts, 'audio', `${path}.ports`, '', isDevice, MESSAGE.device);
    if (data !== '') c.unique(seen.devices, data, `${path}.ports.data`, 'device path');
    if (audio !== '') c.unique(seen.devices, audio, `${path}.ports.audio`, 'device path');
    ports = { data, audio };
  }
  return {
    id, driver, imei, enabled, uac, usb_port: usbPort, ring, ring_timeout: ringTimeout, incoming_context: incomingContext, group, recipients,
    ports,
  };
}

/**
 * @param {Checker} c
 * @param {unknown} raw
 * @param {string} path
 * @param {{ numbers: Map<string, string>, ids: Map<string, string> }} seen
 * @returns {Phone | undefined}
 */
function normalizePhone(c, raw, path, seen) {
  if (!c.mapping(raw, path, KEYS.phone, ['number', 'secret'])) return undefined;
  const d = DEFAULTS.phone;
  const number = c.field(raw, 'number', path, '', matching(NUMBER), MESSAGE.number);
  if (number !== '') c.unique(seen.numbers, number, `${path}.number`, 'phone number');
  const label = c.field(raw, 'label', path, d.label, nullable(isLabel), MESSAGE.label);
  const secret = c.field(raw, 'secret', path, '', matching(SECRET), 'must be 1 to 128 printable ASCII characters without spaces or ";"',
    { hideValue: true });
  const outbound = c.field(raw, 'outbound', path, d.outbound, nullable(matching(ID)), 'must be null or a modem id');
  if (outbound !== null && !seen.ids.has(outbound)) c.fail(`${path}.outbound`, `modem ${JSON.stringify(outbound)} is not in modems`);
  const context = c.field(raw, 'context', path, d.context, nullable(isContext), MESSAGE.context);
  const directMedia = c.field(raw, 'direct_media', path, d.direct_media, isBoolean, MESSAGE.bool);
  return { number, label, secret, outbound, context, direct_media: directMedia };
}

/**
 * @param {Checker} c
 * @param {unknown} input
 * @returns {Registry | undefined}
 */
function normalize(c, input) {
  if (!c.mapping(input, '', KEYS.top, ['version', 'modems', 'phones'])) return undefined;
  if (Object.hasOwn(input, 'version') && input.version !== 1) {
    c.fail('version', `must be 1, the registry version this controller reads (got ${describe(input.version)})`);
  }

  const settings = { ...DEFAULTS.settings, retention_days: { ...DEFAULTS.settings.retention_days } };
  const rawSettings = input.settings;
  if (Object.hasOwn(input, 'settings') && c.mapping(rawSettings, 'settings', KEYS.settings)) {
    settings.ui_language = c.field(rawSettings, 'ui_language', 'settings', settings.ui_language, isLanguage, 'must be ru or en');
    settings.timezone = c.field(rawSettings, 'timezone', 'settings', settings.timezone, isTimezone, 'must be an IANA time zone such as Europe/Istanbul');
    const days = rawSettings.retention_days;
    if (Object.hasOwn(rawSettings, 'retention_days') && c.mapping(days, 'settings.retention_days', KEYS.retention)) {
      for (const key of /** @type {const} */ (['operations', 'notifications'])) {
        settings.retention_days[key] = c.field(days, key, 'settings.retention_days', settings.retention_days[key], integer(1, 36500),
          'must be a whole number of days from 1 to 36500');
      }
    }
  }

  const telegram = { ...DEFAULTS.telegram };
  const rawTelegram = input.telegram;
  if (Object.hasOwn(input, 'telegram') && c.mapping(rawTelegram, 'telegram', KEYS.telegram)) {
    if (Object.hasOwn(rawTelegram, 'default_recipients')) {
      telegram.default_recipients = c.list(rawTelegram.default_recipients, 'telegram.default_recipients', matching(CHAT_ID), MESSAGE.chatId);
    }
    telegram.alerts = c.field(rawTelegram, 'alerts', 'telegram', telegram.alerts, isBoolean, MESSAGE.bool);
  }

  // Ring members are checked against the phone numbers as written, so modem problems stay in document order.
  const phoneNumbers = new Set();
  if (Array.isArray(input.phones)) {
    for (const phone of input.phones) {
      if (isPlainMapping(phone) && typeof phone.number === 'string' && NUMBER.test(phone.number)) phoneNumbers.add(phone.number);
    }
  }
  const ids = new Map();
  /** @type {Modem[]} */
  const modems = [];
  const rawModems = input.modems;
  if (Array.isArray(rawModems)) {
    const seen = { ids, imeis: new Map(), usbPorts: new Map(), devices: new Map(), phoneNumbers };
    for (const [index, raw] of rawModems.entries()) {
      const modem = normalizeModem(c, raw, `modems[${index}]`, seen);
      if (modem) modems.push(modem);
    }
  } else if (Object.hasOwn(input, 'modems')) {
    c.fail('modems', `must be a list (got ${describe(rawModems)})`);
  }

  /** @type {Phone[]} */
  const phones = [];
  const rawPhones = input.phones;
  if (Array.isArray(rawPhones)) {
    const seen = { numbers: new Map(), ids };
    for (const [index, raw] of rawPhones.entries()) {
      const phone = normalizePhone(c, raw, `phones[${index}]`, seen);
      if (phone) phones.push(phone);
    }
  } else if (Object.hasOwn(input, 'phones')) {
    c.fail('phones', `must be a list (got ${describe(rawPhones)})`);
  }

  return { version: 1, settings, telegram, modems, phones };
}

/**
 * Validates a registry value (parsed YAML or API input, not modified) and returns a deep-frozen copy in key order with every
 * default applied. Throws RegistryError listing all problems.
 * @param {unknown} input
 * @param {string} [source] named in the error message
 * @returns {Registry}
 */
export function validate(input, source = 'registry') {
  const c = new Checker();
  const registry = normalize(c, input);
  if (registry === undefined || c.problems.length > 0) throw new RegistryError(source, c.problems);
  return deepFreeze(registry);
}

/** @param {Modem} modem */
export const isUnmapped = (modem) => modem.uac && modem.usb_port === null;

/**
 * Valid but noteworthy entries: `unmapped` = uac: true without usb_port (an enabled one is generated with initstate=stop; UI state unmapped).
 * @param {Registry} registry
 * @returns {Flag[]}
 */
export function flags(registry) {
  /** @type {Flag[]} */
  const out = [];
  for (const [index, modem] of registry.modems.entries()) {
    if (isUnmapped(modem)) {
      out.push({ path: `modems[${index}]`, flag: 'unmapped', message: `${modem.id}: uac is true but usb_port is not set; the modem stays stopped until Scan or Assign sets usb_port` });
    }
  }
  return out;
}

/** @param {import('yaml').YAMLError} err */
function yamlMessage(err) {
  const first = (err.message.split('\n')[0] ?? '').replace(/ at line \d+, column \d+:?$/, '');
  const at = err.linePos?.[0];
  return at ? `line ${at.line}, column ${at.col}: ${first}` : first;
}

/**
 * Parses and validates the text of an aster.yaml. YAML-level problems (syntax, duplicate keys, more than one document,
 * unresolved tags, keys that are not strings, alias expansion) are reported with path '' and their line and column.
 * @param {string} text
 * @param {string} [source]
 * @returns {Registry}
 */
export function parse(text, source = 'registry') {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, version: '1.2', schema: 'core', merge: false, uniqueKeys: true, strict: true });
  /** @type {Problem[]} */
  const problems = [...doc.errors, ...doc.warnings].map((err) => ({ path: '', message: yamlMessage(err) }));
  visit(doc, {
    Pair(_key, pair) {
      if (isScalar(pair.key) && typeof pair.key.value === 'string') return;
      const range = /** @type {{ range?: [number, number, number] } | null} */ (pair.key)?.range;
      const at = range ? lineCounter.linePos(range[0]) : undefined;
      problems.push({ path: '', message: `${at ? `line ${at.line}, column ${at.col}: ` : ''}keys must be strings` });
    },
  });
  if (problems.length > 0) throw new RegistryError(source, problems);
  let value;
  try {
    value = doc.toJS({ maxAliasCount: 100 });
  } catch (err) {
    throw new RegistryError(source, [{ path: '', message: reason(err) }]);
  }
  return validate(value, source);
}

/**
 * Reads, parses and validates a registry file.
 * @param {string} path
 * @returns {Readonly<{ registry: Registry, hash: string, flags: readonly Flag[] }>} hash: sha256 (hex) of the file's bytes
 */
export function load(path) {
  let bytes;
  try {
    bytes = fs.readFileSync(path);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') throw new Error(`registry not found: ${path}`, { cause: err });
    throw new Error(`cannot read registry ${path}: ${reason(err)}`, { cause: err });
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RegistryError(path, [{ path: '', message: 'the file is not valid UTF-8' }]);
  }
  const registry = parse(text, path);
  return Object.freeze({ registry, hash: sha256(bytes), flags: deepFreeze(flags(registry)) });
}

const HEADER = ' Aster registry. Written by the controller; comments are not preserved when it rewrites this file.';

/**
 * YAML text of a validated registry: keys in the order of KEYS, every string double-quoted (unambiguous for YAML 1.1
 * readers too), short lists and phone entries in flow style.
 * @param {Registry} registry
 */
function render(registry) {
  const doc = new Document(registry, { aliasDuplicateObjects: false });
  doc.commentBefore = HEADER;
  /** @param {Array<string | number>} path */
  const flow = (path) => {
    const node = doc.getIn(path, true);
    if (isMap(node) || isSeq(node)) node.flow = true;
  };
  flow(['settings', 'retention_days']);
  flow(['telegram', 'default_recipients']);
  for (const index of registry.modems.keys()) {
    for (const key of ['ring', 'recipients', 'ports']) flow(['modems', index, key]);
  }
  for (const index of registry.phones.keys()) flow(['phones', index]);
  return doc.toString({ lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
}

/**
 * The YAML text `write` would store for `input` (validated first).
 * @param {unknown} input
 */
export function stringify(input) {
  return render(validate(input));
}

/**
 * Validates `input`, then replaces the file atomically. An invalid registry throws RegistryError before the disk is touched.
 * @param {string} path
 * @param {unknown} input
 * @returns {Readonly<{ registry: Registry, hash: string, flags: readonly Flag[] }>}
 */
export function write(path, input) {
  const registry = validate(input, path);
  const text = render(registry);
  let hash;
  try {
    ({ hash } = writeAtomic(path, text));
  } catch (err) {
    const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
    if (err instanceof Error && err.message.startsWith(`${path} was replaced`)) {
      throw new Error(`registry ${path} was replaced, but syncing its directory failed: ${reason(cause)}`, { cause });
    }
    throw new Error(`cannot write registry ${path} (nothing was replaced): ${reason(cause)}`, { cause });
  }
  return Object.freeze({ registry, hash, flags: deepFreeze(flags(registry)) });
}
