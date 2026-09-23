// @ts-check
// Line-level scanner for Asterisk configuration files: reads a file the way Asterisk's config loader (main/config.c) does
// and reports each line's kind, section, key and #include target. It does not interpret values and never rewrites anything.

/** @typedef {'section' | 'template' | 'include' | 'exec' | 'kv' | 'arrow' | 'comment' | 'blank' | 'other'} LineKind */
/**
 * @typedef {object} ScannedLine
 * @property {number} no 1-based line number
 * @property {LineKind} kind section: [name] or [name](base,…); template: [name](!); include: #include or #tryinclude;
 *   exec: #exec; kv: key = value or key += value; arrow: key => value; comment: comment text only; blank: blanks only;
 *   other: a line Asterisk ignores or rejects (see error)
 * @property {string | null} section the section the line belongs to: the last header above it in this file, or null
 *   before the first (such key lines continue the includer's section in an #include'd file and make a top-level file
 *   invalid)
 * @property {string} [name] section/template: the text between [ and ], as written (also on a malformed header line, the
 *   name it was meant to have)
 * @property {string[]} [inherits] section/template: the names in (…) other than ! and +…, in order
 * @property {boolean} [append] section/template: (+) — the lines are added to the earlier section of that name
 * @property {string} [directive] lines starting with #: the word after #, in lower case
 * @property {string} [target] include/exec: the argument without enclosing "…" or <…>
 * @property {string} [key] kv/arrow: the name before = or =>
 * @property {string} [value] kv/arrow: the text after it, without comment and enclosing blanks
 * @property {boolean} [plus] kv: written key += value (appends to the last value of key)
 * @property {boolean} [variable] a key line: kv, arrow, or an other line Asterisk reads as a malformed key line
 * @property {string} [error] what Asterisk does with the line when it is not well-formed
 */
/**
 * @typedef {object} ScannedSection
 * @property {number} no
 * @property {string} name
 * @property {boolean} template
 * @property {string[]} inherits
 * @property {boolean} append
 */

/** Longest line Asterisk reads (fgets into char buf[8192]); a longer one is skipped with a WARNING. */
export const MAX_LINE_BYTES = 8190;
/** MAX_NESTED_COMMENTS of main/config.c. */
const MAX_NESTED_COMMENTS = 128;
const NUL = String.fromCharCode(0);
const BOM = String.fromCharCode(0xfeff);
const FATAL = ' — Asterisk rejects the whole file';

const MESSAGE = {
  tooLong: `longer than ${MAX_LINE_BYTES} bytes — Asterisk skips this line`,
  nesting: `more than ${MAX_NESTED_COMMENTS} nested ;-- comments — Asterisk loops on this line forever`,
  unterminated: ';-- opens a comment that no --; closes — Asterisk ignores the rest of the file',
  unmatched: '--; closes no ;-- comment — Asterisk reads the lines after it as a comment',
  noBracket: `no closing ]${FATAL}`,
  noParen: `no closing ) in [name](…)${FATAL}`,
  trailing: 'text after the section header — Asterisk ignores it',
  escape: `\\ at the start of a line must be followed by a visible character${FATAL}`,
  noEquals: 'no = in this line — Asterisk ignores it',
  noName: 'no name before = — Asterisk ignores this line',
};

/** Lower case of A–Z only, as strcasecmp compares. @param {string} value */
export const asciiLower = (value) => value.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * ast_strip: the value without leading and trailing characters below 33 (blanks, CR and other control characters).
 * @param {string} value
 */
export function strip(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) < 33) start++;
  while (end > start && value.charCodeAt(end - 1) < 33) end--;
  return value.slice(start, end);
}

/** @param {string} word */
const shown = (word) => (word.length > 40 ? `${word.slice(0, 40)}…` : word);

/**
 * Where the C string that starts at `from` ends: the first NUL at or after it.
 * @param {string} buf
 * @param {number} from
 */
function cEnd(buf, from) {
  const nul = buf.indexOf(NUL, from);
  return nul === -1 ? buf.length : nul;
}

