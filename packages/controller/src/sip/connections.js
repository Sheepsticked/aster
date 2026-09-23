// @ts-check
// Aster controller — who is connected to each phone (its SIP registrations) and its calls, read from Asterisk on request;
// registration and call events become one `phone.state` bus event per change.
import { AmiError } from '../ami/client.js';
import { headerValue } from '../ami/parser.js';

/** @typedef {import('../ami/parser.js').Packet} Packet */
/** @typedef {import('../bus.js').Bus} Bus */
/**
 * @typedef {object} Contact  one registered device
 * @property {string} address            where Asterisk sends the phone's calls
 * @property {number | null} port
 * @property {string | null} user_agent
 * @property {number | null} expires_at  epoch ms; null when it does not expire
 * @property {boolean | null} reachable  null unless the phone is qualified
 * @property {number | null} rtt_ms
 */
/**
 * @typedef {object} Call  one channel of the phone
 * @property {'ringing' | 'calling' | 'talking'} state
 * @property {string | null} number  the other party
 * @property {string | null} name
 * @property {number} since          epoch ms
 */
/** @typedef {{ number: string, contacts: Contact[], calls: Call[] }} PhoneConnections */

/** A list action with nothing to list answers with an error: "No Contacts found". */
const EMPTY = /^No \w+ found/;
/** A PJSIP channel: PJSIP/<endpoint>-<sequence>. */
const CHANNEL = /^PJSIP\/(.+)-[0-9a-f]{8}$/;
/** The channel events that change what a phone's calls look like. */
const CALL_EVENTS = Object.freeze(['Newchannel', 'Newstate', 'NewConnectedLine', 'Hangup']);
/** The events of one change (a call is several within milliseconds) are published as one. */
export const SETTLE_MS = 300;

/** @param {string | undefined} value */
const known = (value) => (value === undefined || value.trim() === '' || value === '<unknown>' ? null : value.trim());

/**
 * Host and port of a SIP URI; an IPv6 host without its brackets.
 * @param {string} uri  e.g. sip:599@192.0.2.7:5060;ob
 * @returns {{ host: string, port: number | null } | null}
 */
export function uriAddress(uri) {
  const rest = /^sips?:(.*)$/i.exec(uri.trim())?.[1];
  if (rest === undefined) return null;
  const target = rest.split('?')[0] ?? '';
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^:;\s]+)(?::([0-9]{1,5}))?(?:;|$)/.exec(target.slice(target.lastIndexOf('@') + 1));
  if (!match?.[1]) return null;
  const port = match[2] === undefined ? null : Number(match[2]);
  return { host: match[1].replace(/^\[(.*)\]$/, '$1'), port: port !== null && port >= 1 && port <= 65535 ? port : null };
}

/**
 * One `ContactList` event of PJSIPShowContacts.
 * @param {Packet} packet
 * @returns {{ phone: string, contact: Contact }}
 */
export function contactOf(packet) {
  const uri = headerValue(packet, 'Uri') ?? '';
  const where = uriAddress(uri);
  const expiration = Number(headerValue(packet, 'ExpirationTime'));
  const status = headerValue(packet, 'Status');
  const rtt = Number(headerValue(packet, 'RoundtripUsec'));
  return {
    phone: known(headerValue(packet, 'Endpoint')) ?? (headerValue(packet, 'ObjectName') ?? '').split(';@')[0] ?? '',
    contact: {
      address: where?.host ?? uri,
      port: where?.port ?? null,
      user_agent: known(headerValue(packet, 'UserAgent')),
      expires_at: Number.isFinite(expiration) && expiration > 0 ? expiration * 1000 : null,
      reachable: status === 'Reachable' ? true : status === 'Unreachable' ? false : null,
      rtt_ms: status === 'Reachable' && Number.isFinite(rtt) && rtt > 0 ? Math.round(rtt / 1000) : null,
    },
  };
}

