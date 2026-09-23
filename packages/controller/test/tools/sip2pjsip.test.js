// @ts-check
// tools/sip2pjsip.js: the old appliance's chan_sip peers as the registry's phones, compared byte for byte with the snapshots;
// refused peers use small hand-written files, because the repository's test/fixtures/old holds only the real one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parse } from '../../src/config/registry.js';
import { convertSip, phonesBlock } from '../../../../tools/sip2pjsip.js';
import { ROOT, snapshot } from './snapshot.js';

const OLD = new URL('../../../../test/fixtures/old/', import.meta.url);
const sipConf = readFileSync(new URL('sip.conf', OLD), 'utf8');

/** @param {string} text */
const numbers = (text) => convertSip(text).phones.map((phone) => phone.number);

describe('tools/sip2pjsip.js', () => {
  test('the old sip.conf becomes the 15 phones', () => {
    const { phones, notes, seen } = convertSip(sipConf);
    assert.equal(seen, 15);
    assert.equal(phones.length, 15);
    assert.deepEqual(numbers(sipConf), ['501', '502', '503', '504', '505', '506', '507', '508', '509', '510', '511', '512', '513', '514', '515']);
    // Every secret is its own number on the old appliance; they are kept, not invented.
    assert.ok(phones.every((phone) => phone.secret === phone.number));
    // context=phones → gsm1, phones1 → gsm2, default → internal only.
    assert.deepEqual(phones.filter((p) => p.outbound === 'gsm1').map((p) => p.number), ['504', '505', '506', '507', '508']);
    assert.deepEqual(phones.filter((p) => p.outbound === 'gsm2').map((p) => p.number), ['511', '512', '513', '514', '515']);
    assert.deepEqual(phones.filter((p) => p.outbound === null).map((p) => p.number), ['501', '502', '503', '509', '510']);
    // canreinvite=yes, only on those two.
    assert.deepEqual(phones.filter((p) => p.direct_media).map((p) => p.number), ['509', '510']);
    assert.equal(notes.filter((n) => n.kind === 'problem' || n.kind === 'left out').length, 0);
  });

  test('what it prints is what the controller reads back', () => {
    const block = phonesBlock(convertSip(sipConf).phones);
    const registry = parse(`version: 1\nmodems:\n  - { id: gsm1, driver: quectel, imei: "490154203237534", enabled: true }\n  - { id: gsm2, driver: dongle, imei: "356938035643817", enabled: true }\n${block}`);
    assert.equal(registry.phones.length, 15);
    assert.equal(registry.phones[3]?.outbound, 'gsm1');
    assert.equal(registry.phones[8]?.direct_media, true);
  });

  test('a peer that cannot become a phone is left out and said so', () => {
    const text = [
      '[general]', 'context=default',
      '[authentication]',
      '[template](!)', 'type=friend', 'secret=x',
      '[601]', 'type=friend', 'host=dynamic', 'secret=601',                     // no context: [general]'s applies
      '[602]', 'type=friend', 'host=dynamic',                                   // no secret
      '[603]', 'type=friend', 'host=dynamic', 'md5secret=8ea5b1c1',             // only the digest
      '[604]', 'type=friend', 'host=192.0.2.7', 'secret=604',                   // a trunk, not a phone
      '[trunk-a]', 'type=friend', 'host=dynamic', 'secret=x',                   // not a phone number
      '[605]', 'type=friend', 'host=dynamic', 'secret=605', 'context=sales',    // an unknown context
      '[606]', 'type=friend', 'host=dynamic', 'secret=a b',                     // a secret phones.conf cannot carry
      '[607]', 'type=peer', 'host=dynamic', 'secret=607', 'context=phones1', 'canreinvite=nonat',
      '[608]', 'type=phone', 'host=dynamic', 'secret=608',                      // not a peer type at all
      '',
    ].join('\n');
    const { phones, notes, seen } = convertSip(text);
    assert.equal(seen, 9, 'the template and the two chan_sip sections are not peers');
    assert.deepEqual(phones.map((p) => p.number), ['601', '605', '607']);
    assert.equal(phones[0]?.outbound, null, '[general] context=default is internal only');
    assert.equal(phones[1]?.outbound, null, 'an unknown context does not guess a modem');
    assert.equal(phones[2]?.outbound, 'gsm2');
    assert.equal(phones[2]?.direct_media, true, 'canreinvite=nonat is not "no", so the media does not come through the appliance');

    const left = notes.filter((n) => n.kind === 'left out').map((n) => n.message).join('\n');
    assert.equal(notes.filter((n) => n.kind === 'left out').length, 6);
    assert.match(left, /\[602\]: no secret/);
    assert.match(left, /\[603\]: only md5secret/);
    assert.match(left, /\[604\]: host=192\.0\.2\.7/);
    assert.match(left, /\[trunk-a\]: the section name/);
    assert.match(left, /\[606\]: the secret has a space/);
    assert.match(left, /\[608\]: type=phone is not a phone/);
    const assumptions = notes.filter((n) => n.kind === 'assumption').map((n) => n.message).join('\n');
    assert.match(assumptions, /\[605\]: context=sales is not one of the old appliance's/);
    assert.match(assumptions, /\[607\]: directmedia=nonat has no equivalent/);
  });

  test('it reads a peer the way chan_sip does', () => {
    assert.deepEqual(numbers(''), []);
    assert.deepEqual(numbers('[701]\nsecret=701\n'), ['701'], 'no type and no host is a registering friend');
    assert.deepEqual(numbers('[general]\n[702]\nSECRET=702\nContext=phones\n'), ['702'], 'keys are case-insensitive');
    assert.equal(convertSip('[702]\nSECRET=702\nContext=phones\n').phones[0]?.outbound, 'gsm1');
    assert.equal(convertSip('[703]\nsecret=one\nsecret=two\n').phones[0]?.secret, 'two', 'the last value of a key wins, as chan_sip applies them');
    assert.equal(convertSip('[704]\nsecret=704 ; the number\n').phones[0]?.secret, '704', 'a comment is not part of the value');
    assert.match(convertSip('#include sip-peers.conf\n').notes[0]?.message ?? '', /#include sip-peers.conf was not followed/);
    // A file Asterisk would reject outright is not a file to read a configuration out of.
    const broken = convertSip('[general]\ncontext=default\n[601\ntype=friend\nsecret=601\n');
    assert.deepEqual(broken.phones, []);
    assert.match(broken.notes.filter((n) => n.kind === 'problem')[0]?.message ?? '', /line 3: no closing \] — Asterisk rejects the whole file/);
  });

  test('the command line writes the block on stdout and the report on stderr', () => {
    const run = spawnSync(process.execPath, ['tools/sip2pjsip.js', 'test/fixtures/old/sip.conf'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0);
    snapshot('phones.yaml', run.stdout);
    snapshot('sip2pjsip.report.txt', run.stderr);

    const noFile = spawnSync(process.execPath, ['tools/sip2pjsip.js', 'test/fixtures/old/nothing.conf'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(noFile.status, 2);
    assert.match(noFile.stderr, /cannot read test\/fixtures\/old\/nothing\.conf/);
    assert.equal(noFile.stdout, '');

    const noPeers = spawnSync(process.execPath, ['tools/sip2pjsip.js', 'test/fixtures/old/dongle.conf'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(noPeers.status, 2, 'a file that is not a sip.conf produces no phones instead of an empty block');
    assert.match(noPeers.stderr, /has no peer this tool can convert/);

    const usage = spawnSync(process.execPath, ['tools/sip2pjsip.js'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: node tools\/sip2pjsip\.js/);
  });
});
