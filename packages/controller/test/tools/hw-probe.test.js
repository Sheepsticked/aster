// @ts-check
// tools/hw-probe.sh, the probe an operator runs on the old host before a migration, against the captured two-modem sysfs tree:
// it must derive the data and audio ttys the drivers really used, including the EC25 that chan_dongle's table cannot reach.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadSpec, makeSysfs } from '../sysfs-fake.js';
import { ROOT, snapshot } from './snapshot.js';

const PROBE = join(ROOT, 'tools/hw-probe.sh');
const spec = loadSpec('two-modems.json');

/**
 * @param {string[]} args
 * @returns {{ status: number | null, out: string, err: string }}
 */
function probe(args) {
  const run = spawnSync('sh', [PROBE, ...args], { encoding: 'utf8' });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

/** The lines of one `## ` section of the report. @param {string} out @param {string} heading */
const section = (out, heading) => {
  const lines = out.split('\n');
  const from = lines.indexOf(`## ${heading}`);
  assert.notEqual(from, -1, `the report has no "## ${heading}" section:\n${out}`);
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((line) => line.startsWith('## '));
  return (to === -1 ? rest : rest.slice(0, to)).join('\n').trim();
};

describe('tools/hw-probe.sh', () => {
  let dir = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'aster-probe-'));
    makeSysfs(join(dir, 'host', 'sys'), spec);
    mkdirSync(join(dir, 'host', 'dev'), { recursive: true });
    for (const tty of Object.keys(spec.ttys ?? {})) writeFileSync(join(dir, 'host', 'dev', tty), '');
    mkdirSync(join(dir, 'host', 'srv', 'asterisk', 'temp'), { recursive: true });
    writeFileSync(join(dir, 'host', 'srv', 'asterisk', 'temp', 'GSM1type'), 'quectel');
    writeFileSync(join(dir, 'host', 'srv', 'asterisk', 'temp', 'quectelGSM1'), '1\n');
    mkdirSync(join(dir, 'bare', 'sys', 'bus', 'usb', 'devices'), { recursive: true });
    mkdirSync(join(dir, 'bare', 'sys', 'class', 'tty'), { recursive: true });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('it derives the ports the drivers really used', () => {
    const { status, out } = probe(['--root', join(dir, 'host')]);
    assert.equal(status, 0);
    const modems = section(out, 'Modems');

    // The fixture records the ttys the two drivers really used; the probe must arrive at the same ones.
    const e173 = spec.modems.e173;
    const ec25 = spec.modems.ec25;
    assert.match(modems, new RegExp(`### \`${e173.port}\` — \`12d1:1436\` HUAWEI Mobile`));
    assert.match(modems, new RegExp(`chan_dongle: known \\(\`E1750\`, data if04, audio if03\\) → data \`${e173.data}\`, audio \`${e173.audio}\``));
    assert.match(modems, new RegExp(`### \`${ec25.port}\` — \`2c7c:0125\` EC25-EUX`));
    assert.match(modems, new RegExp(`chan_quectel: known \\(\`EC25\`, data if02, audio if01\\) → data \`${ec25.data}\`, audio \`${ec25.audio}\``));
    // Each modem is offered to the driver Aster picks for its vendor (src/devices/sysfs.js MODEM_VENDORS).
    assert.match(modems, /the driver Aster picks for this vendor: `dongle`/);
    assert.match(modems, /the driver Aster picks for this vendor: `quectel`/);
    // Every tty of the device, with the interface it hangs off, is listed.
    assert.match(modems, /ttys: if00 → \/dev\/ttyUSB0, if03 → \/dev\/ttyUSB1, if04 → \/dev\/ttyUSB2/);
    assert.match(modems, /ttys: if00 → \/dev\/ttyUSB3, if01 → \/dev\/ttyUSB4, if02 → \/dev\/ttyUSB5, if03 → \/dev\/ttyUSB6/);
    snapshot('hw-probe.two-modems.md', `${modems}\n`);
  });

  test('it says when a modem is in a driver\'s table but out of its reach', () => {
    const modems = section(probe(['--root', join(dir, 'host')]).out, 'Modems');
    // chan_dongle knows 2c7c:0125 but probes if01/if04, and the EC25-EUX has no tty on if04, so `dongle discovery`
    // never lists it and its registry entry needs ports: instead of an IMEI.
    assert.match(modems, /chan_dongle: \*\*known \(`EC25`\) but its table probes data if01, audio if04, and if04 \(audio\) has no tty on this host\*\*/);
    assert.match(modems, /`ports: \{ data: …, audio: … \}` instead of an IMEI/);
  });

  test('it prints the old appliance\'s driver choice and desired state', () => {
    const old = section(probe(['--root', join(dir, 'host')]).out, 'The old appliance');
    assert.match(old, /temp\/GSM1type = quectel/);
    assert.match(old, /temp\/quectelGSM1 = 1/);
    const elsewhere = section(probe(['--root', join(dir, 'host'), '--old-home', join(dir, 'bare')]).out, 'The old appliance');
    assert.match(elsewhere, /temp\/: no state file/);
  });

  test('a host with no modem still gets a report', () => {
    const { status, out } = probe(['--root', join(dir, 'bare')]);
    assert.equal(status, 0, 'nothing plugged in is an answer, not a failure');
    assert.match(section(out, 'Modems'), /No USB device of a modem vendor \(2c7c Quectel, 12d1 Huawei\) is plugged in\./);
    assert.match(section(out, 'Serial ports'), /no \/dev\/ttyUSB\* and no \/dev\/serial\/by-path/);
    assert.match(section(out, 'Sound cards'), /no sound card/);
  });

  test('it refuses what it cannot read instead of printing an empty report', () => {
    const missing = probe(['--root', join(dir, 'nowhere')]);
    assert.equal(missing.status, 2);
    assert.match(missing.err, /is not there — is this a Linux host with sysfs\?/);
    assert.equal(missing.out, '');

    const unknown = probe(['--sysfs', '/sys']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.err, /unknown argument --sysfs/);

    const noValue = probe(['--root']);
    assert.equal(noValue.status, 2);
    assert.match(noValue.err, /--root needs a directory/);

    const help = probe(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.out, /^usage: sh tools\/hw-probe\.sh/);
  });
});
