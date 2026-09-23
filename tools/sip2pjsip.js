// @ts-check
// Aster — sip2pjsip: the old chan_sip peers of sip.conf as the registry's `phones:` block.
//
// The old appliance routes a phone's outbound calls by the context its peer is in: `phones` is GSM1, `phones1` is GSM2,
// `default` is internal only (extensions.conf of the old role). Aster routes by `phones[].outbound`, so the conversion is
// that mapping plus the secret, and `canreinvite` becomes `direct_media`. Nothing else of a chan_sip peer has a registry
// equivalent: the transport settings live in the hand-owned pjsip.conf templates now, one place instead of fifteen.
//
// The block it prints is what the controller itself would write for those phones — it is rendered by registry.js after
// validating them, so a peer this tool converts is a peer the appliance accepts. Anything it cannot convert is left out
// and named in the report on stderr; nothing is guessed silently.
//
// Usage: node tools/sip2pjsip.js <sip.conf>    the phones block on stdout, the report on stderr
//   exit 0 = at least one peer converted · 2 = the file could not be read, held no peer, or produced an invalid registry
import { readFileSync } from 'node:fs';
import { RegistryError, stringify } from '../packages/controller/src/config/registry.js';
import { asciiLower, scan } from '../packages/controller/src/config/scan.js';

/** The old dialplan's peer contexts and the modem each one dials out through; null = internal only. */
export const OLD_CONTEXTS = new Map([
  ['phones', 'gsm1'],
  ['phones1', 'gsm2'],
  ['default', null],
]);
/** Sections of sip.conf that are not peers (chan_sip reads them itself). */
const NOT_PEERS = new Set(['general', 'authentication']);
/** chan_sip peer types; a section without one is a friend. */
const TYPES = new Set(['friend', 'peer', 'user']);
/** ast_true(): everything chan_sip reads as yes. */
const TRUE = new Set(['yes', 'true', 'y', 't', '1', 'on']);
/** ast_false(): everything it reads as no. */
const FALSE = new Set(['no', 'false', 'n', 'f', '0', 'off']);
const NUMBER = /^[0-9]{3,6}$/;
const SECRET = /^[\x21-\x3a\x3c-\x7e]{1,128}$/;

/** @typedef {{ kind: 'problem' | 'left out' | 'mapping' | 'assumption' | 'not carried over', message: string }} Note */
/** @typedef {{ number: string, label: null, secret: string, outbound: string | null, context: null, direct_media: boolean }} Phone */

/**
 * The sections of one configuration file as key → value, the last value of a key winning as chan_sip's option loop does.
 * @param {string} text
 * @returns {{ order: string[], sections: Map<string, Map<string, string>>, templates: Set<string>, includes: string[],
 *   fatal: { no: number, message: string }[] }} fatal: lines over which Asterisk rejects the whole file — what is read
 *   here is then not what the appliance was running
 */
export function sections(text) {
  const { lines } = scan(text);
  /** @type {{ no: number, message: string }[]} */
  const fatal = [];
  /** @type {Map<string, Map<string, string>>} */
  const found = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const templates = new Set();
  /** @type {string[]} */
  const includes = [];
  for (const line of lines) {
    if (line.error !== undefined && line.error.includes('rejects the whole file')) fatal.push({ no: line.no, message: line.error });
    if (line.kind === 'section' || line.kind === 'template') {
      const name = line.name ?? '';
      if (!found.has(name)) {
        found.set(name, new Map());
        order.push(name);
      }
      if (line.kind === 'template') templates.add(name);
    } else if (line.kind === 'include' && line.target !== undefined) {
      includes.push(line.target);
    } else if ((line.kind === 'kv' || line.kind === 'arrow') && line.section !== null && line.key !== undefined) {
      found.get(line.section)?.set(asciiLower(line.key), line.value ?? '');
    }
  }
  return { order, sections: found, templates, includes, fatal };
}

/**
 * Converts the peers of a sip.conf text.
 * @param {string} text
 * @returns {{ phones: Phone[], notes: Note[], seen: number }} seen: sections that looked like a peer, converted or not
 */
