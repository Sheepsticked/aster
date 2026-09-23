// @ts-check
// Aster controller — AMI client: one TCP session to Asterisk with Login, actions matched by ActionID, Command output, list
// actions, keepalive and reconnect with backoff. 'up' only after FullyBooted, so no action races module loading.
// Events are emitted synchronously in stream order: subscribe before sending an action whose events matter.
// Usage: const ami = new AmiClient({ log }); await ami.connect({ host: '127.0.0.1', port: 5038, username: 'aster', secret });
//        await ami.command('core show uptime'); await ami.list('QuectelShowDevices', {}, 'QuectelShowDevicesComplete'); await ami.close()
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { AmiParser, headerValue, headerValues, MAX_PACKET_BYTES } from './parser.js';

/** @typedef {import('./parser.js').Packet} Packet */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {string | number | ReadonlyArray<string | number>} HeaderValue */
/** @typedef {Readonly<Record<string, HeaderValue>>} Headers */
/** @typedef {{ host: string, port: number, username: string, secret: string }} Target */
/** @typedef {'idle' | 'connecting' | 'booting' | 'up' | 'closed'} State */
/**
 * @typedef {object} Options
 * @property {Logger} [log]
 * @property {number} [actionTimeoutMs]   default timeout of action/command/list (10 s)
 * @property {number} [connectTimeoutMs]  TCP connect + banner + Login answer (10 s)
 * @property {number} [bootTimeoutMs]     Login answer → FullyBooted (120 s; the AMI user needs read=system to receive it)
 * @property {number} [pingIntervalMs]    keepalive period while logged in (30 s)
 * @property {number} [pingTimeoutMs]     a Ping unanswered this long drops the connection (10 s)
 * @property {number} [backoffMinMs]      first reconnect delay (1 s)
 * @property {number} [backoffMaxMs]      reconnect delay cap (30 s)
 * @property {number} [maxPacketBytes]    parser limit (parser.js MAX_PACKET_BYTES)
 */
/**
 * @typedef {object} Pending
 * @property {string} action
 * @property {number} order   send order (Asterisk answers a session's requests one at a time, in this order)
 * @property {(response: Packet, events: Packet[]) => void} resolve
 * @property {(err: Error) => void} reject
 * @property {NodeJS.Timeout | null} timer
 * @property {{ complete: string, events: Packet[] } | null} list
 */
/**
 * @typedef {object} Connection
 * @property {net.Socket} socket
 * @property {AmiParser} parser
 * @property {Error | null} reason   why it ends (first failure wins)
 * @property {boolean} loginSent
 * @property {boolean} loggedIn
 * @property {boolean} booted       FullyBooted received
 * @property {NodeJS.Timeout | null} timer       connect or boot deadline
 * @property {NodeJS.Timeout | null} pingTimer
 * @property {boolean} pinging
 */

export const DEFAULTS = Object.freeze({
  actionTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  bootTimeoutMs: 120_000,
  pingIntervalMs: 30_000,
  pingTimeoutMs: 10_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  maxPacketBytes: MAX_PACKET_BYTES,
});

/** Longest request line Asterisk reads whole, CRLF included (main/manager.c: `char inbuf[1025]` of a session). */
export const MAX_LINE_BYTES = 1024;
/** Most header lines Asterisk keeps from one request (main/manager.c: AST_MAX_MANHEADERS). */
export const MAX_HEADERS = 128;
/** ActionIDs a caller may choose: the AtCommand patch's charset; `ami-…` stays reserved for generated ones. */
const ACTION_ID = /^[A-Za-z0-9._-]{1,63}$/;
const NAME = /^[A-Za-z0-9_-]+$/;
const MAX_TIMER_MS = 2 ** 31 - 1;

export class AmiError extends Error {
  /**
   * `Response: Error`: the message is the response's Message header.
   * @param {string} message
   * @param {Packet} response
   */
  constructor(message, response) {
    super(message);
    this.name = 'AmiError';
    this.response = response;
    /** The Output lines a failed Command carries (`No such command …`), a trailing CR dropped from each. */
    this.output = outputLines(response);
  }
}

