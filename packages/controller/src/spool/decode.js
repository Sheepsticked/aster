// @ts-check
// Spool decoder: one `.evt` line from aster-emit (TAB-separated `1 kind event_id modem epoch_s uniqueid fields…`) → a checked
// event. Anything else throws a DecodeError whose reason names the field, never its value (no SMS text or numbers in logs).

/** @typedef {'sms' | 'call-end' | 'sms-report'} Kind */
/** @typedef {'b64x' | 'b64' | 'type' | 'flag'} Codec */
/** @typedef {{ sender: string, text: string, scts: string }} SmsData */
/**
 * @typedef {{ caller: string, did: string, dialstatus: string, answeredtime: string, disposition: string, hangupcause: string,
 *   dialedtime: string }} CallEndData
 */
/** @typedef {{ payload: string, type: 'i' | 'e' | 't', success: '0' | '1', scts: string, dt: string, report: string }} SmsReportData */
/**
 * @typedef {object} EventHeader
 * @property {1} version
 * @property {string} id               event_id (the file is <event_id>.evt)
 * @property {string} modem            modem_id
 * @property {number} emitted          emitted_epoch_s
 * @property {number} emittedMs        epoch milliseconds, from the nanoseconds at the start of the event id
 * @property {string | null} uniqueid  Asterisk's UNIQUEID; null for `-`
 * @property {string[]} fields         the raw fields f1…fn
 */
/**
 * @typedef {EventHeader & ({ kind: 'sms', data: SmsData } | { kind: 'call-end', data: CallEndData }
 *   | { kind: 'sms-report', data: SmsReportData })} SpoolEvent  data: the fields by name, decoded ('' for `-` and for an empty value)
 */

/** The largest file read: Asterisk 20 cuts an application's data at 8191 bytes (main/pbx.c EXT_DATA_SIZE), so a real line is shorter. */
export const MAX_FILE_BYTES = 64 * 1024;

/** @param {Array<[string, Codec]>} fields */
const spec = (...fields) => Object.freeze(fields.map((field) => Object.freeze(field)));
/** Field names and codecs of each kind, in line order. */
export const KINDS = Object.freeze({
  sms: spec(['sender', 'b64x'], ['text', 'b64'], ['scts', 'b64x']),
  'call-end': spec(['caller', 'b64x'], ['did', 'b64x'], ['dialstatus', 'b64x'], ['answeredtime', 'b64x'], ['disposition', 'b64x'],
    ['hangupcause', 'b64x'], ['dialedtime', 'b64x']),
  'sms-report': spec(['payload', 'b64x'], ['type', 'type'], ['success', 'flag'], ['scts', 'b64x'], ['dt', 'b64x'], ['report', 'b64x']),
});

/**
 * SMS_REPORT_TYPE in the spool → `Type` of the AMI …Report event, as both drivers set them: `i` submit result (+CMGS or a send
 * error), `e` status report, `t` no report within the driver's csmsttl.
 */
export const REPORT_TYPES = Object.freeze({ i: 0, e: 1, t: 2 });

const EVENT_ID = /^([0-9]{10,19})-([0-9]{1,10})-([A-Za-z0-9._-]+)$/;
const MODEM_ID = /^[a-z0-9_]+$/;
const UNIQUEID = /^[A-Za-z0-9._-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/;
const SENTINEL = 0x78; // 'x'
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class DecodeError extends Error {
  /** @param {string} reason  what is wrong, naming the field but never its value */
  constructor(reason) {
    super(`malformed spool event: ${reason}`);
    this.name = 'DecodeError';
    this.reason = reason;
  }
}

/**
 * Canonical base64 — padded, zero padding bits, as Asterisk's ast_base64encode writes it — to bytes. Node's own decoder would
 * also accept missing padding, stray characters and appended data.
 * @param {string} field
 * @returns {Buffer}
 */
function base64Bytes(field) {
  if (field === '' || !BASE64.test(field)) throw new DecodeError('invalid base64');
  const bytes = Buffer.from(field, 'base64');
  if (bytes.toString('base64') !== field) throw new DecodeError('non-canonical base64');
  return bytes;
}

/** @param {Uint8Array} bytes */
function utf8Text(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new DecodeError('not UTF-8');
  }
}

/**
 * Decodes a `_b64x` field: `-` → ''; otherwise canonical base64 of `x` followed by UTF-8 text, returned without the `x`.
 * @param {string} field
 * @returns {string}
 */
export function b64x(field) {
  if (field === '-') return '';
  const bytes = base64Bytes(field);
  if (bytes[0] !== SENTINEL) throw new DecodeError('missing x sentinel');
  return utf8Text(bytes.subarray(1));
}

