// @ts-check
// Test helper: a scripted AMI that answers like Asterisk 20 with both patched modem drivers (device actions, reload, SMS, AT, USSD).
// Usage: const ami = new FakeDriverAmi(); ami.addDevice('gsm1', 'quectel', { state: 'Free', current: 'start', desired: 'start', dataTty: '/dev/ttyUSB5' })
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AmiDisconnected, AmiError } from '../src/ami/client.js';
import { deviceSections, sectionNames } from '../src/config/apply.js';

/** @typedef {import('../src/ami/parser.js').Packet} Packet */
/**
 * @typedef {object} FakeDevice
 * @property {string} name
 * @property {'quectel' | 'dongle'} driver
 * @property {string} state
 * @property {string} current
 * @property {string} desired
 * @property {string | null} imei
 * @property {string | null} imsi
 * @property {string | null} dataTty
 * @property {string | null} audio
 * @property {string} gsmReg
 * @property {number} rssi
 * @property {string | null} provider
 * @property {string | null} number
 * @property {number} calls
 * @property {string} startState  the State a start leads to
 * @property {string | null} startTty  the DataState a start leads to
 * @property {string | null} imeiSetting
 * @property {string | null} dataSetting
 * @property {string | null} radio  `RadioSetting` (keep | on | off); null = not reported, as by a driver without the radio patches
 */

const WHEN = ['now', 'gracefully', 'when convenient'];
const CONNECTED = new Set(['Free', 'GSM not registered', 'Ring', 'Waiting', 'Dialing', 'Active', 'Outgoing', 'Incoming', 'Both', 'Held', 'SMS', 'Not initialized', 'Radio off']);
/** @param {Array<[string, string]>} pairs @returns {Packet} */
const packet = (pairs) => new Map(pairs);
/** @param {'quectel' | 'dongle'} driver */
const prefix = (driver) => (driver === 'quectel' ? 'Quectel' : 'Dongle');
/** @param {Record<string, unknown>} headers @param {string} name */
const header = (headers, name) => {
  const value = headers[name];
  return value === undefined ? undefined : String(Array.isArray(value) ? value[0] : value);
};

export class FakeDriverAmi extends EventEmitter {
  /** @param {{ connected?: boolean, configDir?: string | null, startState?: string }} [options] */
  constructor({ connected = true, configDir = null, startState = 'Free' } = {}) {
    super();
    this.up = connected;
    /** overrides the `state` getter ('booting', 'closed', …); null follows `up` @type {string | null} */
    this.forcedState = null;
    /** what `since` reports while up @type {number | null} */
    this.upSince = connected ? Date.now() : null;
    this.configDir = configDir;
    this.startState = startState;
    /** every request in order: `QuectelStop gsm1 gracefully`, `Command: quectel discovery`, `QuectelShowDevices gsm1` @type {string[]} */
    this.calls = [];
    /** every accepted SendSMS @type {Array<{ device: string, number: string, message: string, validity: string | null, report: string | null, payload: string | null }>} */
    this.sms = [];
    /** every accepted AtCommand @type {Array<{ device: string, command: string, actionId: string, timeout: string }>} */
    this.atCommands = [];
    /** the scripted modem: what a queued command answers (undefined: OK without lines)
     * @type {(device: string, command: string) => { lines?: Array<string | string[]>, result?: 'OK' | 'ERROR' | 'TIMEOUT' | 'silent', error?: string, delayMs?: number, before?: boolean } | undefined} */
    this.at = () => undefined;
    /** every accepted SendUSSD @type {Array<{ device: string, code: string }>} */
    this.ussd = [];
    /** what the network answers a code with (null: nothing; with a type, a `…NewCUSD` of that session state comes first)
     * @type {(device: string, code: string) => string | { text: string, type: number } | null} */
    this.ussdAnswer = () => null;
    /** @type {Map<string, FakeDevice>} */
    this.devices = new Map();
    /** what `<driver> discovery` prints @type {{ quectel: string[], dongle: string[] }} */
    this.discovery = { quectel: [''], dongle: [''] };
    /** an AmiError message per driver instead of the lines @type {{ quectel: string | null, dongle: string | null }} */
    this.discoveryError = { quectel: null, dongle: null };
    /** @type {Set<string>} */
    this.contexts = new Set();
    /** @type {Set<string>} */
    this.endpoints = new Set();
    /** scripted overrides: return a value to answer, throw to fail, return undefined to fall through
     * @type {((name: string, headers: Record<string, unknown>) => Packet | undefined | Promise<Packet | undefined>) | null} */
    this.onAction = null;
    /** @type {((cli: string) => string[] | undefined | Promise<string[] | undefined>) | null} */
    this.onCommand = null;
    /** @type {((name: string, headers: Record<string, unknown>) => Packet[] | undefined) | null} */
    this.onList = null;
    /** when true a Reload does not apply initstate (a driver that ignores the change) */
    this.ignoreInitstate = false;
    /** when true a Reload does not apply radio (a driver without the radio patches: RadioSetting stays unreported) */
    this.ignoreRadio = false;
    this.lastError = null;
    if (configDir) this.reloadAll();
  }

