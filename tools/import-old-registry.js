// @ts-check
// Aster — import-old-registry: the old appliance's configuration as a starter aster.yaml.
//
// What it reads, and why each file:
//   quectel.conf / dongle.conf   the [GSM1]/[GSM2] device sections — IMEI, group, quec_uac, and the context each modem's
//                                incoming calls land in. Both files always hold both slots; which driver actually ran a
//                                slot is not in them.
//   <temp>/GSM<n>type            that answer: the old UI writes `dongle` or `quectel` there when an operator switches a
//                                slot, and reads it back at start-up. Without it the old UI itself stays at its compiled-in
//                                default, `dongle` (asterisk-webui settings.py, utils.py process_modem_type), so that is
//                                what this tool assumes — and says so.
//   <temp>/<driver>GSM<n>        `1` or `0`: the desired state of that slot, re-asserted every 600 s by a UI thread.
//   extensions.conf              the ring group of each modem's context (`exten => s,1,Dial(SIP/…,120,m)`), the Telegram
//                                chat id out of the sendEmail lines, and the DIDs that rang the same group.
//   sip.conf                     the phones, through tools/sip2pjsip.js — a modem's ring group may only name phones that
//                                exist, so the registry is written in one piece or not at all.
//
// The temp directory is never guessed: it is /srv/asterisk/temp on the old host and has to be given, because everything
// derived from it (which driver, and whether the modem was running) is otherwise an assumption the operator must check.
// The Telegram **token** is deliberately not read from the old docker-compose.yml: it belongs in secrets.env, 0600, and is
// typed into install.sh.
//
// Usage: node tools/import-old-registry.js <old files dir> [<temp dir>]    aster.yaml on stdout, the report on stderr
//   exit 0 = a valid registry was written · 2 = a file could not be read, or the result is not a valid registry
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RegistryError, stringify } from '../packages/controller/src/config/registry.js';
import { asciiLower, scan } from '../packages/controller/src/config/scan.js';
import { convertSip, report, sections } from './sip2pjsip.js';

/** @typedef {import('./sip2pjsip.js').Note} Note */
/** @typedef {'quectel' | 'dongle'} Driver */

/** Sections of a driver configuration that are not a device. */
const NOT_DEVICES = new Set(['general', 'defaults']);
/** What the old UI falls back to when it cannot read a slot's type file (settings.py MODEM1_TYPE/MODEM2_TYPE). */
const ASSUMED_DRIVER = /** @type {Driver} */ ('dongle');
/** Extensions of the old modem contexts that are not a DID. */
const NOT_DIDS = new Set(['s', 'sms', 'report', 'ussd']);
const ID = /^[a-z][a-z0-9_]{0,15}$/;
const IMEI = /^[0-9]{15}$/;

/**
 * Splits the arguments of an application call on commas that are not inside () or ${}.
 * @param {string} args
 */
function fields(args) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < args.length; at++) {
    const ch = args[at];
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, at));
      start = at + 1;
    }
  }
  out.push(args.slice(start));
  return out;
}

/**
 * The `exten =>` and `same =>` lines of each context of a dialplan, in file order.
 * @param {string} text
 * @returns {Map<string, { key: string, value: string }[]>}
 */
export function dialplan(text) {
  const { lines } = scan(text);
  /** @type {Map<string, { key: string, value: string }[]>} */
  const contexts = new Map();
  for (const line of lines) {
    if (line.kind === 'section' && line.name !== undefined && !contexts.has(line.name)) contexts.set(line.name, []);
    if (line.kind !== 'arrow' || line.section === null || line.key === undefined) continue;
    contexts.get(line.section)?.push({ key: asciiLower(line.key), value: line.value ?? '' });
  }
  return contexts;
}

/**
 * What one old context says about the modem whose calls land in it.
 * @param {{ key: string, value: string }[]} entries
 * @returns {{ ring: string[], ringTimeout: string | null, dids: string[], recipients: string[] }}
 */
