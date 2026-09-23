// @ts-check
// Tests for sip/connections.js: registrations and calls read from captured Asterisk answers, and the `phone.state` events.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { AmiError } from '../src/ami/client.js';
import { createBus } from '../src/bus.js';
import { callOf, contactOf, readConnections, uriAddress, watchConnections } from '../src/sip/connections.js';
import { packetsOf, until } from './devices-fake.js';

/** @param {string} name */
const fixture = (name) => packetsOf(readFileSync(new URL(`./fixtures/ami/${name}`, import.meta.url), 'utf8'));
/** @param {import('../src/ami/parser.js').Packet[]} packets @param {string} id */
const events = (packets, id) => packets.filter((packet) => packet.get('ActionID') === id && packet.has('Event') && !String(packet.get('Event')).endsWith('Complete'));
const CONTACTS = events(fixture('pjsip-contacts.txt'), 'ami-2');
const RINGING = events(fixture('core-show-channels.txt'), 'ami-2');
const TALKING = events(fixture('core-show-channels.txt'), 'ami-3');
/** Before the captured registration expires (ExpirationTime 1790011952). */
const NOW = 1_790_011_900_000;

/** @param {Record<string, string>} headers */
const packet = (headers) => new Map(Object.entries(headers));

describe('sip connections', () => {
  test('uriAddress(): host and port of a SIP URI, parameters and user part ignored', () => {
    assert.deepEqual(uriAddress('sip:599@172.17.0.1:47603'), { host: '172.17.0.1', port: 47603 });
    assert.deepEqual(uriAddress('sip:504@192.0.2.7:5060;ob'), { host: '192.0.2.7', port: 5060 });
    assert.deepEqual(uriAddress('sips:504@[2001:db8::7]:5061;transport=tls'), { host: '2001:db8::7', port: 5061 });
    assert.deepEqual(uriAddress('sip:192.0.2.9'), { host: '192.0.2.9', port: null });
    assert.deepEqual(uriAddress('sip:504@phone.example;transport=udp?x=a@b'), { host: 'phone.example', port: null });
    assert.deepEqual(uriAddress('sip:504@192.0.2.7:99999'), { host: '192.0.2.7', port: null }, 'a port that is not one is left out');
    assert.equal(uriAddress('tel:+375290000001'), null);
    assert.equal(uriAddress(''), null);
  });

  test('contactOf(): the captured ContactList event, and a qualified one', () => {
    assert.equal(CONTACTS.length, 1);
    assert.deepEqual(contactOf(/** @type {any} */ (CONTACTS[0])), {
      phone: '599',
      contact: { address: '172.17.0.1', port: 47603, user_agent: 'aster-sorcery-test', expires_at: 1_790_011_952_000, reachable: null, rtt_ms: null },
    });
    const qualified = packet({ Event: 'ContactList', ObjectName: '504;@abc', Endpoint: '', Uri: 'sip:504@192.0.2.7:5060;ob',
      UserAgent: '', ExpirationTime: '0', Status: 'Reachable', RoundtripUsec: '12345' });
    assert.deepEqual(contactOf(qualified), {
      phone: '504',
      contact: { address: '192.0.2.7', port: 5060, user_agent: null, expires_at: null, reachable: true, rtt_ms: 12 },
    }, 'the phone from the object name when Endpoint is empty; ExpirationTime 0 does not expire');
    assert.equal(contactOf(packet({ Endpoint: '504', Uri: 'sip:504@192.0.2.7', Status: 'Unreachable', RoundtripUsec: '0' })).contact.reachable, false);
  });

  test('callOf(): a call to the phone ringing, then answered; a call the phone makes; other channels are not phones', () => {
    const ringing = RINGING.map((entry) => callOf(entry, NOW));
    assert.deepEqual(ringing, [{ phone: '599', call: { state: 'ringing', number: '+375290000001', name: 'Mobile', since: NOW - 1000 } }, null, null]);
    assert.deepEqual(TALKING.map((entry) => callOf(entry, NOW))[0], { phone: '599', call: { state: 'talking', number: '+375290000001', name: 'Mobile', since: NOW - 6000 } });
    const out = packet({ Channel: 'PJSIP/504-0000001a', ChannelStateDesc: 'Ring', ConnectedLineNum: '<unknown>', ConnectedLineName: '<unknown>',
      Exten: '+375290000002', Application: 'Dial', Duration: '01:02:03' });
    assert.deepEqual(callOf(out, NOW), { phone: '504', call: { state: 'calling', number: '+375290000002', name: null, since: NOW - 3_723_000 } });
    assert.deepEqual(callOf(packet({ Channel: 'PJSIP/504-0000001b', ChannelStateDesc: 'Up', Exten: 's', Application: 'Echo', Duration: '' }), NOW),
      { phone: '504', call: { state: 'talking', number: null, name: null, since: NOW } });
    assert.equal(callOf(packet({ Channel: 'Quectel/gsm1-0100000000' }), NOW), null);
  });

  test('readConnections(): every phone with a registration or a call, expired registrations left out, an empty list is no error', async () => {
    /** @type {Record<string, () => any>} */
    let answers = { PJSIPShowContacts: () => CONTACTS, CoreShowChannels: () => TALKING };
    const ami = { list: async (/** @type {string} */ name) => answers[name]?.() };
    const expired = packet({ Endpoint: '101', Uri: 'sip:101@192.0.2.8:5060', ExpirationTime: String(NOW / 1000 - 1) });
    answers = { PJSIPShowContacts: () => [expired, ...CONTACTS], CoreShowChannels: () => [...TALKING, packet({ Channel: 'PJSIP/1000-00000002', ChannelStateDesc: 'Ring', Exten: '599' })] };
    assert.deepEqual(await readConnections(/** @type {any} */ (ami), NOW), [
      { number: '599', contacts: [contactOf(/** @type {any} */ (CONTACTS[0])).contact],
        calls: [{ state: 'talking', number: '+375290000001', name: 'Mobile', since: NOW - 6000 }] },
      { number: '1000', contacts: [], calls: [{ state: 'calling', number: '599', name: null, since: NOW }] },
    ]);

    const none = (/** @type {string} */ message) => () => {
      throw new AmiError(message, packet({ Response: 'Error', Message: message }));
    };
    answers = { PJSIPShowContacts: none('No Contacts found'), CoreShowChannels: () => [] };
    assert.deepEqual(await readConnections(/** @type {any} */ (ami), NOW), []);
    answers = { PJSIPShowContacts: none('Permission denied'), CoreShowChannels: () => [] };
    await assert.rejects(readConnections(/** @type {any} */ (ami), NOW), /Permission denied/);
  });

  test('watchConnections(): one phone.state per change, null when AMI comes or goes, nothing after stop()', async () => {
    const ami = new EventEmitter();
    const bus = createBus();
    /** @type {unknown[]} */
    const seen = [];
    bus.subscribe((event) => {
      if (event.type === 'phone.state') seen.push(event.payload);
    });
    const watch = watchConnections({ ami, bus, settleMs: 5 });
    ami.emit('event:Newchannel', packet({ Channel: 'PJSIP/599-00000001' }));
    ami.emit('event:Newstate', packet({ Channel: 'Local/599@internal-00000000;1' }));
    ami.emit('event:Newstate', packet({ Channel: 'PJSIP/599-00000001' }));
    ami.emit('event:ContactStatus', packet({ ContactStatus: 'Removed', AOR: '504', EndpointName: '504' }));
    await until(() => seen.length === 1, 2_000, 'the settled event');
    assert.deepEqual(seen, [{ phones: ['504', '599'] }]);

    ami.emit('event:Hangup', packet({ Channel: 'PJSIP/599-00000001' }));
    ami.emit('down', new Error('gone'));
    await until(() => seen.length === 2, 2_000, 'the link event');
    assert.deepEqual(seen[1], { phones: null });

    watch.stop();
    ami.emit('up');
    ami.emit('event:ContactStatus', packet({ EndpointName: '504' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.length, 2);
    assert.equal(ami.eventNames().length, 0, 'every listener removed');
  });
});