export class AmiTimeout extends Error {
  /**
   * @param {string} action
   * @param {string} actionId
   * @param {number} timeoutMs
   */
  constructor(action, actionId, timeoutMs) {
    super(`AMI ${action} (${actionId}) got no response within ${timeoutMs} ms`);
    this.name = 'AmiTimeout';
    this.action = action;
    this.actionId = actionId;
  }
}

export class AmiDisconnected extends Error {
  /**
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AmiDisconnected';
  }
}

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/**
 * Reconnect delay before attempt `attempt` (0-based): min, 2·min, 4·min … capped at max.
 * @param {number} attempt
 * @param {number} minMs
 * @param {number} maxMs
 */
export function backoffDelay(attempt, minMs, maxMs) {
  return Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
}

/**
 * @param {string} what
 * @param {unknown} name
 * @returns {string}
 */
function checkName(what, name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`${what} must match ${NAME}: ${JSON.stringify(name)}`);
  return name;
}

/**
 * A header value as it goes on the wire; never echoes the value in an error (it may be a secret).
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function checkValue(name, value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`AMI header ${name} must be a finite number`);
    return String(value);
  }
  if (typeof value !== 'string') throw new TypeError(`AMI header ${name} must be a string or a number`);
  if (/[\r\n\0]/.test(value)) throw new TypeError(`AMI header ${name} contains CR, LF or NUL`);
  // Asterisk skips every byte below 0x21 at the start of a value (ast_skip_blanks in astman_get_header): it would arrive changed
  if (value !== '' && value.charCodeAt(0) < 0x21) throw new TypeError(`AMI header ${name} starts with a blank or control character`);
  return value;
}

/**
 * A request line fits Asterisk's input buffer: 1024 bytes with its CRLF (main/manager.c get_input). A longer line is cut, and
 * the request refused or, at some lengths, split in two.
 * @param {string} line  without CRLF
 */
function checkLine(line) {
  if (Buffer.byteLength(line) + 2 > MAX_LINE_BYTES) {
    throw new RangeError(`AMI header ${line.slice(0, line.indexOf(':'))} is longer than ${MAX_LINE_BYTES - 2} bytes with its name`);
  }
}

/**
 * The Output lines of a Command answer. Asterisk splits the CLI text at LF only, so a trailing CR is dropped from each line.
 * @param {Packet} response
 * @returns {string[]}
 */
function outputLines(response) {
  return headerValues(response, 'Output').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * @param {string} what
 * @param {unknown} value
 * @returns {number}
 */
function checkMs(what, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(`${what} must be an integer from 1 to ${MAX_TIMER_MS} ms`);
  }
  return value;
}

export class AmiClient extends EventEmitter {
  #log;
  #options;
  /** @type {Target | null} */
  #target = null;
  /** @type {State} */
  #state = 'idle';
  /** @type {Connection | null} */
  #conn = null;
  #seq = 0;
  #order = 0;
  #attempt = 0;
  /** @type {Map<string, Pending>} */
  #pending = new Map();
  /** @type {NodeJS.Timeout | null} */
  #retryTimer = null;
  /** @type {Array<{ resolve: () => void, reject: (err: Error) => void }>} */
  #waiters = [];
  /** @type {number | null} */
  #since = null;
  /** @type {Error | null} */
  #lastError = null;
  /** @type {string | null} */
  #banner = null;

  /** @param {Options} [options] */
  constructor(options = {}) {
    super();
    const { log = SILENT, ...timing } = options;
    this.#log = log;
    const merged = { ...DEFAULTS, ...timing };
    for (const [key, value] of Object.entries(merged)) {
      if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError(`unknown AmiClient option: ${key}`);
      checkMs(key, value);
    }
    if (merged.backoffMaxMs < merged.backoffMinMs) throw new RangeError('backoffMaxMs must not be smaller than backoffMinMs');
    this.#options = Object.freeze(merged);
  }

  /** 'idle' before connect(), 'connecting' (TCP/banner/Login or waiting to retry), 'booting' (logged in, no FullyBooted yet), 'up', 'closed'. */
  get state() {
    return this.#state;
  }

  get connected() {
    return this.#state === 'up';
  }