export function readContext(entries) {
  /** @type {string[]} */
  let ring = [];
  /** @type {string | null} */
  let ringTimeout = null;
  /** @type {string[]} */
  const dids = [];
  /** @type {string[]} */
  const recipients = [];
  for (const { key, value } of entries) {
    for (const [, id] of value.matchAll(/(-?[0-9]+)@telegram\.user/g)) {
      if (id !== undefined && !recipients.includes(id)) recipients.push(id);
    }
    if (key !== 'exten') continue;
    const [exten, priority, ...rest] = fields(value);
    if (exten === undefined || priority?.trim() !== '1') continue;
    const call = rest.join(',').trim();
    const dial = /^Dial\((.*)\)$/is.exec(call);
    if (dial?.[1] === undefined) continue;
    const [targets, timeout] = fields(dial[1]);
    const members = [...(targets ?? '').matchAll(/SIP\/([0-9]{3,6})(?=[&,]|$)/g)].map(([, number]) => number ?? '');
    const name = exten.trim();
    if (name === 's') {
      if (ring.length === 0) {
        ring = members;
        ringTimeout = (timeout ?? '').trim() || null;
      }
    } else if (!NOT_DIDS.has(asciiLower(name)) && !name.startsWith('_') && members.length > 0) {
      dids.push(name);
    }
  }
  return { ring, ringTimeout, dids, recipients };
}

/**
 * The device sections of one driver configuration, each already carrying the values of [defaults].
 * @param {string} text
 * @returns {Map<string, Map<string, string>>}
 */
export function driverDevices(text) {
  const file = sections(text);
  const defaults = file.sections.get('defaults') ?? new Map();
  /** @type {Map<string, Map<string, string>>} */
  const devices = new Map();
  for (const name of file.order) {
    if (NOT_DEVICES.has(asciiLower(name)) || file.templates.has(name)) continue;
    devices.set(name, new Map([...defaults, ...(file.sections.get(name) ?? new Map())]));
  }
  return devices;
}

/**
 * @typedef {object} OldFiles
 * @property {Record<Driver, string | null>} drivers  the text of quectel.conf / dongle.conf
 * @property {string | null} extensions
 * @property {string | null} sip
 * @property {Map<string, string>} [temp]  file name → contents of the old /srv/asterisk/temp
 */

/**
 * Builds the starter registry. Nothing is written and nothing is validated here — `stringify` does that.
 * @param {OldFiles} files
 * @returns {{ registry: Record<string, unknown>, notes: Note[] }}
 */
