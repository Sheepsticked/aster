// @ts-check
// Aster controller — AMI stream parser: bytes of a manager session → the banner line, then header packets.
// Only the one space after a header's colon is dropped, so CLI output keeps its indentation; repeated names collect their
// values in order. The legacy `Response: Follows` Command answer (Asterisk ≤ 13) is turned into the same shape.
// Usage: const parser = new AmiParser(); for (const packet of parser.push(chunk)) packet.get('Event'); parser.banner
//        (one parser per connection: after a thrown AmiProtocolError the stream cannot be resynchronised)

/** A packet: header name → its value, or the values of a repeated name in arrival order. */
/** @typedef {Map<string, string | string[]>} Packet */

export const BANNER_PREFIX = 'Asterisk Call Manager/';
/** Largest banner line or packet accepted; far above any real packet (the biggest are Command outputs of a few hundred KiB). */
export const MAX_PACKET_BYTES = 8 * 1024 * 1024;

const CRLF = Buffer.from('\r\n');
const END = Buffer.from('\r\n\r\n');
const FOLLOWS = Buffer.from('Response: Follows\r\n');
const END_COMMAND = Buffer.from('--END COMMAND--\r\n\r\n');

export class AmiProtocolError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AmiProtocolError';
  }
}

/**
 * @param {Packet} packet
 * @param {string} name
 * @param {string} value
 */
function add(packet, name, value) {
  const previous = packet.get(name);
  if (previous === undefined) packet.set(name, value);
  else if (Array.isArray(previous)) previous.push(value);
  else packet.set(name, [previous, value]);
}

/**
 * @param {Packet} packet
 * @param {string} line  one header line without its CRLF
 */
function addLine(packet, line) {
  const colon = line.indexOf(':');
  if (colon < 0) {
    add(packet, '', line);
    return;
  }
  const value = line.slice(colon + 1);
  add(packet, line.slice(0, colon), value.startsWith(' ') ? value.slice(1) : value);
}

/**
 * `Name: value` lines of a packet body (the text before its terminating empty line).
 * @param {string} text
 * @returns {Packet}
 */
function parseHeaders(text) {
  /** @type {Packet} */
  const packet = new Map();
  for (const line of text.split('\r\n')) addLine(packet, line);
  return packet;
}

/**
 * The Asterisk ≤ 13 Command answer without its `--END COMMAND--\r\n\r\n`: the three header lines in the order action_command
 * writes them, then CLI output split at `\n` like Asterisk 20 splits it into Output headers (a CR stays in the line).
 * @param {string} text  starts with `Response: Follows\r\n`
 * @returns {Packet}
 */
function parseFollows(text) {
  /** @type {Packet} */
  const packet = new Map();
  let rest = text;
  for (const name of ['Response', 'Privilege', 'ActionID']) {
    const eol = rest.indexOf('\r\n');
    if (!rest.startsWith(`${name}: `) || eol < 0) continue;
    addLine(packet, rest.slice(0, eol));
    rest = rest.slice(eol + 2);
  }
  if (rest === '') return packet;
  const lines = rest.split('\n');
  if (rest.endsWith('\n')) lines.pop();
  for (const line of lines) add(packet, 'Output', line);
  return packet;
}

export class AmiParser {
  /** The server's first line without its CRLF, once received (`Asterisk Call Manager/9.0.0` for Asterisk 20). */
  /** @type {string | null} */
  banner = null;
  /** @type {Buffer} */
  #pending = Buffer.alloc(0);
  /** Bytes of #pending already searched for the current terminator. */
  #scanned = 0;
  #maxPacketBytes;

  /** @param {{ maxPacketBytes?: number }} [options] */
  constructor({ maxPacketBytes = MAX_PACKET_BYTES } = {}) {
    this.#maxPacketBytes = maxPacketBytes;
  }

  /**
   * Feeds bytes read from the socket and returns the packets they complete, in stream order (empty packets are skipped).
   * @param {Buffer} chunk
   * @returns {Packet[]}
   * @throws {AmiProtocolError} the first line is not an AMI banner, or a line/packet exceeds maxPacketBytes
   */
  push(chunk) {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    /** @type {Packet[]} */
    const packets = [];
    for (;;) {
      if (this.banner !== null) this.#skipEmptyLines();
      const pending = this.#pending;
      const terminator = this.banner === null ? CRLF
        : pending.subarray(0, FOLLOWS.length).equals(FOLLOWS) ? END_COMMAND : END;
      const at = pending.indexOf(terminator, Math.max(0, this.#scanned - terminator.length + 1));
      if (at < 0) {
        this.#scanned = pending.length;
        if (pending.length > this.#maxPacketBytes) this.#tooLarge();
        return packets;
      }
      if (at > this.#maxPacketBytes) this.#tooLarge();
      const text = pending.subarray(0, at).toString('utf8');
      this.#pending = pending.subarray(at + terminator.length);
      this.#scanned = 0;
      if (this.banner === null) {
        if (!text.startsWith(BANNER_PREFIX)) throw new AmiProtocolError(`not an AMI banner: ${JSON.stringify(text.slice(0, 80))}`);
        this.banner = text;
      } else {
        const packet = terminator === END_COMMAND ? parseFollows(text) : parseHeaders(text);
        if (packet.size > 0) packets.push(packet);
      }
    }
  }

  /** Drops CRLFs between packets, so a stray empty line neither hides a `Response: Follows` nor yields an empty packet. */
  #skipEmptyLines() {
    let start = 0;
    while (this.#pending.length - start >= 2 && this.#pending[start] === 0x0d && this.#pending[start + 1] === 0x0a) start += 2;
    if (start === 0) return;
    this.#pending = this.#pending.subarray(start);
    this.#scanned = Math.max(0, this.#scanned - start);
  }

  /** @returns {never} */
  #tooLarge() {
    throw new AmiProtocolError(`AMI packet larger than ${this.#maxPacketBytes} bytes`);
  }
}

/**
 * The first value of a header (Asterisk's own lookup also takes the first), or undefined.
 * @param {Packet} packet
 * @param {string} name
 * @returns {string | undefined}
 */
export function headerValue(packet, name) {
  const value = packet.get(name);
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Every value of a header in arrival order; [] when absent.
 * @param {Packet} packet
 * @param {string} name
 * @returns {string[]}
 */
export function headerValues(packet, name) {
  const value = packet.get(name);
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}
