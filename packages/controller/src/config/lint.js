// @ts-check
// Lint before Apply: lintFile finds what Asterisk or its modules would reject or misread in one file (line 0 = whole
// file); lintRegistryRefs checks the registry against the hand files. The drivers crash Asterisk on an unparsable file.
import { posix } from 'node:path';
import { RELOAD } from './reloadmap.js';
import { asciiLower, scan } from './scan.js';

/** @typedef {import('./scan.js').ScannedLine} ScannedLine */
/** @typedef {import('./registry.js').Registry} Registry */
/** @typedef {{ line: number, message: string }} LintProblem */
/** @typedef {(line: number, message: string) => void} Report */

const FATAL = ' — Asterisk rejects the whole file';

/**
 * Files Asterisk or a module loads by name: the hand-owned files of the reload map. Only in these can a key line above
 * the first section or a base that is not defined above be judged; an #include'd fragment continues its includer.
 */
const TOP_LEVEL = new Set(Object.keys(RELOAD).filter((file) => !file.startsWith('aster.d/')));

/** The generated file each hand-owned file includes, the section the include must sit in, and why. */
const WIRING = /** @type {Record<string, { target: string, section: string | null, why: string }[]>} */ ({
  'extensions.conf': [
    { target: 'aster.d/globals.conf', section: 'globals', why: 'the modem globals (GSM1=Quectel/gsm1, …) are not defined' },
    { target: 'aster.d/modems.conf', section: null, why: 'the generated modem contexts are not loaded' },
  ],
  'pjsip.conf': [{ target: 'aster.d/phones.conf', section: null, why: 'no phone of aster.yaml can register' }],
  'quectel.conf': [{ target: 'aster.d/quectel-devices.conf', section: null, why: 'no quectel modem of aster.yaml is configured' }],
  'dongle.conf': [{ target: 'aster.d/dongle-devices.conf', section: null, why: 'no dongle modem of aster.yaml is configured' }],
});

/** Keys pbx_config reads in a context; every other key there is logged "Unknown directive" and ignored. */
const DIALPLAN_KEYS = new Set(['exten', 'include', 'ignorepat', 'switch', 'lswitch', 'eswitch', 'autohints']);
/** Templates of pjsip.conf that the generated phone sections inherit, with the type each must carry. */
const PHONE_TEMPLATES = /** @type {const} */ ([['aster-phone', 'endpoint'], ['aster-auth', 'auth'], ['aster-aor', 'aor']]);
/** Keys the drivers read only in a device section (dc_uconfig_fill). */
const DEVICE_KEYS = new Set(['imei', 'imsi', 'data', 'audio', 'quec_uac', 'alsadev']);

/**
 * An #include target as Asterisk resolves it: a name relative to /etc/asterisk, or null for a path outside it.
 * @param {string} target
 */
function configName(target) {
  const path = posix.normalize(target.startsWith('/') ? target : `/etc/asterisk/${target}`);
  return path.startsWith('/etc/asterisk/') ? path.slice('/etc/asterisk/'.length) : null;
}

/** @param {ScannedLine} line */
const isHeader = (line) => line.kind === 'section' || line.kind === 'template';
/** @param {ScannedLine} line */
const isKey = (line) => line.kind === 'kv' || line.kind === 'arrow';
/** @param {ScannedLine} line true for #include/#tryinclude/#exec of anything but a generated file */
const isHandInclude = (line) => (line.kind === 'include' || line.kind === 'exec')
  && !(line.target !== undefined && configName(line.target)?.startsWith('aster.d/'));

/**
 * Rules for every file: the scanner's findings, key lines above the first section, bases and (+) targets that are not
 * defined above, empty names, #include targets that do not exist, #exec.
 * @param {string} name
 * @param {ReturnType<typeof scan>} scanned
 * @param {((target: string) => boolean) | undefined} existsInclude
 * @param {Report} report
 */