  get connected() {
    return this.up;
  }

  /** What AmiClient.state reports: `forcedState` when set, else up/connecting. */
  get state() {
    return this.forcedState ?? (this.up ? 'up' : 'connecting');
  }

  /** When the client last became up, as AmiClient.since. */
  get since() {
    return this.up ? this.upSince : null;
  }

  /**
   * @param {string} name
   * @param {'quectel' | 'dongle'} driver
   * @param {Partial<FakeDevice>} [fields]
   */
  addDevice(name, driver, fields = {}) {
    /** @type {FakeDevice} */
    const device = { name, driver, state: 'Stopped', current: 'stop', desired: 'stop', imei: null, imsi: null, dataTty: null, audio: null, gsmReg: 'Unknown', rssi: 0,
      provider: null, number: null, calls: 0, startState: this.startState, startTty: null, imeiSetting: null, dataSetting: null, radio: null, ...fields };
    this.devices.set(name, device);
    return device;
  }

  /** @param {string} name @param {string} status */
  emitStatus(name, status) {
    const device = this.devices.get(name);
    const p = prefix(device?.driver ?? 'quectel');
    const event = packet([['Event', `${p}Status`], ['Privilege', 'call,all'], ['Device', name], ['Status', status]]);
    this.emit('event', event);
    this.emit(`event:${p}Status`, event);
  }

  /**
   * A `…Report` event of a device (both drivers' manager_event_report: Device, Payload, SCTS, DT, Success, Type, Report).
   * @param {string} name
   * @param {{ payload: string, type: 0 | 1 | 2, success: 0 | 1, scts?: string, dt?: string, report?: string }} fields
   */
  emitReport(name, { payload, type, success, scts = '', dt = '', report = '' }) {
    const device = this.devices.get(name);
    const p = prefix(device?.driver ?? 'quectel');
    const event = packet([['Event', `${p}Report`], ['Privilege', 'call,all'], ['Device', name], ['Payload', payload], ['SCTS', scts], ['DT', dt],
      ['Success', String(success)], ['Type', String(type)], ['Report', report]]);
    this.emit('event', event);
    this.emit(`event:${p}Report`, event);
  }

  /**
   * A `…AtResponse` event (manager_event_at_response: ActionID, Device, Line); an array of lines writes the header twice, as
   * manager debug does.
   * @param {string} name
   * @param {string} actionId
   * @param {string | string[]} line
   */
  emitAtResponse(name, actionId, line) {
    const p = prefix(this.devices.get(name)?.driver ?? 'quectel');
    const event = packet([['Event', `${p}AtResponse`], ['Privilege', 'system,all'], ['ActionID', actionId], ['Device', name]]);
    event.set('Line', line);
    this.emit('event', event);
    this.emit(`event:${p}AtResponse`, event);
  }

  /**
   * A `…AtDone` event (manager_event_at_done: ActionID, Device, Result and, unless OK, Error).
   * @param {string} name
   * @param {string} actionId
   * @param {'OK' | 'ERROR' | 'TIMEOUT'} result
   * @param {string} [error]
   */
  emitAtDone(name, actionId, result, error) {
    const p = prefix(this.devices.get(name)?.driver ?? 'quectel');
    const event = packet([['Event', `${p}AtDone`], ['Privilege', 'system,all'], ['ActionID', actionId], ['Device', name], ['Result', result]]);
    if (result !== 'OK') event.set('Error', error ?? (result === 'TIMEOUT' ? 'timeout' : 'ERROR'));
    this.emit('event', event);
    this.emit(`event:${p}AtDone`, event);
  }