export function convertSip(text) {
  const file = sections(text);
  /** @type {Phone[]} */
  const phones = [];
  /** @type {Note[]} */
  const notes = [];
  /** @param {Note['kind']} kind @param {string} message */
  const note = (kind, message) => notes.push({ kind, message });
  /** @type {Map<string | null, string[]>} */
  const byOutbound = new Map();
  /** @type {Set<string>} */
  const ignored = new Set();
  let seen = 0;

  for (const { no, message } of file.fatal) note('problem', `line ${no}: ${message} — so this is not the configuration the old appliance was running; fix the line and read it again`);
  for (const target of file.includes) note('problem', `#include ${target} was not followed: run this tool on that file too and merge the two blocks`);
  const general = file.sections.get('general') ?? new Map();
  const fallbackContext = general.get('context') ?? null;

  for (const name of file.order) {
    if (NOT_PEERS.has(asciiLower(name)) || file.templates.has(name)) continue;
    const peer = file.sections.get(name) ?? new Map();
    seen++;
    /** @param {string} why */
    const leaveOut = (why) => note('left out', `[${name}]: ${why}`);

    const type = peer.get('type');
    if (type !== undefined && !TYPES.has(asciiLower(type))) {
      leaveOut(`type=${type} is not a phone`);
      continue;
    }
    if (!NUMBER.test(name)) {
      leaveOut('the section name is the phone number in Aster, and this one is not 3 to 6 digits');
      continue;
    }
    const host = peer.get('host');
    if (host !== undefined && asciiLower(host) !== 'dynamic') {
      leaveOut(`host=${host}: this peer does not register, and the registry has no endpoint with a fixed address`);
      continue;
    }
    const secret = peer.get('secret');
    if (secret === undefined || secret === '') {
      leaveOut(peer.has('md5secret')
        ? 'only md5secret is set, and PJSIP cannot authenticate against an MD5 digest of an unknown password'
        : 'no secret');
      continue;
    }
    if (!SECRET.test(secret)) {
      leaveOut('the secret has a space, a ";" or a character phones.conf cannot carry');
      continue;
    }

    const context = peer.get('context') ?? fallbackContext;
    let outbound = null;
    if (context === null) {
      note('assumption', `[${name}]: no context and no [general] context, so internal only (outbound: null)`);
    } else if (OLD_CONTEXTS.has(context)) {
      outbound = OLD_CONTEXTS.get(context) ?? null;
    } else {
      note('assumption', `[${name}]: context=${context} is not one of the old appliance's (${[...OLD_CONTEXTS.keys()].join(', ')}), so internal only (outbound: null) — set it by hand if this phone dialled out`);
    }

    // canreinvite is chan_sip's old name for directmedia; a file that carries both is ambiguous, so say which was read.
    if (peer.has('directmedia') && peer.has('canreinvite')) {
      note('assumption', `[${name}]: both directmedia and canreinvite are set; this tool read directmedia=${peer.get('directmedia')}`);
    }
    const reinvite = peer.get('directmedia') ?? peer.get('canreinvite');
    let directMedia = false;
    if (reinvite !== undefined) {
      const value = asciiLower(reinvite);
      if (TRUE.has(value)) directMedia = true;
      else if (!FALSE.has(value)) {
        directMedia = true;
        note('assumption', `[${name}]: directmedia=${reinvite} has no equivalent, so direct_media: true (the media does not go through the appliance)`);
      }
    }

    for (const key of peer.keys()) {
      if (!['type', 'host', 'secret', 'context', 'directmedia', 'canreinvite'].includes(key)) ignored.add(key);
    }
    phones.push({ number: name, label: null, secret, outbound, context: null, direct_media: directMedia });
    const group = byOutbound.get(outbound) ?? [];
    group.push(name);
    byOutbound.set(outbound, group);
  }

  for (const [outbound, numbers] of byOutbound) {
    note('mapping', `${numbers.join(', ')} → outbound: ${outbound ?? 'null (internal only)'}`);
  }
  if (ignored.size > 0) {
    note('not carried over', `peer settings with no registry equivalent: ${[...ignored].sort().join(', ')} — the same behaviour is in the pjsip.conf templates now, for every phone at once`);
  }
  note('not carried over', 'the secrets are the phone numbers themselves, as they were: rotate them on the Phones page after the cutover');
  return { phones, notes, seen };
}

/**
 * The `phones:` block exactly as the controller writes it: registry.js validates the phones and renders the whole file,
 * and everything from `phones:` on is the block (it is the last key). The modems are stand-ins that are never
 * printed — they exist so that an `outbound` can be checked against a modem that is there.
 * @param {Phone[]} phones
 * @returns {string}
 */
export function phonesBlock(phones) {
  const ids = [...new Set(phones.map((phone) => phone.outbound).filter((id) => id !== null))];
  const modems = ids.map((id, index) => ({ id, driver: 'quectel', imei: String(index + 1).padStart(15, '0'), enabled: false }));
  const text = stringify({ version: 1, modems, phones });
  const at = text.indexOf('\nphones:');
  if (at === -1) throw new Error('registry.js did not write a phones block'); // unreachable: phones is a required key
  return text.slice(at + 1);
}

/** Report sections, in the order they are printed, with the heading each kind gets. */
const HEADINGS = /** @type {const} */ ([
  ['problem', 'problems'],
  ['left out', 'left out'],
  ['mapping', 'how it was mapped'],
  ['assumption', 'assumptions — check every one of these'],
  ['not carried over', 'not carried over'],
]);

/**
 * The report, in the order the notes were made within each kind.
 * @param {Note[]} notes
 * @param {string[]} [head] lines before the first heading
 */
export function report(notes, head = []) {
  const out = [...head];
  for (const [kind, heading] of HEADINGS) {
    const of = notes.filter((n) => n.kind === kind);
    if (of.length === 0) continue;
    out.push('', `${heading}:`);
    for (const n of of) out.push(`  - ${n.message}`);
  }
  return `${out.join('\n')}\n`;
}

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`sip2pjsip.js: ${message}\n`);
  process.exit(2);
}

const USAGE = 'usage: node tools/sip2pjsip.js <sip.conf>    the phones block on stdout, the report on stderr';

function main() {
  const [path, ...rest] = process.argv.slice(2);
  if (path === '-h' || path === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (path === undefined || path.startsWith('-') || rest.length > 0) fail(USAGE);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { phones, notes, seen } = convertSip(text);
  if (phones.length === 0) fail(`${path} has no peer this tool can convert (${seen} looked at)${report(notes, [''])}`);
  let block;
  try {
    block = phonesBlock(phones);
  } catch (err) {
    if (err instanceof RegistryError) {
      fail(`the phones of ${path} are not a valid registry block:\n  ${err.errors.map((p) => `${p.path}: ${p.message}`).join('\n  ')}`);
    }
    throw err;
  }
  process.stdout.write(block);
  process.stderr.write(report(notes, [`${path}: ${phones.length} of ${seen} peers converted`]));
}

if (import.meta.main) main();