function common(name, scanned, existsInclude, report) {
  const topLevel = TOP_LEVEL.has(name);
  for (const { no, message } of scanned.problems) report(no, message);
  /** @type {Map<string, { section: boolean, template: boolean }>} lower-case name → kinds defined so far */
  const above = new Map();
  let included = false;
  for (const line of scanned.lines) {
    if (topLevel && line.variable && line.section === null) {
      report(line.no, `key line above the first [section]${FATAL}`);
    } else if (line.error !== undefined) {
      report(line.no, line.error);
    }
    if (isHeader(line)) {
      const lineName = line.name ?? '';
      if (lineName === '') report(line.no, 'empty section name []');
      const known = above.get(asciiLower(lineName));
      if (line.append && topLevel && !included && !known?.section) {
        report(line.no, `[${lineName}](+) adds to a section that is not defined above${FATAL}`);
      }
      for (const base of line.inherits ?? []) {
        if (base === '') {
          if (!above.has('')) report(line.no, `empty name in the (…) of [${lineName}]${FATAL}`);
        } else if (topLevel && !included && !above.has(asciiLower(base))) {
          report(line.no, `[${lineName}] inherits from "${base}", which is not defined above${FATAL}`);
        }
      }
      if (!line.append) {
        const entry = known ?? { section: false, template: false };
        if (line.kind === 'template') entry.template = true;
        else entry.section = true;
        above.set(asciiLower(lineName), entry);
      }
    } else if (line.kind === 'include') {
      included = true;
      if (line.directive === 'include' && line.target !== undefined && existsInclude !== undefined && !existsInclude(line.target)) {
        report(line.no, `#include ${line.target}: no such file${FATAL}`);
      }
    } else if (line.kind === 'exec') {
      included = true;
      report(line.no, '#exec is not allowed: it would run a program each time the file is loaded');
    }
  }
}

/**
 * extensions.conf: only dialplan keys in contexts, no same => before an exten =>, no hand-owned aster-* context, an
 * [internal] context (the generated aster-phones-* contexts include it).
 * @param {ScannedLine[]} lines
 * @param {Report} report
 */
function extensions(lines, report) {
  let context = '';
  let dialplan = false;
  let exten = false;
  let internal = false;
  for (const line of lines) {
    if (isHeader(line)) {
      context = line.name ?? '';
      const lower = asciiLower(context);
      dialplan = lower !== 'general' && lower !== 'globals';
      exten = (line.inherits?.length ?? 0) > 0 || line.append === true;
      if (dialplan && /^aster-/i.test(context)) {
        report(line.no, `[${context}]: names starting with aster- are reserved for the generated contexts of aster.d/modems.conf`);
      }
      if (line.kind === 'section' && context === 'internal') internal = true;
    } else if (isKey(line) && dialplan && line.section !== null) {
      const key = asciiLower(line.key ?? '');
      if (key.startsWith('same')) {
        if (!exten) report(line.no, `same => has no exten => above it in [${context}] — Asterisk ignores it`);
      } else if (key === 'exten') {
        exten = true;
      } else if (!DIALPLAN_KEYS.has(key)) {
        report(line.no, `${line.key} is not a dialplan line (exten, same, include, ignorepat, switch) — Asterisk ignores it in [${context}]`);
      }
    }
  }
  if (!internal && !lines.some(isHandInclude)) report(0, 'no [internal] context: the generated aster-phones-* contexts include it');
}

/**
 * @typedef {object} PjsipSection
 * @property {number} no
 * @property {string} name
 * @property {boolean} template
 * @property {boolean} unknownBase inherits from a name not defined above, so its type cannot be known
 * @property {string | null} inheritedType type of the first base that has one (inherited lines come first)
 * @property {string | null} ownType value of the section's own first type line
 */

/** @param {PjsipSection} section @returns {string | null | undefined} undefined: unknown */
const typeOf = (section) => (section.unknownBase ? undefined : section.inheritedType ?? section.ownType);

/**
 * The sections of a pjsip.conf with their type as res_pjsip sees it (bases resolved by their first definition above, (+)
 * lines added to the section they extend).
 * @param {ScannedLine[]} lines
 * @returns {PjsipSection[]}
 */
function pjsipSections(lines) {
  /** @type {PjsipSection[]} */
  const sections = [];
  /** @type {Map<string, PjsipSection>} */
  const first = new Map();
  /** @type {PjsipSection | null} */
  let current = null;
  for (const line of lines) {
    if (isHeader(line)) {
      const name = line.name ?? '';
      if (line.append) {
        current = first.get(asciiLower(name)) ?? null;
        continue;
      }
      /** @type {PjsipSection} */
      const section = { no: line.no, name, template: line.kind === 'template', unknownBase: false, inheritedType: null, ownType: null };
      for (const baseName of line.inherits ?? []) {
        const base = first.get(asciiLower(baseName));
        const baseType = base === undefined ? undefined : typeOf(base);
        if (baseType === undefined) section.unknownBase = true;
        else if (section.inheritedType === null) section.inheritedType = baseType;
      }
      if (!first.has(asciiLower(name))) first.set(asciiLower(name), section);
      sections.push(section);
      current = section;
    } else if (isKey(line) && current !== null && current.ownType === null && asciiLower(line.key ?? '') === 'type') {
      current.ownType = line.value ?? '';
    }
  }
  return sections;
}