  /**
   * A `…NewUSSD` event (manager_event_new_ussd: Device, LineCount, MessageLine<n> for every non-empty line); with a type,
   * the `…NewCUSD` the driver sends before it (Device, Message: the raw `+CUSD: <type>,…` line).
   * @param {string} name
   * @param {string} text
   * @param {number} [type]
   */
  emitUssd(name, text, type) {
    const p = prefix(this.devices.get(name)?.driver ?? 'quectel');
    if (type !== undefined) {
      const raw = packet([['Event', `${p}NewCUSD`], ['Privilege', 'call,all'], ['Device', name], ['Message', `+CUSD: ${type},"${text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}",15`]]);
      this.emit('event', raw);
      this.emit(`event:${p}NewCUSD`, raw);
    }
    const lines = text.split(/\r?\n/).filter((line) => line !== '');
    const event = packet([['Event', `${p}NewUSSD`], ['Privilege', 'call,all'], ['Device', name], ['LineCount', String(lines.length)], ...lines.map((line, i) => /** @type {[string, string]} */ ([`MessageLine${i}`, line]))]);
    this.emit('event', event);
    this.emit(`event:${p}NewUSSD`, event);
  }

  /** @param {FakeDevice} device */
  #start(device) {
    device.desired = 'start';
    device.state = device.radio === 'off' ? 'Radio off' : device.startState;
    device.current = CONNECTED.has(device.startState) ? 'start' : 'stop';
    if (device.startTty !== null) device.dataTty = device.startTty;
    if (CONNECTED.has(device.state)) {
      this.emitStatus(device.name, 'Connect');
      if (device.state === 'Free') this.emitStatus(device.name, 'Free');
    }
  }

  /** @param {FakeDevice} device */
  #stop(device) {
    const wasConnected = CONNECTED.has(device.state);
    device.desired = 'stop';
    device.state = 'Stopped';
    device.current = 'stop';
    device.dataTty = device.dataSetting;
    device.calls = 0;
    if (wasConnected) this.emitStatus(device.name, 'Disconnect');
  }

  /** @param {FakeDevice} device */
  #restart(device) {
    if (CONNECTED.has(device.state)) this.emitStatus(device.name, 'Disconnect');
    this.#start(device);
  }

  /** @param {FakeDevice} device */
  #remove(device) {
    if (CONNECTED.has(device.state)) this.emitStatus(device.name, 'Disconnect');
    this.devices.delete(device.name);
  }

  /** Completes a graceful action whose device was busy (the last call ended). @param {string} name */
  settle(name) {
    const device = this.devices.get(name);
    if (!device) return;
    device.calls = 0;
    if (device.desired === 'stop' && device.state !== 'Stopped') this.#stop(device);
    else if (device.desired === 'restart') this.#restart(device);
    else if (device.desired === 'remove') this.#remove(device);
  }

  /** @param {'quectel' | 'dongle'} driver */
  reloadDriver(driver) {
    if (!this.configDir) return;
    let text = '';
    try {
      text = readFileSync(join(this.configDir, `aster.d/${driver}-devices.conf`), 'utf8');
    } catch {
      // no file: no devices
    }
    const sections = deviceSections(text);
    for (const device of [...this.devices.values()]) {
      if (device.driver === driver && !sections.has(device.name)) this.#remove(device);
    }
    for (const [name, keys] of sections) {
      const initstate = keys.get('initstate') === 'start' ? 'start' : 'stop';
      const radio = this.ignoreRadio ? null : keys.get('radio') ?? 'keep';
      let radioChanged = false;
      let device = this.devices.get(name);
      if (!device) {
        device = this.addDevice(name, driver, { imeiSetting: keys.get('imei') ?? null, dataSetting: keys.get('data') ?? null, dataTty: keys.get('data') ?? null,
          audio: keys.get('alsadev') ?? keys.get('audio') ?? null, radio });
      } else {
        device.imeiSetting = keys.get('imei') ?? null;
        device.audio = keys.get('alsadev') ?? keys.get('audio') ?? device.audio;
        radioChanged = !this.ignoreRadio && device.radio !== radio;
        if (!this.ignoreRadio) device.radio = radio;
      }
      if (this.ignoreInitstate) continue;
      if (device.desired !== initstate) {
        if (initstate === 'start') this.#start(device);
        else if (device.calls === 0) this.#stop(device);
        else device.desired = 'stop';
      } else if (radioChanged && device.desired === 'start') {
        this.#restart(device);
      }
    }
  }

  reloadAll() {
    if (!this.configDir) return;
    /** @param {string} name */
    const sections = (name) => {
      try {
        return sectionNames(readFileSync(join(/** @type {string} */ (this.configDir), name), 'utf8'));
      } catch {
        return [];
      }
    };
    this.contexts = new Set([...sections('extensions.conf'), ...sections('aster.d/modems.conf')].filter((n) => n !== 'general' && n !== 'globals'));
    this.endpoints = new Set(sections('aster.d/phones.conf'));
    this.reloadDriver('quectel');
    this.reloadDriver('dongle');
  }

  /** @param {FakeDevice} device @returns {Packet} */
  entry(device) {
    const p = prefix(device.driver);
    return packet([
      ['Event', `${p}DeviceEntry`],
      ['Device', device.name],
      ['AudioSetting', device.audio ?? ''],
      ['DataSetting', device.dataSetting ?? ''],
      ['IMEISetting', device.imeiSetting ?? ''],
      ['RadioSetting', device.radio ?? ''],
      ['IMSISetting', ''],
      ['State', device.state],
      ['AudioState', device.audio ?? ''],
      ['DataState', device.dataTty ?? ''],
      ['Manufacturer', device.state === 'Free' ? 'Quectel' : ''],
      ['Model', device.state === 'Free' ? 'EC25' : ''],
      ['Firmware', ''],
      ['IMEIState', device.imei ?? ''],
      ['IMSIState', device.imsi ?? ''],
      ['GSMRegistrationStatus', device.gsmReg],
      ['RSSI', `${device.rssi}, ${device.rssi === 0 ? '<= -113 dBm' : `${device.rssi * 2 - 113} dBm`}`],
      ['ProviderName', device.provider ?? 'NONE'],
      ['SubscriberNumber', device.number ?? 'Unknown'],
      ['CurrentDeviceState', device.current],
      ['DesiredDeviceState', device.desired],
      ['CallsChannels', String(device.calls)],
    ]);
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} [headers]
   * @param {{ timeout?: number }} [_options]
   * @returns {Promise<Packet>}
   */
  async action(name, headers = {}, _options) {
    const deviceName = header(headers, 'Device');
    const when = header(headers, 'When');
    this.calls.push([name, deviceName, when].filter((part) => part !== undefined).join(' '));
    if (!this.up) throw new AmiDisconnected('not up');
    if (this.onAction) {
      const scripted = await this.onAction(name, headers);
      if (scripted !== undefined) return scripted;
      if (!this.up) throw new AmiDisconnected('not up');
    }
    if (name === 'Command') return packet([['Response', 'Success'], ['Message', 'Command output follows'], ...(await this.command(String(headers.Command))).map((line) => /** @type {[string, string]} */ (['Output', line]))]);
    /** @param {string} message */
    const ok = (message) => packet([['Response', 'Success'], ['Message', message]]);
    /** @param {string} message */
    const error = (message) => new AmiError(message, packet([['Response', 'Error'], ['Message', message]]));
    const sms = /^(Quectel|Dongle)SendSMS$/.exec(name);
    if (sms) {
      const number = header(headers, 'Number') ?? '';
      const message = header(headers, 'Message') ?? '';
      if (!deviceName) throw error('Device not specified');
      if (number === '') throw error('Number not specified');
      if (message === '') throw error('Message not specified');
      if (!/^\+?[0-9]*$/.test(number)) throw error(`[${deviceName}] Invalid phone number`);
      const device = this.devices.get(deviceName);
      if (!device || device.driver !== (sms[1] === 'Quectel' ? 'quectel' : 'dongle') || !CONNECTED.has(device.state) || device.state === 'Radio off') throw error(`[${deviceName}] Device disconnected`);
      this.sms.push({ device: deviceName, number, message, validity: header(headers, 'Validity') ?? null, report: header(headers, 'Report') ?? null, payload: header(headers, 'Payload') ?? null });
      return ok(`[${deviceName}] SMS queued for send`);
    }
    const at = /^(Quectel|Dongle)AtCommand$/.exec(name);
    if (at) {
      const actionId = header(headers, 'ActionID') ?? '';
      const command = header(headers, 'Command') ?? '';
      const timeout = header(headers, 'Timeout');
      if (!/^[A-Za-z0-9._-]{1,63}$/.test(actionId)) throw error('Invalid ActionID');
      if (command === '' || command.length > 256) throw error('Invalid Command');
      if (timeout !== undefined && !(/^[1-9][0-9]?$/.test(timeout) && Number(timeout) <= 60)) throw error('Invalid Timeout');
      const device = deviceName ? this.devices.get(deviceName) : undefined;
      if (!deviceName || !device || device.driver !== (at[1] === 'Quectel' ? 'quectel' : 'dongle')) throw error('Device not found');
      if (!CONNECTED.has(device.state)) throw error('Device not connected');
      if (device.state === 'Radio off') throw error('Device not initialized');
      this.atCommands.push({ device: deviceName, command, actionId, timeout: timeout ?? '15' });
      const script = this.at(deviceName, command) ?? {};
      const emitAll = () => {
        for (const line of script.lines ?? []) this.emitAtResponse(deviceName, actionId, line);
        if (script.result !== 'silent') this.emitAtDone(deviceName, actionId, script.result ?? 'OK', script.error);
      };
      if (script.before) emitAll();
      else setTimeout(emitAll, script.delayMs ?? 0);
      return ok(`[${deviceName}] AT command queued`);
    }
    const ussd = /^(Quectel|Dongle)SendUSSD$/.exec(name);
    if (ussd) {
      const code = header(headers, 'USSD') ?? '';
      if (!deviceName) throw error('Device not specified');
      if (code === '') throw error('USSD not specified');
      const device = this.devices.get(deviceName);
      if (!device || device.driver !== (ussd[1] === 'Quectel' ? 'quectel' : 'dongle') || !CONNECTED.has(device.state) || device.state === 'Radio off') throw error(`[${deviceName}] Device disconnected`);
      this.ussd.push({ device: deviceName, code });
      const answer = this.ussdAnswer(deviceName, code);
      if (typeof answer === 'string') setTimeout(() => this.emitUssd(deviceName, answer), 0);
      else if (answer !== null) setTimeout(() => this.emitUssd(deviceName, answer.text, answer.type), 0);
      return ok(`[${deviceName}] USSD queued for send`);
    }
    const match = /^(Quectel|Dongle)(Start|Stop|Restart|Reset|Remove|Reload)$/.exec(name);
    if (!match) throw new AmiError('Invalid/unknown command', packet([['Response', 'Error'], ['Message', 'Invalid/unknown command']]));
    const driver = match[1] === 'Quectel' ? 'quectel' : 'dongle';
    const verb = match[2];
    if (verb === 'Reload') {
      if (!WHEN.includes(when ?? '')) throw error('Invalid value of When');
      this.reloadDriver(driver);
      return ok('reload scheduled');
    }
    if (!deviceName) throw error('Device not specified');
    const device = this.devices.get(deviceName);
    if (!device || device.driver !== driver) throw error(`[${deviceName}] Device not found`);
    if (verb === 'Reset') {
      if (!CONNECTED.has(device.state)) throw error(`[${deviceName}] Device disconnected`);
      setTimeout(() => {
        device.state = 'Not connected';
        device.current = 'stop';
        this.emitStatus(device.name, 'Disconnect');
      }, 0);
      return ok(`[${deviceName}] Reset command queued for execute`);
    }
    if (verb === 'Start') {
      this.#start(device);
      return ok(`[${deviceName}] Start scheduled`);
    }
    if (!WHEN.includes(when ?? '')) throw error('Invalid value of When');
    const busy = device.calls > 0 && when !== 'now';
    if (verb === 'Stop') {
      if (busy) device.desired = 'stop';
      else this.#stop(device);
      return ok(`[${deviceName}] Stop scheduled`);
    }
    if (verb === 'Restart') {
      if (busy) device.desired = 'restart';
      else this.#restart(device);
      return ok(`[${deviceName}] Restart scheduled`);
    }
    if (busy) device.desired = 'remove';
    else this.#remove(device);
    return ok(`[${deviceName}] Removal scheduled`);
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} headers
   * @param {string} _completeEvent
   * @param {{ timeout?: number }} [_options]
   * @returns {Promise<Packet[]>}
   */
  async list(name, headers, _completeEvent, _options) {
    const deviceName = header(headers, 'Device');
    this.calls.push([name, deviceName].filter((part) => part !== undefined).join(' '));
    if (!this.up) throw new AmiDisconnected('not up');
    if (this.onList) {
      const scripted = this.onList(name, headers);
      if (scripted !== undefined) return scripted;
      if (!this.up) throw new AmiDisconnected('not up');
    }
    const driver = name === 'QuectelShowDevices' ? 'quectel' : name === 'DongleShowDevices' ? 'dongle' : null;
    if (!driver) throw new AmiError('Invalid/unknown command', packet([['Response', 'Error'], ['Message', 'Invalid/unknown command']]));
    return [...this.devices.values()].filter((device) => device.driver === driver && (deviceName === undefined || deviceName === '' || device.name === deviceName)).map((device) => this.entry(device));
  }

  /**
   * @param {string} cli
   * @param {{ timeout?: number }} [_options]
   * @returns {Promise<string[]>}
   */
  async command(cli, _options) {
    this.calls.push(`Command: ${cli}`);
    if (!this.up) throw new AmiDisconnected('not up');
    if (this.onCommand) {
      const scripted = await this.onCommand(cli);
      if (scripted !== undefined) return scripted;
      if (!this.up) throw new AmiDisconnected('not up');
    }
    /** @param {string} message */
    const error = (message) => new AmiError(message, packet([['Response', 'Error'], ['Message', 'Command output follows'], ['Output', message]]));
    const discovery = /^(quectel|dongle) discovery$/.exec(cli);
    if (discovery) {
      const driver = /** @type {'quectel' | 'dongle'} */ (discovery[1]);
      const failure = this.discoveryError[driver];
      if (failure !== null) throw error(failure);
      return [...this.discovery[driver]];
    }
    if (cli === 'dialplan reload') {
      this.reloadAll();
      return ['Dialplan reloaded.'];
    }
    const reload = /^module reload (\S+)$/.exec(cli);
    if (reload) {
      if (reload[1] === 'res_pjsip.so') this.reloadAll();
      return [`Module '${reload[1]}' reloaded successfully.`];
    }
    const show = /^dialplan show (\S+)$/.exec(cli);
    if (show) {
      if (this.contexts.has(String(show[1]))) return [`[ Context '${show[1]}' created by 'pbx_config' ]`];
      throw error(`There is no existence of '${show[1]}' context\nCommand 'dialplan show ${show[1]}' failed.`);
    }
    const endpoint = /^pjsip show endpoint (\S+)$/.exec(cli);
    if (endpoint) return this.endpoints.has(String(endpoint[1])) ? ['', ` Endpoint:  ${endpoint[1]}/${endpoint[1]}`] : [`Unable to find object ${endpoint[1]}.`, ''];
    if (cli === 'core show uptime') return ['System uptime: 1 minute'];
    throw error(`No such command '${cli}' (type 'core show help ${cli}' for other possible commands)`);
  }
}

/**
 * The packets of an AMI transcript fixture (test/fixtures/ami/*.txt): each block of `Name: value` lines.
 * @param {string} text
 * @returns {Packet[]}
 */
export function packetsOf(text) {
  return text.split('\r\n\r\n').map((block) => block.split('\r\n').filter((line) => line.includes(': ') || line.endsWith(':'))).filter((lines) => lines.length > 0).map((lines) => {
    /** @type {Packet} */
    const out = new Map();
    for (const line of lines) {
      const at = line.indexOf(':');
      const name = line.slice(0, at);
      const value = line.slice(at + 1).replace(/^ /, '');
      const existing = out.get(name);
      if (existing === undefined) out.set(name, value);
      else out.set(name, Array.isArray(existing) ? [...existing, value] : [existing, value]);
    }
    return out;
  });
}

/**
 * Waits until `condition()` is true (polled every 5 ms) or fails after `ms`.
 * @param {() => boolean} condition
 * @param {number} [ms]
 * @param {string} [what]
 */
export async function until(condition, ms = 2_000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
