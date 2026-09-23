// @ts-check
// Aster — record byte-exact AMI transcripts (server → client) for packages/controller/test/fixtures/ami.
// Runs scripted sessions against a live Asterisk that uses docker/asterisk/test-config (AMI user aster/test) and writes every
// byte the server sent, unmodified, to <out>/<scenario>.txt. The requests carry the ActionIDs the controller's AmiClient
// generates (ami-1, ami-2, … in call order), so a transcript test replays a file against the same sequence of calls. The
// framing here is a plain split on the blank line, independent of src/ami/parser.js, so a parser bug cannot shape a fixture.
// Usage: node tools/ami-capture.js [--host 127.0.0.1] [--port 5038] [--out <dir>] [scenario…]   (default: every scenario;
//        `restart` restarts Asterisk, run it last)
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const STEP_TIMEOUT_MS = 30_000;

/** @typedef {{ packets: string[][], closed: boolean }} Seen */
/** @typedef {{ send: Record<string, string>, until: (seen: Seen) => boolean, settle?: number }} Step */

/**
 * @param {string[]} lines
 * @param {string} name
 * @param {string} value
 */
const has = (lines, name, value) => lines.includes(`${name}: ${value}`);
/** @param {string} id @returns {(seen: Seen) => boolean} */
const response = (id) => (seen) => seen.packets.some((lines) => lines.some((l) => l.startsWith('Response: ')) && has(lines, 'ActionID', id));
/** @param {string} name @param {string} id @returns {(seen: Seen) => boolean} */
const event = (name, id) => (seen) => seen.packets.some((lines) => has(lines, 'Event', name) && has(lines, 'ActionID', id));
/** @param {Seen} seen */
const closed = (seen) => seen.closed;
/** @param {string} id @param {string} secret @returns {Step} */
const login = (id, secret) => ({ send: { Action: 'Login', ActionID: id, Username: 'aster', Secret: secret }, until: response(id), settle: 500 });
/** @param {string} id @returns {Step} */
const logoff = (id) => ({ send: { Action: 'Logoff', ActionID: id }, until: closed });
/** @param {string} id @param {string} cli @returns {Step} */
const command = (id, cli) => ({ send: { Action: 'Command', ActionID: id, Command: cli }, until: response(id) });

/** @type {Record<string, Step[]>} */
const SCENARIOS = {
  // banner, successful Login with the FullyBooted event, Logoff
  login: [login('ami-1', 'test'), logoff('ami-2')],
  // a refused Login: Asterisk answers after about 1 s (sleep(1) in action_login) and closes the connection
  'login-failed': [{ ...login('ami-1', 'wrong'), until: closed }],
  // Command output (the Output: form), a failing CLI command, a module reload, multi-line dialplan output, an unknown action, Ping
  command: [
    login('ami-1', 'test'),
    command('ami-2', 'core show uptime'),
    command('ami-3', 'pjsip reload'),
    command('ami-4', 'module reload res_pjsip.so'),
    command('ami-5', 'dialplan show smoke'),
    { send: { Action: 'NoSuchAction', ActionID: 'ami-6' }, until: response('ami-6') },
    { send: { Action: 'Ping', ActionID: 'ami-7' }, until: response('ami-7') },
    logoff('ami-8'),
  ],
  // both drivers' device lists (test-config: the stopped quectel devices gsm_test, gsm_uac, gsm_unmapped and dongle gsm_dongle, gsm_ports)
  'show-devices': [
    login('ami-1', 'test'),
    { send: { Action: 'QuectelShowDevices', ActionID: 'ami-2' }, until: event('QuectelShowDevicesComplete', 'ami-2') },
    { send: { Action: 'DongleShowDevices', ActionID: 'ami-3' }, until: event('DongleShowDevicesComplete', 'ami-3') },
    logoff('ami-4'),
  ],
  // the patched AtCommand actions refused for a stopped device and for a bad Timeout (caller-chosen ActionIDs, as the controller uses)
  'at-command-refused': [
    login('ami-1', 'test'),
    { send: { Action: 'QuectelAtCommand', ActionID: 'at-1', Device: 'gsm_test', Command: 'AT+CCFC=0,2', Timeout: '15' }, until: response('at-1'), settle: 500 },
    { send: { Action: 'DongleAtCommand', ActionID: 'at-2', Device: 'gsm_dongle', Command: 'AT', Timeout: '0' }, until: response('at-2'), settle: 500 },
    logoff('ami-2'),
  ],
  // the controller's restart action: the connection ends while the action is in flight
  restart: [login('ami-1', 'test'), { ...command('ami-2', 'core restart gracefully'), until: closed }],
};

/**
 * @param {string} host
 * @param {number} port
 * @param {Step[]} steps
 * @returns {Promise<Buffer>}
 */
async function capture(host, port, steps) {
  const socket = net.connect(port, host);
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Seen} */
  const seen = { packets: [], closed: false };
  /** @type {(() => void) | null} */
  let wake = null;
  const update = () => {
    const text = Buffer.concat(chunks).toString('latin1');
    // complete packets only: the text after the last blank line is still arriving
    seen.packets = text.split('\r\n\r\n').slice(0, -1).map((packet) => packet.split('\r\n'));
    wake?.();
  };
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    update();
  });
  socket.on('close', () => {
    seen.closed = true;
    update();
  });
  socket.on('error', (err) => {
    process.stderr.write(`ami-capture: ${err.message}\n`);
  });
  /**
   * @param {(seen: Seen) => boolean} predicate
   * @param {string} what
   */
  const waitFor = async (predicate, what) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!predicate(seen)) {
      if (seen.closed && predicate !== closed) throw new Error(`connection closed while waiting for ${what}`);
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((resolve) => {
        wake = () => resolve(undefined);
        setTimeout(resolve, 100);
      });
    }
  };
  await waitFor(() => Buffer.concat(chunks).includes('\r\n'), 'the banner');
  for (const step of steps) {
    socket.write(`${Object.entries(step.send).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
    await waitFor(step.until, JSON.stringify(step.send));
    if (step.settle) await new Promise((resolve) => setTimeout(resolve, step.settle));
  }
  socket.destroy();
  return Buffer.concat(chunks);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '5038' },
    out: { type: 'string', default: 'packages/controller/test/fixtures/ami' },
  },
});
const names = positionals.length > 0 ? positionals : Object.keys(SCENARIOS);
for (const name of names) {
  const steps = SCENARIOS[name];
  if (!steps) throw new Error(`unknown scenario: ${name} (known: ${Object.keys(SCENARIOS).join(', ')})`);
  const bytes = await capture(values.host, Number(values.port), steps);
  writeFileSync(join(values.out, `${name}.txt`), bytes);
  process.stdout.write(`${name}: ${bytes.length} bytes\n`);
}
