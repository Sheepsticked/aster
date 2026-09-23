// @ts-check
// Aster — what the end-to-end flows share: the API as an admin with a cookie, the AMI as the client with the
// appliance's own secret, the fake Bot API's inspection endpoint, `waitFor`, the host name every Telegram text starts
// with, and the two docker commands one flow needs. Everything is read from the environment test/e2e/run.sh sets; nothing here knows a path of its own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { AmiClient } from '../../../packages/controller/src/ami/client.js';

export { assert };

/** The host name the controller writes at the start of every Telegram text: this machine's, since it shares the host's
 * (docker-compose.yml `uts: host`) and the flows run on the host that runs the stack. */
export const HOST = hostname();

/** @typedef {{ home: string, url: string, password: string, telegram: string, controller: string, amiPort: number }} Env */

/** @returns {Env} */
export function env() {
  const home = process.env.ASTER_E2E_HOME;
  if (!home) throw new Error('ASTER_E2E_HOME is not set (test/e2e/run.sh sets it)');
  return {
    home,
    url: process.env.ASTER_E2E_URL ?? 'http://127.0.0.1',
    password: process.env.ASTER_E2E_PASSWORD ?? 'a-long-enough-password',
    telegram: process.env.ASTER_E2E_TELEGRAM ?? 'http://127.0.0.1:8091',
    controller: process.env.ASTER_E2E_CONTROLLER ?? 'aster-e2e-controller',
    amiPort: Number(process.env.ASTER_E2E_AMI_PORT ?? 5038),
  };
}

/**
 * KEY=value lines of the appliance's secrets file (0600, the runner's own): the AMI secret the flows connect with.
 * @param {string} home
 * @returns {Record<string, string>}
 */
export function secrets(home) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of readFileSync(join(home, 'config', 'secrets.env'), 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `probe` returns something other than undefined/false, or fails naming what was waited for.
 * @template T
 * @param {string} what
 * @param {() => Promise<T | undefined | false>} probe
 * @param {{ timeoutMs?: number, everyMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(what, probe, { timeoutMs = 30_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  /** @type {unknown} */
  let last;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return /** @type {T} */ (value);
      last = value;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last === undefined ? '' : ` (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`}`);
    }
    await sleep(everyMs);
  }
}

/**
 * The controller's JSON API as one admin session (cookie aster_sid from POST /api/login).
 * @param {Env} e
 */
export function makeApi(e) {
  let cookie = '';
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<{ status: number, data: any }>}
   */
  async function call(method, path, body) {
    const response = await fetch(`${e.url}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] ?? cookie;
    const text = await response.text();
    let data = null;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data };
  }
  return {
    call,
    /** @param {string} path */
    get: (path) => call('GET', path),
    /** @param {string} path @param {unknown} [body] */
    post: (path, body) => call('POST', path, body),
    /** @param {string} path @param {unknown} body */
    put: (path, body) => call('PUT', path, body),
    async login() {
      const { status, data } = await call('POST', '/api/login', { password: e.password });
      assert.equal(status, 200, `login: ${status} ${JSON.stringify(data)}`);
      assert.ok(cookie.startsWith('aster_sid='), 'the login set no session cookie');
    },
    /**
     * A GET whose status must be 200; returns the body.
     * @param {string} path
     * @returns {Promise<any>}
     */
    async read(path) {
      const { status, data } = await call('GET', path);
      assert.equal(status, 200, `GET ${path}: ${status} ${JSON.stringify(data)}`);
      return data;
    },
    /**
     * The operation `id` once it has finished (done, failed or uncertain).
     * @param {number} id
     * @param {number} [timeoutMs]
     * @returns {Promise<any>}
     */
    operation(id, timeoutMs = 60_000) {
      return waitFor(`operation ${id} to finish`, async () => {
        const { operation } = await this.read(`/api/operations/${id}`);
        return ['done', 'failed', 'uncertain'].includes(operation.status) ? operation : undefined;
      }, { timeoutMs, everyMs: 500 });
    },
  };
}
/** @typedef {ReturnType<typeof makeApi>} Api */

/**
 * The fake Bot API's inspection endpoint (test/e2e/telegram-server.mjs).
 * @param {Env} e
 */
export function makeTelegram(e) {
  /** @param {string} method @param {string} path @returns {Promise<any>} */
  async function call(method, path) {
    const response = await fetch(`${e.telegram}${path}`, { method });
    assert.equal(response.status, 200, `${method} ${e.telegram}${path}: ${response.status}`);
    return response.json();
  }
  return {
    /** @returns {Promise<Array<{ chatId: string | null, text: string | null }>>} */
    messages: async () => (await call('GET', '/messages')).messages,
    /** @returns {Promise<any[]>} */
    requests: async () => (await call('GET', '/requests')).requests,
    reset: () => call('DELETE', '/requests'),
  };
}
/** @typedef {ReturnType<typeof makeTelegram>} Telegram */

/**
 * The client, logged in with the secret install.sh (here: run.sh) put into secrets.env and manager.conf.
 * @param {Env} e
 */
export async function connectAmi(e) {
  const secret = secrets(e.home).ASTER_AMI_SECRET;
  assert.ok(secret, 'no ASTER_AMI_SECRET in config/secrets.env');
  const ami = new AmiClient();
  await ami.connect({ host: '127.0.0.1', port: e.amiPort, username: 'aster', secret });
  return ami;
}

/**
 * Originates a Local channel the way the checks did: the dialplan half runs `<exten>@<context>` as the driver
 * would have started it, the other half waits `wait` seconds and hangs up. Variables are given as `__NAME=value`, which
 * a Local channel inherits into its dialplan half.
 * @param {AmiClient} ami
 * @param {string} target  `exten@context`
 * @param {{ variables?: Record<string, string>, wait?: number, callerId?: string }} [options]
 */
export async function originate(ami, target, { variables = {}, wait = 1, callerId } = {}) {
  /** @type {Record<string, string | string[]>} */
  const headers = { Channel: `Local/${target}`, Application: 'Wait', Data: String(wait), Timeout: '30000', Async: 'true' };
  const list = Object.entries(variables).map(([name, value]) => `__${name}=${value}`);
  if (list.length > 0) headers.Variable = list;
  if (callerId !== undefined) headers.CallerID = callerId;
  const reply = await ami.action('Originate', headers, { timeout: 30_000 });
  assert.equal(reply.get('Response'), 'Success', `Originate ${target}: ${reply.get('Message')}`);
}

/**
 * The devices a driver lists over AMI, by name, with the headers the flows read.
 * @param {AmiClient} ami
 * @param {'quectel' | 'dongle'} driver
 * @returns {Promise<Map<string, { state: string, current: string, desired: string, radio: string }>>}
 */
export async function showDevices(ami, driver) {
  const action = driver === 'quectel' ? 'QuectelShowDevices' : 'DongleShowDevices';
  const events = await ami.list(action, {}, `${action}Complete`, { timeout: 10_000 });
  return new Map(events.map((event) => [String(event.get('Device') ?? ''), {
    state: String(event.get('State') ?? ''),
    current: String(event.get('CurrentDeviceState') ?? ''),
    desired: String(event.get('DesiredDeviceState') ?? ''),
    radio: String(event.get('RadioSetting') ?? ''),
  }]));
}

/**
 * `docker <args>`, output as text; the flows use it only to stop and start the controller container.
 * @param {string[]} args
 */
export function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** @typedef {{ env: Env, api: Api, ami: AmiClient, tg: Telegram, log: (line: string) => void }} Ctx */