/**
 * Decodes the SMS text field (the driver's SMS_BASE64, no sentinel): `-` → ''; otherwise canonical base64 of UTF-8 text.
 * @param {string} field
 * @returns {string}
 */
export function b64(field) {
  if (field === '-') return '';
  return utf8Text(base64Bytes(field));
}

/**
 * @param {string} field
 * @param {Codec} codec
 * @returns {string}
 */
function decodeField(field, codec) {
  switch (codec) {
    case 'b64x':
      return b64x(field);
    case 'b64':
      return b64(field);
    case 'type':
      if (Object.hasOwn(REPORT_TYPES, field)) return field;
      throw new DecodeError('must be i, e or t');
    case 'flag':
      if (field === '0' || field === '1') return field;
      throw new DecodeError('must be 0 or 1');
    default:
      throw new Error(`unknown codec ${String(codec)}`);
  }
}

/**
 * Parses one spool line (without its LF): version, kind, column count, event id, modem id, uniqueid, emitted time, then every
 * field of the kind. Throws DecodeError.
 * @param {string} line
 * @returns {SpoolEvent}
 */
export function parseLine(line) {
  const columns = line.split('\t');
  if (columns[0] !== '1') throw new DecodeError('unknown version (this controller reads version 1)');
  const kind = columns[1] ?? '';
  if (!Object.hasOwn(KINDS, kind)) throw new DecodeError('unknown kind');
  const fieldSpec = KINDS[/** @type {Kind} */ (kind)];
  if (columns.length !== 6 + fieldSpec.length) {
    throw new DecodeError(`${kind}: expected ${6 + fieldSpec.length} TAB-separated columns, found ${columns.length}`);
  }
  const [, , id = '', modem = '', emitted = '', uniqueid = '', ...fields] = columns;
  const idParts = EVENT_ID.exec(id);
  if (!idParts) throw new DecodeError('invalid event id (expected <epoch_ns>-<pid>-<uniqueid|->)');
  if (!MODEM_ID.test(modem)) throw new DecodeError('invalid modem id');
  if (!UNIQUEID.test(uniqueid)) throw new DecodeError('invalid uniqueid');
  if (idParts[3] !== uniqueid) throw new DecodeError('the event id does not end with the uniqueid column');
  const ns = idParts[1] ?? '';
  if (emitted !== ns.slice(0, -9)) throw new DecodeError('emitted_epoch_s does not match the nanoseconds of the event id');
  if (kind === 'call-end' && uniqueid === '-') throw new DecodeError('call-end without uniqueid');

  /** @type {Record<string, string>} */
  const data = {};
  for (const [index, [name, codec]] of fieldSpec.entries()) {
    const field = fields[index] ?? '';
    const where = `field ${index + 1} (${name})`;
    if (field === '') throw new DecodeError(`${where} is empty`);
    try {
      data[name] = decodeField(field, codec);
    } catch (err) {
      if (err instanceof DecodeError) throw new DecodeError(`${where}: ${err.reason}`);
      throw err;
    }
  }
  const event = {
    version: 1,
    kind,
    id,
    modem,
    emitted: Number(emitted),
    emittedMs: Number(BigInt(ns) / 1_000_000n),
    uniqueid: uniqueid === '-' ? null : uniqueid,
    fields,
    data,
  };
  return /** @type {SpoolEvent} */ (/** @type {unknown} */ (event));
}

/**
 * Checks the bytes of a whole `.evt` file — one line of printable ASCII and TABs ending in LF, at most MAX_FILE_BYTES — and
 * parses the line. Throws DecodeError.
 * @param {Uint8Array} bytes
 * @returns {SpoolEvent}
 */
export function decodeFile(bytes) {
  if (bytes.length === 0) throw new DecodeError('empty file');
  if (bytes.length > MAX_FILE_BYTES) throw new DecodeError(`larger than ${MAX_FILE_BYTES} bytes`);
  const last = bytes.length - 1;
  if (bytes[last] !== 0x0a) throw new DecodeError('no LF at the end (incomplete line)');
  for (let i = 0; i < last; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0x0a) throw new DecodeError('more than one line');
    if (byte === 0x0d) throw new DecodeError('CR in the line (CRLF line end?)');
    if (byte !== 0x09 && (byte < 0x20 || byte > 0x7e)) throw new DecodeError('a byte that is neither printable ASCII nor TAB');
  }
  return parseLine(Buffer.from(bytes.buffer, bytes.byteOffset, last).toString('latin1'));
}