export function importOld(files) {
  /** @type {Note[]} */
  const notes = [];
  /** @param {Note['kind']} kind @param {string} message */
  const note = (kind, message) => notes.push({ kind, message });

  const sip = files.sip === null ? { phones: [], notes: [], seen: 0 } : convertSip(files.sip);
  if (files.sip === null) note('problem', 'no sip.conf: the registry is written without phones, and every ring group with it');
  notes.push(...sip.notes);
  const numbers = new Set(sip.phones.map((phone) => phone.number));

  const contexts = files.extensions === null ? new Map() : dialplan(files.extensions);
  if (files.extensions === null) note('problem', 'no extensions.conf: no ring group and no Telegram recipient could be read');

  /** @type {Map<Driver, Map<string, Map<string, string>>>} */
  const devices = new Map();
  for (const driver of /** @type {Driver[]} */ (['quectel', 'dongle'])) {
    const text = files.drivers[driver];
    if (text !== null) devices.set(driver, driverDevices(text));
    else note('problem', `no ${driver}.conf: a slot the old appliance ran with ${driver} cannot be imported`);
  }
  /** @type {string[]} */
  const slots = [];
  for (const of of devices.values()) for (const name of of.keys()) if (!slots.includes(name)) slots.push(name);
  if (slots.length === 0) note('problem', 'no device section in either driver configuration: the registry has no modem');

  const temp = files.temp;
  if (temp === undefined) {
    note('assumption', `no temp directory was given, so for every slot: the driver is ${ASSUMED_DRIVER} (what the old UI itself falls back to when it cannot read the type file) and the modem was running. Both are on the old host in /srv/asterisk/temp — tools/hw-probe.sh prints them`);
  }

  /** @type {Record<string, unknown>[]} */
  const modems = [];
  /** @type {string[][]} */
  const recipientsSeen = [];
  /** @type {string[]} the old section of each entry of `modems`, which a note names it by */
  const slotOf = [];
  for (const slot of slots) {
    /** @param {string} message */
    const about = (message) => `${slot}: ${message}`;

    /** @type {Driver} */
    let driver = ASSUMED_DRIVER;
    const typed = temp?.get(`${slot}type`)?.trim();
    if (typed === 'quectel' || typed === 'dongle') {
      driver = typed;
      note('mapping', about(`driver ${driver} (${slot}type)`));
    } else if (typed !== undefined) {
      note('assumption', about(`${slot}type says ${JSON.stringify(typed)}, which is neither driver, so ${driver} is assumed`));
    }
    if (!devices.get(driver)?.has(slot)) {
      const other = /** @type {Driver} */ (driver === 'quectel' ? 'dongle' : 'quectel');
      if (!devices.get(other)?.has(slot)) {
        note('problem', about(`no [${slot}] section in either driver configuration — left out`));
        continue;
      }
      note('assumption', about(`there is no [${slot}] in ${driver}.conf, so the section of ${other}.conf is used and the driver is ${other}`));
      driver = other;
    }
    const device = devices.get(driver)?.get(slot) ?? new Map();

    const id = asciiLower(slot);
    if (!ID.test(id)) {
      note('problem', about(`"${id}" cannot be a modem id (${ID.source}) — left out; rename the section or add the modem by hand`));
      continue;
    }
    const imei = device.get('imei')?.trim() ?? '';
    if (!IMEI.test(imei)) {
      note('problem', about(imei === ''
        ? `[${slot}] in ${driver}.conf has no imei, and Aster identifies a modem by its IMEI — left out; read it from the modem (\`${driver} show devices\`) and add it by hand`
        : `[${slot}] in ${driver}.conf has imei=${imei}, which is not 15 digits — left out`));
      continue;
    }
    note('assumption', about(`IMEI ${imei} taken from [${slot}] of ${driver}.conf`));

    const state = temp?.get(`${driver}${slot}`)?.trim();
    let enabled = true;
    if (state === '0' || state === '1') {
      enabled = state === '1';
      note('mapping', about(`${enabled ? 'enabled' : 'disabled'} (${driver}${slot} = ${state})`));
    } else if (state !== undefined) {
      note('assumption', about(`${driver}${slot} says ${JSON.stringify(state)}, which is neither 0 nor 1, so enabled: true`));
    } else if (temp !== undefined) {
      note('assumption', about(`there is no ${driver}${slot} in the temp directory, so enabled: true`));
    }

    // Both drivers accept data =/audio = instead of discovery by IMEI; the registry has the same escape hatch, but
    // `imei` stays required, so the ports are worth naming rather than carrying (the operator decides after the probe).
    const data = device.get('data')?.trim();
    const audio = device.get('audio')?.trim();
    if (data !== undefined && audio !== undefined) {
      note('not carried over', about(`[${slot}] names its ttys directly (data = ${data}, audio = ${audio}); Aster finds them from the IMEI, and only a modem its driver cannot discover needs ports: { data: …, audio: … } — tools/hw-probe.sh says which`));
    }

    const quecUac = device.get('quec_uac')?.trim();
    const uac = driver === 'quectel' && quecUac === '1';
    if (quecUac !== undefined && quecUac !== '1' && driver === 'quectel') {
      note('mapping', about(`quec_uac=${quecUac} is not 1, so uac: false (chan_quectel compares it with "1")`));
    }

    const contextName = device.get('context')?.trim() ?? '';
    const context = contexts.get(contextName);
    if (contextName === '') note('problem', about(`[${slot}] has no context, so no ring group could be read`));
    else if (context === undefined) note('problem', about(`context=${contextName} is not in extensions.conf, so no ring group could be read`));
    const read = readContext(context ?? []);
    // A ring group is a set: the registry refuses a number twice, and one Dial string that names a phone twice would
    // otherwise make the whole import invalid instead of producing a starting point.
    const once = [...new Set(read.ring)];
    if (once.length !== read.ring.length) note('mapping', about(`the Dial of [${contextName}] names a phone more than once; a ring group is a set, so each is listed once`));
    const ring = once.filter((number) => {
      if (numbers.has(number)) return true;
      note('problem', about(`${number} rang in [${contextName}] but is not a phone in sip.conf — left out of the ring group`));
      return false;
    });
    let ringTimeout = 120;
    if (read.ringTimeout !== null && read.ringTimeout !== '') {
      const seconds = Number(read.ringTimeout);
      if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600) ringTimeout = seconds;
      else note('assumption', about(`the Dial of [${contextName}] rings for ${read.ringTimeout}, which is not a whole number of seconds from 1 to 3600, so ring_timeout: 120`));
    } else if (context !== undefined) {
      note('assumption', about(`the Dial of [${contextName}] has no timeout, so ring_timeout: 120`));
    }
    if (ring.length > 0) note('mapping', about(`ring ${ring.join(', ')} for ${ringTimeout} s (Dial of [${contextName}] exten s)`));
    for (const did of read.dids) {
      note('not carried over', about(`${did} rang the same group as s in [${contextName}]: a DID no longer needs configuring — the generated ingress routes any DID to the ring group`));
    }

    const group = device.get('group')?.trim();
    let groupValue = /** @type {number | null} */ (null);
    if (group !== undefined && group !== '') {
      const value = Number(group);
      if (Number.isInteger(value) && value >= 0 && value <= 2147483647) groupValue = value;
      else note('assumption', about(`group=${group} is not a whole number, so group: null`));
    }

    recipientsSeen.push(read.recipients);
    slotOf.push(slot);
    modems.push({
      id,
      driver,
      imei,
      enabled,
      uac,
      usb_port: null,
      ring,
      ring_timeout: ringTimeout,
      incoming_context: null,
      group: groupValue,
      recipients: read.recipients,
      ports: null,
    });
    if (uac) note('assumption', about('usb_port unknown — it is not in the old configuration at all (the old ALSA card was named after the IMEI): the modem stays stopped until Scan and Assign fill it in'));
    else note('assumption', about('usb_port unknown — run Scan and Assign after the cutover'));
  }

  // Two slots with the same IMEI are one modem (the old UI allowed it); the registry refuses a duplicate, so the
  // running slot keeps the modem and the other is left out and named.
  /** @type {Map<string, number>} */
  const byImei = new Map();
  for (const [index, modem] of modems.entries()) {
    const imei = /** @type {string} */ (modem.imei);
    const earlier = byImei.get(imei);
    if (earlier === undefined) {
      byImei.set(imei, index);
      continue;
    }
    const keep = modems[earlier];
    // Prefer the slot that was enabled; between two of a kind, the first in file order.
    const [kept, dropped] = keep?.enabled === true || modem.enabled !== true ? [earlier, index] : [index, earlier];
    byImei.set(imei, kept);
    const gone = /** @type {Record<string, unknown>} */ (modems[dropped]);
    note('problem', `${slotOf[dropped]}: has the same IMEI ${imei} as ${slotOf[kept]} — one modem cannot be two entries, so this slot is left out (its ring ${JSON.stringify(gone.ring)} and its phones' outbound are not carried); the old UI's "change IMEI" can point two slots at one device, which is what this looks like`);
    gone.imei = null;
  }
  const dropped = new Set([...modems.entries()].filter(([, modem]) => modem.imei === null).map(([index]) => index));
  for (const index of [...dropped].sort((a, b) => b - a)) {
    modems.splice(index, 1);
    recipientsSeen.splice(index, 1);
  }
  const keptIds = new Set(modems.map((modem) => modem.id));
  for (const phone of sip.phones) {
    if (phone.outbound !== null && !keptIds.has(phone.outbound)) {
      note('problem', `${phone.number}: dialled out through ${phone.outbound}, which is left out, so outbound: null (internal only)`);
      phone.outbound = null;
    }
  }

  // One recipient list for everybody is the old appliance's own arrangement, so it becomes the default and the modems
  // carry `recipients: null`; a modem that notified somebody else keeps its own list.
  const first = recipientsSeen.find((list) => list.length > 0) ?? [];
  for (const [index, modem] of modems.entries()) {
    const own = recipientsSeen[index] ?? [];
    if (own.length === 0 && first.length > 0) {
      note('problem', `${modem.id}: no Telegram recipient in its context, so recipients: [] — nobody is notified about this modem until Settings says otherwise`);
    } else if (own.join(',') === first.join(',')) {
      modem.recipients = null;
    }
  }
  if (first.length === 0) note('problem', 'no Telegram chat id was found in extensions.conf: set the recipients on the Settings page');
  else note('mapping', `Telegram recipients ${first.join(', ')} (the sendEmail lines of extensions.conf)`);
  note('not carried over', 'the Telegram bot token: it is an environment variable of the old docker-compose.yml and belongs in data/config/secrets.env of the appliance (0600), which install.sh asks for — this tool deliberately does not read it. Rotate it: the old one is in the old repository\'s history');
  note('assumption', 'settings.timezone stays UTC — the old appliance has no time zone setting; set it on the Settings page');
  note('not carried over', 'the SMS history /var/lib/asterisk/sms_GSM.txt stays a file: copy it to data/state/old/ of the appliance');

  return {
    registry: {
      version: 1,
      settings: { ui_language: 'en', timezone: 'UTC', retention_days: { operations: 90, notifications: 90, messages: 180, calls: 180 } },
      telegram: { default_recipients: first, alerts: false },
      modems,
      phones: sip.phones,
    },
    notes,
  };
}

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`import-old-registry.js: ${message}\n`);
  process.exit(2);
}

