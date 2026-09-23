// @ts-check
// Aster controller — a development-only AMI server standing in for Asterisk; the real AmiClient talks to it over TCP.
// Its devices come from the generated aster.d/<driver>-devices.conf, re-read at every Reload. Enabled only by
// ASTER_AMI_MOCK=1 (index.js), loopback only; it lives in src/ because the image ships only src/ and bin/.
// Usage: const mock = await startMockAmi({ configDir, log }); → { host, port, username, secret, close() }
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceSections } from '../config/apply.js';
import { REQUIRED_MODULES } from '../http/routes/health.js';

/** The banner of the image's Asterisk (test/fixtures/ami/login.txt). */
export const BANNER = 'Asterisk Call Manager/9.0.0';
/** What `core show version` prints: the image's Asterisk (docker/asterisk/Dockerfile). */
const VERSION = 'Asterisk 20.21.0';
/** What `module show` lists: everything /api/health requires, so a development run is not permanently degraded. */
const MODULES = REQUIRED_MODULES;
/** The username and secret of the mock session; the real ones come from config/secrets.env and are not needed here. */
export const CREDENTIALS = Object.freeze({ username: 'aster', secret: 'mock' });
/** The drivers, and the generated file each one's devices come from. */
const DRIVERS = Object.freeze({ quectel: 'aster.d/quectel-devices.conf', dongle: 'aster.d/dongle-devices.conf' });
/** What a started device with a SIM reports. */
const RUNNING = Object.freeze({ state: 'Free', current: 'start', desired: 'start', rssi: '21, -71 dBm',
  gsmReg: 'Registered, home network', provider: 'Operator', number: '+1234567890' });

/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {Map<string, string>} Packet  the headers of one request, by their own case */

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

/** @param {'quectel' | 'dongle'} driver */
const prefix = (driver) => (driver === 'quectel' ? 'Quectel' : 'Dongle');

/** The CR/LF escaping the AtCommand patch uses for a Line or an Error header (docker/asterisk/patches/README.md). */
const escape = (/** @type {string} */ text) => text.replaceAll('\r', '\\r').replaceAll('\n', '\\n');

/**
 * One device as `…ShowDevices` reports it, with the values devices/state.js `parseDeviceEntry` reads filled in.
 * @param {{ name: string, driver: 'quectel' | 'dongle', started: boolean, radio: string, imei: string, imsi: string, data: string, audio: string }} device
 * @param {string} actionId
 */
function deviceEntry(device, actionId) {
  const on = device.started;
  // radio=off (a disabled modem): the driver keeps it connected and identified but never initializes it
  const off = on && device.radio === 'off';
  const up = on && !off;
  const p = prefix(device.driver);
  /** @type {[string, string][]} */
  const headers = [
    ['Event', `${p}DeviceEntry`],
    ['ActionID', actionId],
    ['Device', device.name],
    ['AudioSetting', ''],
    ['DataSetting', ''],
    ['IMEISetting', device.imei],
    ['IMSISetting', ''],
    ['Context', `aster-in-${device.name}`],
    ['Group', '1'],
    ['RadioSetting', device.radio],
    ['State', off ? 'Radio off' : on ? RUNNING.state : 'Stopped'],
    ['AudioState', on ? device.audio : ''],
    ['DataState', on ? device.data : ''],
    ['Voice', up ? 'Yes' : 'No'],
    ['SMS', up ? 'Yes' : 'No'],
    ['Manufacturer', on ? (device.driver === 'quectel' ? 'Quectel' : 'huawei') : ''],
    ['Model', on ? (device.driver === 'quectel' ? 'EC25' : 'E173') : ''],
    ['Firmware', on ? 'EC25XXXXXXXX' : ''],
    ['IMEIState', on ? device.imei : ''],
    ['IMSIState', up ? device.imsi : ''],
    ['GSMRegistrationStatus', up ? RUNNING.gsmReg : 'Unknown'],
    ['RSSI', up ? RUNNING.rssi : '0, <= -113 dBm'],
    ['ProviderName', up ? RUNNING.provider : 'NONE'],
    ['SubscriberNumber', up ? RUNNING.number : 'Unknown'],
    ['TasksInQueue', '0'],
    ['CommandsInQueue', '0'],
    ['CurrentDeviceState', on ? RUNNING.current : 'stop'],
    ['DesiredDeviceState', on ? RUNNING.desired : 'stop'],
    ['CallsChannels', '0'],
    ['Active', '0'],
    ['Held', '0'],
  ];
  return headers;
}