/**
 * The part of a line that Asterisk parses (not yet stripped), or null when the whole line lies inside a ;-- --; comment.
 * A port of the comment loop of config_text_file_load, which edits a C string in place: a NUL ends the parsed text.
 * @param {string} raw the line without its LF
 * @param {{ depth: number, opened: number[] }} comments nesting depth carried from line to line (negative after a --;
 *   that closed nothing, as in Asterisk) and the line that opened each level
 * @param {number} no
 * @returns {{ content: string | null, problem?: string }}
 */
function uncomment(raw, comments, no) {
  let buf = raw;
  let next = 0; // new_buf
  let start = comments.depth === 0 ? 0 : -1; // process_buf, -1 = NULL
  /** @type {string | undefined} */
  let problem;
  for (;;) {
    const at = buf.indexOf(';', next);
    if (at === -1 || at >= cEnd(buf, next)) break;
    if (at > next && buf[at - 1] === '\\') {
      buf = buf.slice(0, at - 1) + buf.slice(at); // \; is a literal;
      next = at;
    } else if (buf[at + 1] === '-' && buf[at + 2] === '-' && buf[at + 3] !== '-') {
      if (comments.depth >= MAX_NESTED_COMMENTS) {
        problem = MESSAGE.nesting;
        break;
      }
      buf = `${buf.slice(0, at)}${NUL}${buf.slice(at + 1)}`;
      next = at + 3;
      comments.depth++;
      if (comments.depth > 0) comments.opened[comments.depth - 1] = no;
    } else if (at >= next + 2 && buf[at - 1] === '-' && buf[at - 2] === '-') {
      comments.depth--;
      next = at + 1;
      if (comments.depth === -1) problem = MESSAGE.unmatched;
      if (comments.depth === 0) {
        if (start === -1) {
          start = next;
        } else {
          // the text after --; moves over the NUL that ended the text before ;--
          const end = cEnd(buf, start);
          const rest = buf.slice(next, cEnd(buf, next));
          buf = `${buf.slice(0, end)}${rest}${NUL}${buf.slice(end + rest.length + 1)}`;
          next = end;
        }
      }
    } else if (comments.depth === 0) {
      buf = `${buf.slice(0, at)}${NUL}${buf.slice(at + 1)}`;
      next = at;
    } else {
      next = at + 1;
    }
  }
  return { content: start === -1 ? null : buf.slice(start, cEnd(buf, start)), problem };
}

/**
 * [name], [name](!), [name](+), [name](base1,base2) — process_text_line takes the name up to the first ], options only when
 * ( follows at once, and ignores anything after the ) or ].
 * @param {string} cur stripped text starting with [
 * @param {number} no
 * @param {string | null} section
 * @returns {ScannedLine}
 */
function header(cur, no, section) {
  const close = cur.indexOf(']');
  if (close === -1) return { no, kind: 'other', section: cur.slice(1), name: cur.slice(1), error: MESSAGE.noBracket };
  const name = cur.slice(1, close);
  let rest = cur.slice(close + 1);
  let template = false;
  let append = false;
  /** @type {string[]} */
  const inherits = [];
  if (rest.startsWith('(')) {
    const paren = rest.indexOf(')');
    if (paren === -1) return { no, kind: 'other', section: name, name, error: MESSAGE.noParen };
    for (const option of rest.slice(1, paren).split(',')) {
      if (option === '!') template = true;
      else if (option.startsWith('+')) append = true;
      else inherits.push(option);
    }
    rest = rest.slice(paren + 1);
  }
  /** @type {ScannedLine} */
  const line = { no, kind: template ? 'template' : 'section', section: name, name, inherits, append };
  if (rest !== '') line.error = MESSAGE.trailing;
  return line;
}

/**
 * #include / #tryinclude / #exec <argument>: the directive word ends at the first character below 33; "…" or <…> around
 * the argument are removed.
 * @param {string} cur stripped text starting with #
 * @param {number} no
 * @param {string | null} section
 * @returns {ScannedLine}
 */