/**
 * pjsip.conf: every section has a type (sorcery ignores one without), no two objects of one type share a name (sorcery
 * then rejects every object of that type), and the templates of the generated phones are templates with the right type
 * above #include aster.d/phones.conf.
 * @param {ScannedLine[]} lines
 * @param {Report} report
 */
function pjsip(lines, report) {
  const sections = pjsipSections(lines);
  /** @type {Map<string, number>} */
  const objects = new Map();
  for (const section of sections) {
    if (section.template) continue;
    const type = typeOf(section);
    if (type === null) {
      report(section.no, `[${section.name}] has no type = line — res_pjsip ignores this section`);
    } else if (type !== undefined) {
      const earlier = objects.get(`${type}\n${section.name}`);
      if (earlier === undefined) objects.set(`${type}\n${section.name}`, section.no);
      else report(section.no, `[${section.name}] is the second ${type} of this name (line ${earlier}) — res_pjsip rejects every ${type}`);
    }
  }
  const include = lines.find((line) => line.kind === 'include' && line.target !== undefined && configName(line.target) === 'aster.d/phones.conf');
  if (include === undefined) return;
  const handIncludeAbove = lines.some((line) => line.no < include.no && isHandInclude(line));
  for (const [name, type] of PHONE_TEMPLATES) {
    const section = sections.find((candidate) => candidate.no < include.no && asciiLower(candidate.name) === name);
    if (section === undefined) {
      if (!handIncludeAbove) report(include.no, `[${name}](!) must be defined above this line: the generated phone sections inherit from it${FATAL}`);
      continue;
    }
    if (!section.template) {
      report(section.no, `[${name}] must be a template, written [${name}](!): as a section res_pjsip also loads it as an object of type ${type}`);
    }
    const actual = typeOf(section);
    if (actual !== undefined && actual !== type) {
      report(section.no, `[${name}] must have type = ${type}: the generated phone sections take their type from it`);
    }
  }
}

/**
 * quectel.conf / dongle.conf: only [general] and [defaults] (device sections, (+) additions to them included, come from
 * aster.yaml), no device keys, no radio, no initstate in [general].
 * @param {string} name
 * @param {ScannedLine[]} lines
 * @param {Report} report
 */
function driverFile(name, lines, report) {
  const generated = name === 'quectel.conf' ? 'aster.d/quectel-devices.conf' : 'aster.d/dongle-devices.conf';
  let device = false;
  for (const line of lines) {
    if (isHeader(line)) {
      const lower = asciiLower(line.name ?? '');
      device = line.kind === 'section' && lower !== 'general' && lower !== 'defaults';
      if (device) report(line.no, `[${line.name}] is a device section: modems are configured in aster.yaml, which generates ${generated}`);
    } else if (isKey(line) && !device && line.section !== null) {
      const key = asciiLower(line.key ?? '');
      if (DEVICE_KEYS.has(key)) report(line.no, `${line.key} belongs to a device: it is set per modem in aster.yaml`);
      else if (key === 'radio') report(line.no, 'radio is set per modem from enabled in aster.yaml: a disabled modem is kept with its radio off');
      else if (key === 'initstate' && asciiLower(line.section) === 'general') {
        report(line.no, 'initstate has no effect in [general]: a default belongs in [defaults], each modem\'s state comes from aster.yaml');
      }
    }
  }
}

/**
 * The includes of generated files: each hand-owned file includes its own once (globals.conf inside [globals]) and no other.
 * @param {string} name
 * @param {ScannedLine[]} lines
 * @param {Report} report
 */
function wiring(name, lines, report) {
  const expected = WIRING[name] ?? [];
  /** @type {Map<string, number>} */
  const found = new Map();
  for (const line of lines) {
    if (line.kind !== 'include' || line.target === undefined) continue;
    const target = configName(line.target);
    if (target === null || !target.startsWith('aster.d/')) continue;
    const want = expected.find((candidate) => candidate.target === target);
    const earlier = found.get(target);
    if (want === undefined) {
      const own = expected.map((candidate) => candidate.target).join(' and ');
      report(line.no, `#include ${line.target}: ${name} must not include this generated file${own ? ` (its own: ${own})` : ''}`);
    } else if (earlier !== undefined) {
      report(line.no, `#include ${line.target} repeats line ${earlier}: the generated sections would be defined twice`);
    } else {
      found.set(target, line.no);
      if (want.section !== null && asciiLower(line.section ?? '') !== want.section) {
        report(line.no, `#include ${line.target} must be inside [${want.section}]: its lines are read as lines of the section above them`);
      }
    }
  }
  for (const want of expected) {
    if (!found.has(want.target)) report(0, `no #include ${want.target}${want.section ? ` inside [${want.section}]` : ''}: without it ${want.why}`);
  }
}