/** The text `<driver> discovery` prints for one free device (cli.c cli_discovery; test/fixtures/discovery/). */
const discoveryText = (/** @type {{ imei: string, data: string, audio: string }} */ device) =>
  ['; discovered device', `[dc_${device.imei.slice(-4)}_](defaults)`, `;audio=${device.audio}`, `;data=${device.data}`, `imei=${device.imei}`, 'imsi=', ''];

/**
 * Starts the stand-in and resolves once it is listening.
 * @param {object} options
 * @param {string} options.configDir       config/asterisk of the home the controller runs on (the generated files live there)
 * @param {Logger} [options.log]
 * @param {string} [options.host]          loopback only; anything else is refused
 * @param {number} [options.port]          0 (the default) asks the kernel for a free one
 * @returns {Promise<{ host: string, port: number, username: string, secret: string, devices: () => string[], close: () => Promise<void> }>}
 */
export function startMockAmi({ configDir, log = SILENT, host = '127.0.0.1', port = 0 }) {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error(`the AMI mock listens on the loopback address only, not ${JSON.stringify(host)}`);
  }

  /** @type {Map<string, { name: string, driver: 'quectel' | 'dongle', started: boolean, radio: string, imei: string, imsi: string, data: string, audio: string }>} */
  const devices = new Map();
  /** The device the drivers see and no modem owns: what a scan finds and the UI offers to assign. */
  const free = { imei: '867435040099999', imsi: '001011234567890', data: '/dev/ttyUSB8', audio: '/dev/ttyUSB7' };

  /** Re-reads both generated device files; a driver reload does exactly this (devices-fake.js, reload_config). */
  function readDevices() {
    devices.clear();
    for (const [driver, file] of Object.entries(DRIVERS)) {
      /** @type {string} */
      let text;
      try {
        text = readFileSync(join(configDir, file), 'utf8');
      } catch {
        continue; // not generated yet: that driver simply has no devices
      }
      let n = 0;
      for (const [name, keys] of deviceSections(text)) {
        n += 1;
        devices.set(name, {
          name,
          driver: /** @type {'quectel' | 'dongle'} */ (driver),
          started: (keys.get('initstate') ?? 'start') !== 'stop',
          radio: keys.get('radio') ?? 'keep',
          imei: keys.get('imei') || `86743504001234${n}`,
          imsi: '001011234567890',
          data: keys.get('data') || `/dev/ttyUSB${n * 2}`,
          audio: keys.get('audio') || `/dev/ttyUSB${n * 2 - 1}`,
        });
      }
    }
    return devices;
  }
  readDevices();

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  /** What a modem remembers per `<device>:<reason>` between an `AT+CCFC` mutation and the queries that follow it (at/forwarding.js). */
  /** @type {Map<string, { enabled: boolean, number: string | null, time: string | null }>} */
  const forwarding = new Map();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffer = '';
    let loggedIn = false;

    /** @param {[string, string][]} headers */
    const send = (headers) => {
      if (socket.destroyed) return;
      socket.write(`${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
    };
    /** @param {string} actionId @param {string} message */
    const ok = (actionId, message) => send([['Response', 'Success'], ['ActionID', actionId], ['Message', message]]);
    /** @param {string} actionId @param {string} message */
    const fail = (actionId, message) => send([['Response', 'Error'], ['ActionID', actionId], ['Message', message]]);
    /** @param {string} actionId @param {readonly string[]} lines */
    const output = (actionId, lines) => send([['Response', 'Success'], ['ActionID', actionId], ['Message', 'Command output follows'],
      ...lines.map((line) => /** @type {[string, string]} */ (['Output', line]))]);

    socket.write(`${BANNER}\r\n`);

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end = buffer.indexOf('\r\n\r\n');
      while (end !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 4);
        handle(raw);
        end = buffer.indexOf('\r\n\r\n');
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));

    /** @param {string} raw  one request packet */
    function handle(raw) {
      /** @type {Packet} */
      const packet = new Map();
      for (const line of raw.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) packet.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      const action = packet.get('Action') ?? '';
      const actionId = packet.get('ActionID') ?? '';
      log.debug('AMI mock request', { action, actionId });

      if (action === 'Login') {
        if (packet.get('Username') !== CREDENTIALS.username || packet.get('Secret') !== CREDENTIALS.secret) {
          fail(actionId, 'Authentication failed');
          socket.end();
          return;
        }
        loggedIn = true;
        ok(actionId, 'Authentication accepted');
        // The client is 'up' only once Asterisk says it is fully booted (ami/client.js), so this is not optional.
        send([['Event', 'FullyBooted'], ['Privilege', 'system,all'], ['Uptime', '240'], ['LastReload', '0'], ['Status', 'Fully Booted']]);
        return;
      }
      if (!loggedIn) {
        fail(actionId, 'Permission denied');
        return;
      }
      if (action === 'Logoff') {
        send([['Response', 'Goodbye'], ['ActionID', actionId], ['Message', 'Thanks for all the fish.']]);
        socket.end();
        return;
      }
      if (action === 'Ping') {
        send([['Response', 'Success'], ['ActionID', actionId], ['Ping', 'Pong']]);
        return;
      }
      if (action === 'Command') return command(actionId, packet.get('Command') ?? '');
      if (action === 'PJSIPShowContacts') return contacts(actionId);
      if (action === 'CoreShowChannels') {
        send([['Response', 'Success'], ['ActionID', actionId], ['EventList', 'start'], ['Message', 'Channels will follow']]);
        send([['Event', 'CoreShowChannelsComplete'], ['ActionID', actionId], ['EventList', 'Complete'], ['ListItems', '0']]);
        return;
      }

      const driver = action.startsWith('Quectel') ? 'quectel' : action.startsWith('Dongle') ? 'dongle' : null;
      if (driver === null) {
        fail(actionId, `Invalid/unknown command: ${action}. Use Action: ListCommands to show available commands.`);
        return;
      }
      return driverAction(actionId, /** @type {'quectel' | 'dongle'} */ (driver), action.slice(prefix(driver).length), packet);
    }

    /** @param {string} actionId  PJSIPShowContacts in the shape of test/fixtures/ami/pjsip-contacts.txt */
    function contacts(actionId) {
      /** @type {string | undefined} */
      let phone;
      try {
        phone = /^\[([0-9]+)\]\(aster-phone\)/m.exec(readFileSync(join(configDir, 'aster.d/phones.conf'), 'utf8'))?.[1];
      } catch {
        phone = undefined; // not generated yet: no phones
      }
      if (phone === undefined) return fail(actionId, 'No Contacts found');
      send([['Response', 'Success'], ['ActionID', actionId], ['EventList', 'start'], ['Message', 'A listing of Contacts follows, presented as ContactList events']]);
      send([['Event', 'ContactList'], ['ActionID', actionId], ['ObjectType', 'contact'], ['ObjectName', `${phone};@mock`], ['Endpoint', phone],
        ['Uri', `sip:${phone}@192.0.2.10:5060`], ['UserAgent', 'Zoiper v2.10.20.5'], ['ExpirationTime', String(Math.floor(Date.now() / 1000) + 3600)],
        ['Status', 'NonQualified'], ['RoundtripUsec', 'N/A']]);
      send([['Event', 'ContactListComplete'], ['ActionID', actionId], ['EventList', 'Complete'], ['ListItems', '1']]);
    }

    /** @param {string} actionId @param {string} cli */
    function command(actionId, cli) {
      const discovery = /^(quectel|dongle) discovery$/.exec(cli);
      if (discovery) {
        // Only the device no modem has claimed is free to be discovered; a started one holds its ports.
        const claimed = [...devices.values()].some((device) => device.imei === free.imei);
        return output(actionId, claimed ? [''] : discoveryText(free));
      }
      if (cli === 'core restart gracefully') {
        // Asterisk never answers this one: the connection drops and the client reconnects (config/apply.js).
        socket.destroy();
        return;
      }
      if (cli.startsWith('dialplan show ')) return output(actionId, [`[ Context ${cli.slice(14)} created by pbx_config ]`, '']);
      if (cli.startsWith('pjsip show endpoint ')) return output(actionId, [`Endpoint:  ${cli.slice(20)}   Not in use   0 of inf`, '']);
      if (cli === 'dialplan reload' || cli.startsWith('module reload') || cli.endsWith(' reload')) return output(actionId, ['']);
      if (cli === 'core show uptime') return output(actionId, ['System uptime: 4 minutes', '']);
      // What /api/health probes (http/routes/health.js): every module it requires, in the CLI's own column layout.
      if (cli === 'module show') {
        return output(actionId, ['Module                         Description                              Use Count  Status      Support Level',
          ...MODULES.map((name) => `${name.padEnd(31)}${'Aster mock'.padEnd(41)}0          Running              core`),
          `${MODULES.length} modules loaded`, '']);
      }
      if (cli === 'core show version') return output(actionId, [`${VERSION} built by mock @ aster on a Linux build server`, '']);
      return send([['Response', 'Error'], ['ActionID', actionId], ['Message', 'Command output follows'],
        ['Output', `No such command '${cli}' (type 'core show help ${cli}' for other possible commands)`]]);
    }

    /**
     * @param {string} actionId
     * @param {'quectel' | 'dongle'} driver
     * @param {string} verb  the action without its driver prefix: ShowDevices, Reload, Start, AtCommand, …
     * @param {Packet} packet
     */
    function driverAction(actionId, driver, verb, packet) {
      const p = prefix(driver);
      if (verb === 'ShowDevices') {
        // With a `Device` header both drivers list that one device and nothing else; reconcile.js asks that way to find out
        // whether a removed modem is really gone, so listing everything would keep it waiting until its deadline.
        const only = packet.get('Device');
        const listed = [...devices.values()]
          .filter((device) => device.driver === driver && (only === undefined || only === '' || device.name === only));
        send([['Response', 'Success'], ['ActionID', actionId], ['EventList', 'start'], ['Message', 'Device status list will follow']]);
        for (const device of listed) send(deviceEntry(device, actionId));
        send([['Event', `${p}ShowDevicesComplete`], ['ActionID', actionId], ['EventList', 'Complete'], ['ListItems', String(listed.length)]]);
        return;
      }
      if (verb === 'Reload') {
        readDevices();
        ok(actionId, 'Reload queued');
        return;
      }

      const name = packet.get('Device') ?? '';
      const device = devices.get(name);
      if (device === undefined || device.driver !== driver) {
        // A refusal is `Response: Error` with the driver's own sentence (test/fixtures/ami/at-command-refused.txt);
        // callers judge by Error vs Success, not by the text.
        fail(actionId, `[${name}] Device not found`);
        return;
      }

      if (verb === 'Start' || verb === 'Restart') {
        device.started = true;
        ok(actionId, `[${name}] ${verb} scheduled`);
        return;
      }
      if (verb === 'Stop' || verb === 'Remove') {
        device.started = false;
        if (verb === 'Remove') devices.delete(name);
        ok(actionId, `[${name}] ${verb} scheduled`);
        return;
      }
      if (verb === 'Reset') {
        if (!device.started) return fail(actionId, `[${name}] Device disconnected`);
        ok(actionId, `[${name}] Reset command queued for execute`);
        return;
      }
      if (verb === 'SendSMS') {
        if (!device.started || device.radio === 'off') return fail(actionId, `[${name}] Device disconnected`);
        ok(actionId, `[${name}] SMS queued for send`);
        return;
      }
      if (verb === 'SendUSSD') {
        if (!device.started || device.radio === 'off') {
          fail(actionId, `[${name}] Device disconnected`);
          return;
        }
        ok(actionId, `[${name}] USSD queued for send`);
        const text = `Balance 12.34 EUR. Request ${packet.get('USSD') ?? ''}`;
        setTimeout(() => send([['Event', `${p}NewUSSD`], ['Privilege', 'call,all'], ['Device', name], ['LineCount', '1'], ['MessageLine0', text]]), 50);
        return;
      }
      if (verb === 'AtCommand') return atCommand(actionId, driver, device, packet);
      fail(actionId, `Invalid/unknown command: ${p}${verb}. Use Action: ListCommands to show available commands.`);
    }

    /**
     * The patched `…AtCommand` (docker/asterisk/patches/README.md): the action is acknowledged at once, then one
     * `…AtResponse` per non-terminal line and exactly one `…AtDone` for the tagged task.
     * @param {string} actionId
     * @param {'quectel' | 'dongle'} driver
     * @param {{ name: string, started: boolean, radio: string, imsi: string }} device
     * @param {Packet} packet
     */
    function atCommand(actionId, driver, device, packet) {
      const p = prefix(driver);
      const command = packet.get('Command') ?? '';
      const tag = packet.get('ActionID') ?? '';
      if (command === '') {
        fail(actionId, 'Command not specified');
        return;
      }
      if (!device.started) {
        fail(actionId, `[${device.name}] Device not connected`);
        return;
      }
      if (device.radio === 'off') {
        fail(actionId, `[${device.name}] Device not initialized`);
        return;
      }
      ok(actionId, `[${device.name}] AT command queued`);
      const upper = command.toUpperCase();
      /** @type {string[]} */
      let lines = [];
      if (upper.startsWith('AT+CSQ')) lines = ['+CSQ: 21,99'];
      else if (upper.startsWith('AT+CIMI')) lines = [device.imsi];
      else if (upper.startsWith('AT+CCFC=')) {
        // A mutation changes what later queries answer, as on a modem: reason 4 covers 0–3, reason 5 covers 1–3.
        const [, reason = '', mode = '', number = null, time = null] = /^AT\+CCFC=(\d),(\d)(?:,"(\+[0-9]{6,15})",145(?:,7,,,(\d+))?)?/.exec(upper) ?? [];
        if (mode === '2') {
          const entry = forwarding.get(`${device.name}:${reason}`);
          lines = entry?.enabled ? [`+CCFC: 1,1,"${entry.number}",145${entry.time ? `,,,${entry.time}` : ''}`] : ['+CCFC: 0,1'];
        } else {
          const covered = reason === '4' ? ['0', '1', '2', '3'] : reason === '5' ? ['1', '2', '3'] : [reason];
          for (const code of covered) {
            const key = `${device.name}:${code}`;
            const entry = forwarding.get(key) ?? { enabled: false, number: null, time: null };
            if (mode === '3') forwarding.set(key, { enabled: true, number, time: code === '2' ? time : null });
            else if (mode === '1') forwarding.set(key, { ...entry, enabled: true, number: entry.number ?? '+1234567890' });
            else if (mode === '0') forwarding.set(key, { ...entry, enabled: false });
            else forwarding.delete(key);
          }
        }
      }
      setTimeout(() => {
        for (const line of lines) {
          send([['Event', `${p}AtResponse`], ['Privilege', 'call,all'], ['ActionID', tag], ['Device', device.name], ['Line', escape(line)]]);
        }
        send([['Event', `${p}AtDone`], ['Privilege', 'call,all'], ['ActionID', tag], ['Device', device.name], ['Result', 'OK'], ['Error', '']]);
      }, 50);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      log.warn('AMI mock: this controller is talking to a stand-in, not to Asterisk (ASTER_AMI_MOCK)', { host, port: bound, devices: devices.size });
      resolve({
        host,
        port: bound,
        username: CREDENTIALS.username,
        secret: CREDENTIALS.secret,
        devices: () => [...devices.keys()],
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
