// @ts-check
// Test helper: a fake AMI server; each connection runs the next script (a transcript fixture replayed request by request,
// or a function that drives the socket). Usage: const server = await fakeAmi([readFileSync(…/login.txt), asterisk()]).
import net from 'node:net';

export const BANNER = 'Asterisk Call Manager/9.0.0\r\n';

/** @typedef {Map<string, string>} Request  a client packet; a repeated header keeps its last value (see Conn.raw for all bytes) */
/**
 * @typedef {object} Conn
 * @property {net.Socket} socket
 * @property {number} at             Date.now() when accepted
 * @property {Request[]} requests    in arrival order
 * @property {string} raw            every byte the client sent, as latin1
 * @property {(data: string | Buffer) => void} send
 * @property {(handler: (request: Request) => void) => void} onRequest
 * @property {Promise<void>} closed
 */
/** @typedef {Buffer | ((conn: Conn) => void)} Script */

/**
 * One packet: the lines, each closed by CRLF, and the empty line.
 * @param {string[]} lines
 */
export const packet = (lines) => `${lines.map((line) => `${line}\r\n`).join('')}\r\n`;

/**
 * A transcript with ActionIDs renamed (`{ 'ami-1': 'ami-3' }`), for a replay on a later connection of the same client, whose
 * generated ActionIDs keep counting.
 * @param {Buffer} transcript
 * @param {Record<string, string>} ids
 */
export function retag(transcript, ids) {
  const text = transcript.toString('latin1').replace(/(?<=\r\n)ActionID: ([^\r\n]*)(?=\r\n)/g, (line, id) => `ActionID: ${ids[id] ?? id}`);
  return Buffer.from(text, 'latin1');
}

/**
 * @param {Buffer} transcript
 * @returns {{ banner: Buffer, packets: Array<{ bytes: Buffer, response: string | null, actionId: string | null }> }}
 */
function split(transcript) {
  const eol = transcript.indexOf('\r\n');
  if (eol < 0) throw new Error('transcript without a banner line');
  const packets = [];
  let start = eol + 2;
  while (start < transcript.length) {
    const end = transcript.indexOf('\r\n\r\n', start);
    if (end < 0) throw new Error('transcript does not end with an empty line');
    const bytes = transcript.subarray(start, end + 4);
    const lines = bytes.toString('latin1').split('\r\n');
    /** @param {string} name */
    const header = (name) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
    packets.push({ bytes, response: header('Response'), actionId: header('ActionID') });
    start = end + 4;
  }
  return { banner: transcript.subarray(0, eol + 2), packets };
}

/**
 * @param {Conn} conn
 * @param {Buffer} transcript
 */
function replay(conn, transcript) {
  const { banner, packets } = split(transcript);
  let cursor = 0;
  conn.send(banner);
  conn.onRequest((request) => {
    const id = request.get('ActionID');
    let answer = cursor;
    while (answer < packets.length && !(packets[answer]?.response !== null && packets[answer]?.actionId === id)) answer++;
    if (answer === packets.length) {
      conn.send(Buffer.concat(packets.slice(cursor).map((p) => p.bytes)));
      cursor = packets.length;
      conn.socket.end();
      return;
    }
    let next = answer + 1;
    while (next < packets.length && packets[next]?.response === null) next++;
    conn.send(Buffer.concat(packets.slice(cursor, next).map((p) => p.bytes)));
    cursor = next;
    if (packets[answer]?.response === 'Goodbye') conn.socket.end();
  });
}

/**
 * A function script that behaves like a booted Asterisk: banner; Login → Success + FullyBooted; then every request goes to
 * `reply` first — a string is sent, null sends nothing, undefined falls back to Ping → Pong, Logoff → Goodbye + close, anything
 * else → Response: Success.
 * @param {(request: Request, conn: Conn) => string | null | undefined} [reply]
 * @param {{ booted?: boolean }} [options]  booted: false leaves out the FullyBooted event
 * @returns {(conn: Conn) => void}
 */
export function asterisk(reply = () => undefined, { booted = true } = {}) {
  return (conn) => {
    conn.send(BANNER);
    conn.onRequest((request) => {
      const id = request.get('ActionID') ?? '';
      const action = request.get('Action');
      if (action === 'Login') {
        conn.send(packet(['Response: Success', `ActionID: ${id}`, 'Message: Authentication accepted'])
          + (booted ? packet(['Event: FullyBooted', 'Privilege: system,all', 'Uptime: 5', 'LastReload: 5', 'Status: Fully Booted']) : ''));
        return;
      }
      const answer = reply(request, conn);
      if (typeof answer === 'string') conn.send(answer);
      if (answer !== undefined) return;
      if (action === 'Ping') conn.send(packet(['Response: Success', `ActionID: ${id}`, 'Ping: Pong', 'Timestamp: 1789046548.044481']));
      else if (action === 'Logoff') {
        conn.send(packet(['Response: Goodbye', `ActionID: ${id}`, 'Message: Thanks for all the fish.']));
        conn.socket.end();
      } else conn.send(packet(['Response: Success', `ActionID: ${id}`]));
    });
  };
}

/**
 * A transcript releases everything up to the Response with the request's ActionID; with no such Response left it closes.
 * @param {Script[]} scripts  one per connection, in order
 */
export async function fakeAmi(scripts) {
  /** @type {Conn[]} */
  const connections = [];
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    // Asterisk sets TCP_NODELAY on AMI sockets; with Nagle a second small write waits for the peer's delayed ACK
    socket.setNoDelay(true);
    socket.on('error', () => {});
    /** @type {Array<(request: Request) => void>} */
    const handlers = [];
    let buffered = '';
    /** @type {Conn} */
    const conn = {
      socket,
      at: Date.now(),
      requests: [],
      raw: '',
      send: (data) => {
        if (!socket.destroyed && socket.writable && data.length > 0) socket.write(data);
      },
      onRequest: (handler) => handlers.push(handler),
      closed: new Promise((resolve) => {
        socket.once('close', () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    };
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      conn.raw += text;
      buffered += text;
      for (let end = buffered.indexOf('\r\n\r\n'); end >= 0; end = buffered.indexOf('\r\n\r\n')) {
        /** @type {Request} */
        const request = new Map();
        for (const line of buffered.slice(0, end).split('\r\n')) {
          const colon = line.indexOf(': ');
          request.set(colon < 0 ? line : line.slice(0, colon), colon < 0 ? '' : line.slice(colon + 2));
        }
        buffered = buffered.slice(end + 4);
        conn.requests.push(request);
        for (const handler of handlers) handler(request);
      }
    });
    const script = scripts[connections.length];
    connections.push(conn);
    if (script === undefined) socket.destroy();
    else if (typeof script === 'function') script(conn);
    else replay(conn, script);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake AMI server has no TCP address');
  return {
    port: address.port,
    connections,
    /**
     * @param {number} count
     * @param {number} [timeoutMs]
     */
    async waitForConnections(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (connections.length < count) {
        if (Date.now() > deadline) throw new Error(`fake AMI server: ${connections.length} of ${count} connections within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