/**
 * Lints one file under config/asterisk.
 * @param {string} name path relative to config/asterisk, e.g. `extensions.conf` (decides the file-specific rules)
 * @param {string} text
 * @param {{ existsInclude?: (target: string) => boolean }} [options] existsInclude(target): whether an #include target
 *   (as written without quotes: relative to /etc/asterisk unless absolute, possibly a glob) names at least one regular
 *   file; without it targets are not checked
 * @returns {LintProblem[]} sorted by line
 */
export function lintFile(name, text, { existsInclude } = {}) {
  const scanned = scan(text);
  /** @type {LintProblem[]} */
  const problems = [];
  /** @type {Report} */
  const report = (line, message) => {
    problems.push({ line, message });
  };
  common(name, scanned, existsInclude, report);
  if (name === 'extensions.conf') extensions(scanned.lines, report);
  else if (name === 'pjsip.conf') pjsip(scanned.lines, report);
  else if (name === 'quectel.conf' || name === 'dongle.conf') driverFile(name, scanned.lines, report);
  wiring(name, scanned.lines, report);
  return problems.sort((a, b) => a.line - b.line);
}

/**
 * The contexts an extensions.conf defines, following #include/#tryinclude of hand-owned files.
 * @param {string} text
 * @param {((target: string) => string | null) | undefined} readInclude
 * @param {Set<string>} contexts
 * @param {Set<string>} visited
 */
function collectContexts(text, readInclude, contexts, visited) {
  for (const line of scan(text).lines) {
    if (line.kind === 'section') {
      const lower = asciiLower(line.name ?? '');
      if (lower !== 'general' && lower !== 'globals') contexts.add(line.name ?? '');
    } else if (line.kind === 'include' && line.target !== undefined && readInclude !== undefined && isHandInclude(line) && !visited.has(line.target)) {
      visited.add(line.target);
      const included = readInclude(line.target);
      if (included !== null) collectContexts(included, readInclude, contexts, visited);
    }
  }
}

/**
 * Checks the registry against the hand-owned files: every incoming_context and phones[].context must be a context of
 * extensions.conf (or of a hand file it includes; context names are case-sensitive), and pjsip.conf must not already
 * define an endpoint, auth or aor named like a registry phone (res_pjsip would reject every object of that type).
 * @param {Registry} reg a validated registry
 * @param {string} extensionsText
 * @param {{ readInclude?: (target: string) => string | null, pjsipText?: string }} [options] readInclude(target): text of a
 *   file named by an #include/#tryinclude of extensions.conf (as written), null when it does not exist; pjsipText: the
 *   hand-owned pjsip.conf
 * @returns {{ path: string, message: string }[]}
 */
export function lintRegistryRefs(reg, extensionsText, { readInclude, pjsipText } = {}) {
  /** @type {Set<string>} */
  const contexts = new Set();
  collectContexts(extensionsText, readInclude, contexts, new Set());
  /** @type {{ path: string, message: string }[]} */
  const problems = [];
  for (const [index, modem] of reg.modems.entries()) {
    if (modem.incoming_context !== null && !contexts.has(modem.incoming_context)) {
      problems.push({ path: `modems[${index}].incoming_context`, message: `context "${modem.incoming_context}" is not defined in extensions.conf` });
    }
  }
  for (const [index, phone] of reg.phones.entries()) {
    if (phone.context !== null && !contexts.has(phone.context)) {
      problems.push({ path: `phones[${index}].context`, message: `context "${phone.context}" is not defined in extensions.conf` });
    }
  }
  if (pjsipText !== undefined) {
    const numbers = new Map(reg.phones.map((phone, index) => [phone.number, index]));
    for (const section of pjsipSections(scan(pjsipText).lines)) {
      const index = numbers.get(section.name);
      const type = typeOf(section);
      if (!section.template && index !== undefined && (type === 'endpoint' || type === 'auth' || type === 'aor')) {
        problems.push({ path: `phones[${index}].number`, message: `pjsip.conf already defines the ${type} [${section.name}] (line ${section.no}); with the generated one res_pjsip rejects every ${type}` });
      }
    }
  }
  return problems;
}