/**
 * Reads `name` from `<dir>` or from `<dir>/asterisk` (the old role keeps its Asterisk files one level down).
 * @param {string} dir
 * @param {string} name
 * @returns {{ text: string, path: string } | null}
 */
function readOne(dir, name) {
  for (const path of [join(dir, name), join(dir, 'asterisk', name)]) {
    try {
      return { text: readFileSync(path, 'utf8'), path };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') fail(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

const USAGE = 'usage: node tools/import-old-registry.js <old files dir> [<temp dir>]    aster.yaml on stdout, the report on stderr';

function main() {
  const [dir, tempDir, ...rest] = process.argv.slice(2);
  if (dir === '-h' || dir === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (dir === undefined || dir.startsWith('-') || rest.length > 0) fail(USAGE);

  /** @type {string[]} */
  const head = [];
  /** @param {string} name */
  const read = (name) => {
    const found = readOne(dir, name);
    head.push(`  ${found === null ? `${name}: not found` : found.path}`);
    return found?.text ?? null;
  };
  head.push('read:');
  const files = {
    drivers: { quectel: read('quectel.conf'), dongle: read('dongle.conf') },
    extensions: read('extensions.conf'),
    sip: read('sip.conf'),
    ...(tempDir === undefined ? {} : { temp: readTemp(tempDir) }),
  };
  if (tempDir !== undefined) head.push(`  ${tempDir}: ${[...(files.temp?.keys() ?? [])].join(', ') || 'no state file'}`);
  if (files.drivers.quectel === null && files.drivers.dongle === null && files.extensions === null && files.sip === null) {
    fail(`${dir} holds none of the old appliance's files (quectel.conf, dongle.conf, extensions.conf, sip.conf), in it or in its asterisk/ subdirectory`);
  }

  const { registry, notes } = importOld(files);
  let text;
  try {
    text = stringify(registry);
  } catch (err) {
    if (err instanceof RegistryError) {
      fail(`the old configuration does not make a valid registry:\n  ${err.errors.map((p) => `${p.path}: ${p.message}`).join('\n  ')}${report(notes, [''])}`);
    }
    throw err;
  }
  process.stdout.write(text);
  const modems = /** @type {unknown[]} */ (registry.modems).length;
  const phones = /** @type {unknown[]} */ (registry.phones).length;
  process.stderr.write(`${report(notes, [...head, '', `wrote a registry with ${modems} modem(s) and ${phones} phone(s)`])}\nreview every line above, this file is a starting point, not a migration.\n`);
}

/**
 * Every file of the old `/srv/asterisk/temp`, by name — not a fixed list, because the state files are named after the
 * slots and an appliance may have other names than GSM1/GSM2.
 * @param {string} dir
 */
function readTemp(dir) {
  /** @type {Map<string, string>} */
  const found = new Map();
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return fail(`cannot read the temp directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const entry of names.filter((e) => e.isFile()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    try {
      found.set(entry.name, readFileSync(join(dir, entry.name), 'utf8'));
    } catch (err) {
      fail(`cannot read ${join(dir, entry.name)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return found;
}

if (import.meta.main) main();