  /** Epoch ms of the last 'up' or 'down' (null before the first 'up'). */
  get since() {
    return this.#since;
  }

  /** Why the client is not up: the last connection's failure (null while up). */
  get lastError() {
    return this.#lastError;
  }

  /** The banner of the last connection (`Asterisk Call Manager/9.0.0`). */
  get banner() {
    return this.#banner;
  }

  /**
   * Starts the session; resolves at the first 'up' and keeps retrying until then (a refused login too: it is logged and in
   * lastError). Rejects only when close() comes first. One call per client.
   * @param {Target} target
   * @returns {Promise<void>}
   */
  connect(target) {
    return new Promise((resolve, reject) => {
      if (this.#state !== 'idle') throw new Error('AmiClient.connect() may be called once');
      const { host, port, username, secret } = target;
      if (typeof host !== 'string' || host === '') throw new TypeError('AMI host must be a non-empty string');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('AMI port must be an integer from 1 to 65535');
      checkLine(`Username: ${checkValue('Username', username)}`);
      checkLine(`Secret: ${checkValue('Secret', secret)}`);
      this.#target = Object.freeze({ host, port, username, secret });
      this.#waiters.push({ resolve, reject });
      this.#open();
    });
  }

  /**
   * Sends an action; resolves with its response packet. Rejects with AmiError (`Response: Error`), AmiTimeout, AmiDisconnected
   * (not up, or the connection ended first), TypeError/RangeError (invalid name, header or timeout; nothing is sent).
   * @param {string} name
   * @param {Headers} [headers]  a caller ActionID must match [A-Za-z0-9._-]{1,63} and not start with `ami-`; an array value
   *   repeats the header
   * @param {{ timeout?: number }} [options]
   * @returns {Promise<Packet>}
   */
  action(name, headers = {}, { timeout } = {}) {
    return new Promise((resolve, reject) => {
      this.#start(name, headers, timeout, null, (response) => resolve(response), reject);
    });
  }

  /**
   * Runs a CLI command through the Command action; resolves with its Output lines, a trailing CR dropped from each (a command
   * that prints nothing gives ['']). A failing command rejects with AmiError whose message is the CLI's own text (Asterisk 20
   * answers `Response: Error`, `Message: Command output follows` and the text as Output, e.g. `No such command 'pjsip reload' …`)
   * and whose `output` holds the lines. `Response: Success` does not mean the command did what was asked (`module reload` of an
   * unknown module succeeds with `No such module …`): read the lines.
   * @param {string} cli
   * @param {{ timeout?: number }} [options]
   * @returns {Promise<string[]>}
   */
  async command(cli, options) {
    try {
      return outputLines(await this.action('Command', { Command: cli }, options));
    } catch (err) {
      if (err instanceof AmiError && err.output.length > 0) throw new AmiError(err.output.join('\n'), err.response);
      throw err;
    }
  }

  /**
   * A list action: resolves with the events carrying its ActionID, in order, once `completeEvent` arrives (whose ListItems,
   * when present, must equal their number). Those events are not emitted to listeners.
   * @param {string} name
   * @param {Headers} headers
   * @param {string} completeEvent  e.g. QuectelShowDevicesComplete
   * @param {{ timeout?: number }} [options]
   * @returns {Promise<Packet[]>}
   */
  list(name, headers, completeEvent, { timeout } = {}) {
    return new Promise((resolve, reject) => {
      checkName('complete event', completeEvent);
      this.#start(name, headers, timeout, { complete: completeEvent, events: [] }, (_response, events) => resolve(events), reject);
    });
  }

  /**
   * Stops for good: no more reconnects, pending actions and an unresolved connect() reject with AmiDisconnected, a logged-in
   * session says Logoff; resolves once the socket is closed (destroyed after 1 s at the latest).
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#state === 'closed') return;
    const wasUp = this.#state === 'up';
    this.#state = 'closed';
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const closed = new AmiDisconnected('AMI client closed');
    this.#rejectAll(closed);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(closed);
    const conn = this.#conn;
    if (conn) {
      this.#stopTimers(conn);
      conn.reason ??= closed;
      const { socket } = conn;
      if (!socket.destroyed) {
        await new Promise((resolve) => {
          const force = setTimeout(() => socket.destroy(), 1_000);
          socket.once('close', () => {
            clearTimeout(force);
            resolve(undefined);
          });
          if (conn.loggedIn && socket.writable) socket.write(`Action: Logoff\r\nActionID: ami-${++this.#seq}\r\n\r\n`);
          socket.end();
        });
      }
    }
    this.#conn = null;
    if (wasUp) {
      this.#since = Date.now();
      this.#safeEmit('down', closed);
    }
  }

  /**
   * @param {string} name
   * @param {Headers} headers
   * @param {number | undefined} timeout
   * @param {Pending['list']} list
   * @param {Pending['resolve']} resolve
   * @param {Pending['reject']} reject
   */
  #start(name, headers, timeout, list, resolve, reject) {
    const timeoutMs = checkMs('timeout', timeout ?? this.#options.actionTimeoutMs);
    const request = this.#format(name, headers);
    const conn = this.#conn;
    if (this.#state !== 'up' || conn === null) {
      throw new AmiDisconnected(this.#state === 'closed' ? 'AMI client closed' : `AMI is not up (${this.#state})`);
    }
    // generated only for a request that is written, so the numbering has no gaps
    const actionId = request.actionId ?? `ami-${++this.#seq}`;
    const timer = setTimeout(() => {
      if (this.#pending.get(actionId) !== entry) return;
      this.#pending.delete(actionId);
      reject(new AmiTimeout(name, actionId, timeoutMs));
    }, timeoutMs);
    /** @type {Pending} */
    const entry = { action: name, order: ++this.#order, resolve, reject, timer, list };
    this.#pending.set(actionId, entry);
    conn.socket.write(`Action: ${name}\r\nActionID: ${actionId}\r\n${request.lines}\r\n`);
  }

  /**
   * Checks a request: the caller's ActionID (if any) and the other header lines as they go on the wire, each with its CRLF.
   * @param {string} name
   * @param {Headers} headers
   * @returns {{ actionId: string | undefined, lines: string }}
   */
  #format(name, headers) {
    checkName('AMI action name', name);
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) throw new TypeError('AMI headers must be an object');
    /** @type {string[]} */
    const lines = [];
    /** @type {string | undefined} */
    let actionId;
    const seen = new Set();
    for (const [key, raw] of Object.entries(headers)) {
      checkName('AMI header name', key);
      const lower = key.toLowerCase();
      if (seen.has(lower)) throw new TypeError(`AMI header ${key} is given twice`);
      seen.add(lower);
      if (lower === 'action') throw new TypeError('the action name is the first argument, not an Action header');
      if (lower === 'actionid') {
        if (typeof raw !== 'string' || !ACTION_ID.test(raw) || raw.startsWith('ami-')) {
          throw new TypeError(`ActionID must match ${ACTION_ID} and not start with ami-: ${JSON.stringify(raw)}`);
        }
        if (this.#pending.has(raw)) throw new Error(`ActionID ${raw} is already pending`);
        actionId = raw;
        continue;
      }
      /** @type {ReadonlyArray<unknown>} */
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) lines.push(`${key}: ${checkValue(key, value)}`);
    }
    if (lines.length + 2 > MAX_HEADERS) throw new RangeError(`AMI ${name}: more than ${MAX_HEADERS} header lines`);
    for (const line of [`Action: ${name}`, ...lines]) checkLine(line);
    return { actionId, lines: lines.map((line) => `${line}\r\n`).join('') };
  }

  #open() {
    this.#retryTimer = null;
    const target = this.#target;
    if (this.#state === 'closed' || target === null) return;
    this.#state = 'connecting';
    const socket = net.connect({ host: target.host, port: target.port });
    /** @type {Connection} */
    const conn = {
      socket, parser: new AmiParser({ maxPacketBytes: this.#options.maxPacketBytes }), reason: null,
      loginSent: false, loggedIn: false, booted: false, timer: null, pingTimer: null, pinging: false,
    };
    this.#conn = conn;
    socket.setNoDelay(true);
    conn.timer = setTimeout(() => {
      this.#fail(conn, new AmiDisconnected(`AMI login to ${target.host}:${target.port} did not finish within ${this.#options.connectTimeoutMs} ms`));
    }, this.#options.connectTimeoutMs);
    socket.on('data', (chunk) => this.#onData(conn, chunk));
    socket.on('error', (err) => {
      conn.reason ??= err;
    });
    socket.on('close', () => this.#onClose(conn));
  }

  /**
   * @param {Connection} conn
   * @param {Buffer} chunk
   */
  #onData(conn, chunk) {
    if (this.#conn !== conn || conn.reason) return;
    /** @type {Packet[]} */
    let packets;
    try {
      packets = conn.parser.push(chunk);
    } catch (err) {
      this.#fail(conn, /** @type {Error} */ (err));
      return;
    }
    if (conn.parser.banner !== null && !conn.loginSent) this.#login(conn);
    for (const packet of packets) {
      if (this.#conn !== conn || conn.reason) return;
      this.#dispatch(conn, packet);
    }
  }

  /** @param {Connection} conn */
  #login(conn) {
    conn.loginSent = true;
    this.#banner = conn.parser.banner;
    const target = /** @type {Target} */ (this.#target);
    const actionId = `ami-${++this.#seq}`;
    this.#pending.set(actionId, {
      action: 'Login',
      order: ++this.#order,
      timer: null,
      list: null,
      resolve: () => {
        conn.loggedIn = true;
        this.#state = 'booting';
        if (conn.timer) clearTimeout(conn.timer);
        conn.timer = setTimeout(() => {
          this.#fail(conn, new AmiDisconnected(`AMI logged in but Asterisk sent no FullyBooted within ${this.#options.bootTimeoutMs} ms (the AMI user needs read=system)`));
        }, this.#options.bootTimeoutMs);
        conn.pingTimer = setInterval(() => this.#ping(conn), this.#options.pingIntervalMs);
        if (conn.booted) this.#up(conn);
      },
      reject: (err) => {
        if (err instanceof AmiError) this.#fail(conn, new AmiError(`AMI login refused: ${err.message}`, err.response));
      },
    });
    conn.socket.write(`Action: Login\r\nActionID: ${actionId}\r\nUsername: ${target.username}\r\nSecret: ${target.secret}\r\n\r\n`);
  }

  /** @param {Connection} conn */
  #ping(conn) {
    if (this.#conn !== conn || conn.pinging) return;
    conn.pinging = true;
    const actionId = `ami-${++this.#seq}`;
    const timeoutMs = this.#options.pingTimeoutMs;
    let blocked = false;
    const expire = () => {
      if (this.#pending.get(actionId) !== entry) return;
      // Asterisk handles one request of a session at a time: a Ping sent behind a slower action is answered after it, so it
      // waits while an older action is pending and then gets one more full window
      const behind = [...this.#pending.values()].some((other) => other.order < entry.order);
      if (behind || blocked) {
        blocked = behind;
        entry.timer = setTimeout(expire, timeoutMs);
        return;
      }
      this.#pending.delete(actionId);
      this.#fail(conn, new AmiDisconnected(`AMI keepalive Ping unanswered within ${timeoutMs} ms`));
    };
    /** @type {Pending} */
    const entry = {
      action: 'Ping',
      order: ++this.#order,
      list: null,
      timer: setTimeout(expire, timeoutMs),
      resolve: () => {
        conn.pinging = false;
      },
      reject: (err) => {
        if (err instanceof AmiError) this.#fail(conn, new AmiDisconnected(`AMI keepalive Ping refused: ${err.message}`, err));
      },
    };
    this.#pending.set(actionId, entry);
    conn.socket.write(`Action: Ping\r\nActionID: ${actionId}\r\n\r\n`);
  }

  /**
   * @param {Connection} conn
   * @param {Packet} packet
   */
  #dispatch(conn, packet) {
    const actionId = headerValue(packet, 'ActionID');
    const pending = actionId === undefined ? undefined : this.#pending.get(actionId);
    const response = headerValue(packet, 'Response');
    if (response !== undefined) {
      if (pending === undefined || actionId === undefined) {
        this.#log.debug('AMI response without a pending action dropped', { action_id: actionId ?? null, response });
      } else if (response === 'Error') {
        this.#settle(actionId, pending, new AmiError(headerValue(packet, 'Message') ?? 'Response: Error', packet));
      } else if (pending.list === null) {
        this.#settle(actionId, pending, null, packet);
      }
      return;
    }
    const event = headerValue(packet, 'Event');
    if (event === undefined) {
      this.#log.debug('AMI packet without Response or Event dropped', { headers: [...packet.keys()] });
      return;
    }
    if (pending?.list && actionId !== undefined) {
      if (event !== pending.list.complete) {
        pending.list.events.push(packet);
        return;
      }
      const items = headerValue(packet, 'ListItems');
      const { events } = pending.list;
      if (items !== undefined && Number(items) !== events.length) {
        this.#settle(actionId, pending, new Error(`AMI ${pending.action}: ${event} says ListItems: ${items}, ${events.length} entries arrived`));
      } else {
        this.#settle(actionId, pending, null, packet);
      }
      return;
    }
    if (event === 'FullyBooted') {
      conn.booted = true;
      if (conn.loggedIn) this.#up(conn);
    }
    this.#safeEmit('event', packet);
    this.#safeEmit(`event:${event}`, packet);
  }

  /**
   * @param {string} actionId
   * @param {Pending} pending
   * @param {Error | null} err
   * @param {Packet} [packet]
   */
  #settle(actionId, pending, err, packet) {
    this.#pending.delete(actionId);
    if (pending.timer) clearTimeout(pending.timer);
    if (err) pending.reject(err);
    else pending.resolve(/** @type {Packet} */ (packet), pending.list?.events ?? []);
  }

  /** @param {Connection} conn */
  #up(conn) {
    if (this.#state === 'up' || this.#state === 'closed') return;
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = null;
    this.#state = 'up';
    this.#attempt = 0;
    this.#since = Date.now();
    this.#lastError = null;
    const target = /** @type {Target} */ (this.#target);
    this.#log.info('AMI up', { host: target.host, port: target.port, banner: this.#banner });
    for (const waiter of this.#waiters.splice(0)) waiter.resolve();
    this.#safeEmit('up');
  }

  /**
   * Ends a connection for `err` (the first failure is the reported one).
   * @param {Connection} conn
   * @param {Error} err
   */
  #fail(conn, err) {
    conn.reason ??= err;
    conn.socket.destroy();
  }

  /** @param {Connection} conn */
  #onClose(conn) {
    this.#stopTimers(conn);
    if (this.#conn !== conn) return;
    this.#conn = null;
    const reason = conn.reason ?? new AmiDisconnected('AMI connection closed by the server');
    this.#rejectAll(new AmiDisconnected(`AMI connection lost: ${reason.message}`, reason));
    if (this.#state === 'closed') return;
    const wasUp = this.#state === 'up';
    this.#state = 'connecting';
    this.#lastError = reason;
    const delay = backoffDelay(this.#attempt++, this.#options.backoffMinMs, this.#options.backoffMaxMs);
    if (wasUp) {
      this.#since = Date.now();
      this.#log.warn('AMI down', { err: reason, retry_ms: delay });
      this.#safeEmit('down', reason);
    } else if (reason instanceof AmiError) {
      this.#log.warn('AMI login refused', { message: reason.message, retry_ms: delay });
    } else {
      this.#log.debug('AMI connection attempt failed', { err: reason, retry_ms: delay });
    }
    if (this.#state === 'connecting' && this.#retryTimer === null) this.#retryTimer = setTimeout(() => this.#open(), delay);
  }

  /** @param {Connection} conn */
  #stopTimers(conn) {
    if (conn.timer) clearTimeout(conn.timer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    conn.timer = null;
    conn.pingTimer = null;
  }

  /** @param {Error} err */
  #rejectAll(err) {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  /**
   * @param {string} name
   * @param {...unknown} args
   */
  #safeEmit(name, ...args) {
    try {
      this.emit(name, ...args);
    } catch (err) {
      this.#log.error('AMI listener threw', { listener: name, err });
    }
  }
}