/** @param {string | undefined} duration  HH:MM:SS */
function seconds(duration) {
  const parts = (duration ?? '').split(':').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * One `CoreShowChannel` event; null for a channel that is not a phone's.
 * @param {Packet} packet
 * @param {number} now  epoch ms
 * @returns {{ phone: string, call: Call } | null}
 */
export function callOf(packet, now) {
  const phone = CHANNEL.exec(headerValue(packet, 'Channel') ?? '')?.[1];
  if (phone === undefined) return null;
  // A channel that a Dial created is a call to the phone; any other is one the phone made.
  const dialed = headerValue(packet, 'Application') === 'AppDial';
  const exten = known(headerValue(packet, 'Exten'));
  const number = known(headerValue(packet, 'ConnectedLineNum')) ?? (dialed || exten === 's' ? null : exten);
  const name = known(headerValue(packet, 'ConnectedLineName'));
  const state = headerValue(packet, 'ChannelStateDesc') === 'Up' ? 'talking' : dialed ? 'ringing' : 'calling';
  return { phone, call: { state, number, name: name === number ? null : name, since: now - seconds(headerValue(packet, 'Duration')) * 1000 } };
}

/**
 * @param {import('../ami/client.js').AmiClient} ami
 * @param {string} action
 * @param {string} complete
 * @param {number | undefined} timeout
 */
async function list(ami, action, complete, timeout) {
  try {
    return await ami.list(action, {}, complete, { timeout });
  } catch (err) {
    if (err instanceof AmiError && EMPTY.test(err.message)) return [];
    throw err;
  }
}

/**
 * Every phone with a registration or a call, by number.
 * @param {import('../ami/client.js').AmiClient} ami
 * @param {number} now  epoch ms
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<PhoneConnections[]>}
 */
export async function readConnections(ami, now, { timeout } = {}) {
  const [contacts, channels] = await Promise.all([
    list(ami, 'PJSIPShowContacts', 'ContactListComplete', timeout),
    list(ami, 'CoreShowChannels', 'CoreShowChannelsComplete', timeout),
  ]);
  /** @type {Map<string, PhoneConnections>} */
  const phones = new Map();
  /** @param {string} number */
  const entry = (number) => {
    const found = phones.get(number) ?? { number, contacts: [], calls: [] };
    phones.set(number, found);
    return found;
  };
  for (const packet of contacts) {
    const { phone, contact } = contactOf(packet);
    // Asterisk lists an expired registration until it prunes it, but no longer calls it.
    if (phone === '' || (contact.expires_at !== null && contact.expires_at <= now)) continue;
    entry(phone).contacts.push(contact);
  }
  for (const packet of channels) {
    const found = callOf(packet, now);
    if (found) entry(found.phone).calls.push(found.call);
  }
  return [...phones.values()].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
}

/**
 * Publishes `phone.state` with the phones a change was about, or `phones: null` when AMI came up or went down (an Asterisk
 * restart forgets every registration).
 * @param {{ ami: import('node:events').EventEmitter, bus: Bus, settleMs?: number }} options
 */
export function watchConnections({ ami, bus, settleMs = SETTLE_MS }) {
  /** @type {Set<string> | null} */
  let changed = new Set();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  const flush = () => {
    timer = null;
    const phones = changed === null ? null : [...changed].sort();
    changed = new Set();
    bus.publish('phone.state', { phones });
  };
  /** @param {string | null} phone  null: every phone */
  const mark = (phone) => {
    if (phone === null) changed = null;
    else changed?.add(phone);
    timer ??= setTimeout(flush, settleMs);
  };
  /** @param {Packet} packet */
  const onContact = (packet) => mark(known(headerValue(packet, 'EndpointName')) ?? known(headerValue(packet, 'AOR')));
  /** @param {Packet} packet */
  const onChannel = (packet) => {
    const phone = CHANNEL.exec(headerValue(packet, 'Channel') ?? '')?.[1];
    if (phone !== undefined) mark(phone);
  };
  const onLink = () => mark(null);
  ami.on('event:ContactStatus', onContact);
  for (const event of CALL_EVENTS) ami.on(`event:${event}`, onChannel);
  ami.on('up', onLink);
  ami.on('down', onLink);
  return {
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      ami.off('event:ContactStatus', onContact);
      for (const event of CALL_EVENTS) ami.off(`event:${event}`, onChannel);
      ami.off('up', onLink);
      ami.off('down', onLink);
    },
  };
}