function directive(cur, no, section) {
  let end = 1;
  while (end < cur.length && cur.charCodeAt(end) > 32) end++;
  const word = cur.slice(1, end);
  const name = asciiLower(word);
  if (name !== 'include' && name !== 'tryinclude' && name !== 'exec') {
    return { no, kind: 'other', section, directive: name, error: `unknown directive #${shown(word)} — Asterisk ignores this line` };
  }
  const kind = name === 'exec' ? 'exec' : 'include';
  const argument = end < cur.length ? strip(cur.slice(end + 1)) : '';
  if (argument === '') return { no, kind, section, directive: name, error: `#${word} needs an argument — Asterisk ignores this line` };
  const open = argument[0];
  const close = open === '<' ? '>' : '"';
  const target = (open === '"' || open === '<') && argument.endsWith(close) ? argument.slice(1, -1) : argument;
  return { no, kind, section, directive: name, target };
}

/**
 * key = value, key => value, key += value; a leading \ makes the next character part of the key.
 * @param {string} cur stripped text
 * @param {number} no
 * @param {string | null} section
 * @returns {ScannedLine}
 */
function assignment(cur, no, section) {
  let body = cur;
  let from = 0;
  if (body.startsWith('\\')) {
    body = body.slice(1);
    if (body === '' || body.charCodeAt(0) < 33) return { no, kind: 'other', section, variable: true, error: MESSAGE.escape };
    from = 1;
  }
  const eq = body.indexOf('=', from);
  if (eq === -1) return { no, kind: 'other', section, variable: true, error: MESSAGE.noEquals };
  const plus = eq > from && body[eq - 1] === '+';
  const arrow = !plus && body[eq + 1] === '>';
  const key = strip(body.slice(0, plus ? eq - 1 : eq));
  if (key === '') return { no, kind: 'other', section, variable: true, error: MESSAGE.noName };
  /** @type {ScannedLine} */
  const line = { no, kind: arrow ? 'arrow' : 'kv', section, key, value: strip(body.slice(eq + (arrow ? 2 : 1))), variable: true };
  if (plus) line.plus = true;
  return line;
}

/**
 * Classifies every line of one configuration file.
 * @param {string} text the file's contents (LF or CRLF line ends; a UTF-8 BOM before line 1 is ignored)
 * @returns {{ lines: ScannedLine[], sections: ScannedSection[], problems: { no: number, message: string }[] }}
 *   sections: every header in order; problems: the comment structure — a ;-- that is never closed (at its line), a --;
 *   that closes nothing, nesting deeper than Asterisk allows
 */
export function scan(text) {
  const physical = text.split('\n');
  if (physical.at(-1) === '') physical.pop();
  /** @type {ScannedLine[]} */
  const lines = [];
  /** @type {ScannedSection[]} */
  const sections = [];
  /** @type {{ no: number, message: string }[]} */
  const problems = [];
  const comments = { depth: 0, opened: /** @type {number[]} */ ([]) };
  /** @type {string | null} */
  let section = null;
  for (const [index, full] of physical.entries()) {
    const no = index + 1;
    if (Buffer.byteLength(full) > MAX_LINE_BYTES) {
      lines.push({ no, kind: 'other', section, error: MESSAGE.tooLong });
      continue;
    }
    const raw = no === 1 && full.startsWith(BOM) ? full.slice(1) : full;
    const { content, problem } = uncomment(raw, comments, no);
    if (problem !== undefined) problems.push({ no, message: problem });
    const cur = content === null ? '' : strip(content);
    /** @type {ScannedLine} */
    let line;
    if (cur === '') {
      line = { no, kind: strip(raw) === '' ? 'blank' : 'comment', section };
    } else if (cur.startsWith('[')) {
      line = header(cur, no, section);
      // A malformed header still names the section its lines were meant for, so they are judged there.
      if (line.name !== undefined) section = line.name;
      if (line.kind === 'section' || line.kind === 'template') {
        sections.push({ no, name: line.name ?? '', template: line.kind === 'template', inherits: line.inherits ?? [], append: line.append ?? false });
      }
    } else if (cur.startsWith('#')) {
      line = directive(cur, no, section);
    } else {
      line = assignment(cur, no, section);
    }
    lines.push(line);
  }
  const opener = comments.depth > 0 ? comments.opened[comments.depth - 1] : undefined;
  if (opener !== undefined) problems.push({ no: opener, message: MESSAGE.unterminated });
  return { lines, sections, problems };
}
