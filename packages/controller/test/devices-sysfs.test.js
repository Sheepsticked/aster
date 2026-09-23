// @ts-check
// Tests for src/devices/sysfs.js on fake sysfs trees (test/sysfs-fake.js): tty → USB port mapping with the exact-ancestor rule,
// non-USB and missing ttys, and the modem list.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { comparePorts, listUsbModems, MODEM_VENDORS, ttyName, USB_PORT, usbPortOfTty } from '../src/devices/sysfs.js';
import { loadSpec, makeSysfs } from './sysfs-fake.js';

const tmp = mkdtempSync(join(tmpdir(), 'aster-sysfs-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;
/** @param {import('./sysfs-fake.js').SysfsSpec} spec */
const tree = (spec) => makeSysfs(join(tmp, `sys-${++counter}`), spec);

describe('devices sysfs', () => {
  const twoModems = loadSpec('two-modems.json');

  test('the two-modem tree: every tty of each modem maps to its port with vendor and product, /dev/ prefix accepted', () => {
    const root = tree(twoModems);
    for (const tty of ['ttyUSB0', 'ttyUSB1', 'ttyUSB2']) assert.deepEqual(usbPortOfTty(tty, root), { port: '1-1', vendor: '12d1', product: '1436' }, tty);
    for (const tty of ['ttyUSB3', 'ttyUSB4', 'ttyUSB5', 'ttyUSB6']) assert.deepEqual(usbPortOfTty(tty, root), { port: '1-2', vendor: '2c7c', product: '0125' }, tty);
    assert.deepEqual(usbPortOfTty('/dev/ttyUSB5', root), { port: '1-2', vendor: '2c7c', product: '0125' });
    assert.deepEqual(usbPortOfTty(twoModems.modems.e173.data, root)?.port, twoModems.modems.e173.port);
    assert.deepEqual(usbPortOfTty(twoModems.modems.ec25.data, root)?.port, twoModems.modems.ec25.port);
  });

  test('exact ancestor: a tty under 1-20 maps to 1-20, one under the hub port 1-2.3 to 1-2.3, never to 1-2', () => {
    const root = tree({
      usb: 'pci0000:00/0000:00:14.0',
      devices: [
        { port: 'usb1', path: 'usb1', idVendor: '1d6b', idProduct: '0002' },
        { port: '1-2', path: 'usb1/1-2', idVendor: '05e3', idProduct: '0608', product: 'USB2.0 Hub' },
        { port: '1-2.3', path: 'usb1/1-2/1-2.3', idVendor: '2c7c', idProduct: '0125' },
        { port: '1-20', path: 'usb1/1-20', idVendor: '12d1', idProduct: '1436' },
      ],
      interfaces: ['usb1/1-2/1-2.3/1-2.3:1.2', 'usb1/1-20/1-20:1.4'],
      ttys: { ttyUSB0: 'usb1/1-2/1-2.3/1-2.3:1.2/ttyUSB0', ttyUSB1: 'usb1/1-20/1-20:1.4/ttyUSB1' },
    });
    assert.deepEqual(usbPortOfTty('ttyUSB0', root), { port: '1-2.3', vendor: '2c7c', product: '0125' });
    assert.deepEqual(usbPortOfTty('ttyUSB1', root), { port: '1-20', vendor: '12d1', product: '1436' });
  });

  test('a port-named directory without idVendor is skipped and the walk continues to the real device', () => {
    const root = tree({
      devices: [{ port: '1-1', path: 'usb1/1-1', idVendor: '12d1', idProduct: '1436' }],
      // an odd intermediate directory named like a port but without ids
      interfaces: ['usb1/1-1/1-1:1.0', 'usb1/1-1/1-1:1.0/1-9'],
      ttys: { ttyUSB0: 'usb1/1-1/1-1:1.0/1-9/ttyUSB0' },
    });
    assert.deepEqual(usbPortOfTty('ttyUSB0', root), { port: '1-1', vendor: '12d1', product: '1436' });
  });

  test('a tty that is not on USB, a tty without a device link and a missing tty give null', () => {
    const root = tree({ devices: [], ttys: {} });
    // ttyS0: platform serial, no USB ancestor
    const serial = join(root, 'devices', 'platform', 'serial8250', 'tty', 'ttyS0');
    mkdirSync(serial, { recursive: true });
    symlinkSync(join(root, 'devices', 'platform', 'serial8250'), join(serial, 'device'));
    symlinkSync(serial, join(root, 'class', 'tty', 'ttyS0'));
    assert.equal(usbPortOfTty('ttyS0', root), null);
    // tty1: a virtual console has no device link at all
    mkdirSync(join(root, 'class', 'tty', 'tty1'));
    assert.equal(usbPortOfTty('tty1', root), null);
    assert.equal(usbPortOfTty('ttyUSB9', root), null);
    assert.equal(usbPortOfTty('ttyUSB0', join(tmp, 'no-such-root')), null);
  });

  test('tty names: /dev/ prefix stripped, anything that could leave the class directory refused', () => {
    assert.equal(ttyName('/dev/ttyUSB0'), 'ttyUSB0');
    assert.equal(ttyName('ttyACM1'), 'ttyACM1');
    for (const bad of ['', '/dev/', '..', '../x', '/etc/passwd', 'a/b', 'tty USB0', '/dev/serial/by-id/x']) {
      assert.throws(() => ttyName(bad), TypeError, bad);
      assert.throws(() => usbPortOfTty(bad, tmp), TypeError, bad);
    }
    assert.throws(() => ttyName(/** @type {any} */ (5)), TypeError);
  });

  test('listUsbModems: the two-modem tree lists the E173 and the EC25 with their drivers; root hubs never', () => {
    assert.deepEqual(listUsbModems(tree(twoModems)), [
      { port: '1-1', vendor: '12d1', product: '1436', driver: 'dongle' },
      { port: '1-2', vendor: '2c7c', product: '0125', driver: 'quectel' },
    ]);
    assert.deepEqual(MODEM_VENDORS, { '2c7c': 'quectel', '12d1': 'dongle' });
  });

  test('listUsbModems: other vendors, interfaces and a device without idVendor are left out; tree order; unreadable root throws', () => {
    const root = tree({
      devices: [
        { port: 'usb1', path: 'usb1', idVendor: '1d6b', idProduct: '0002' },
        { port: '1-10', path: 'usb1/1-10', idVendor: '2c7c', idProduct: '0125' },
        { port: '1-9', path: 'usb1/1-9', idVendor: '12d1', idProduct: '1506' },
        { port: '1-2', path: 'usb1/1-2', idVendor: '046d', idProduct: 'c52b', product: 'USB Receiver' },
        { port: '1-1.2', path: 'usb1/1-1/1-1.2', idVendor: '2c7c', idProduct: '0125' },
        { port: '1-1', path: 'usb1/1-1', idVendor: '05e3', idProduct: '0608' },
        { port: '1-3', path: 'usb1/1-3' },
      ],
      interfaces: ['usb1/1-9/1-9:1.0'],
    });
    // an interface entry in bus/usb/devices (the kernel lists them there too) never qualifies
    symlinkSync(join(root, 'devices', 'usb1', '1-9', '1-9:1.0'), join(root, 'bus', 'usb', 'devices', '1-9:1.0'));
    writeFileSync(join(root, 'devices', 'usb1', '1-3', 'idProduct'), '0125\n');
    assert.deepEqual(listUsbModems(root).map((d) => `${d.port} ${d.vendor}:${d.product} ${d.driver}`), ['1-1.2 2c7c:0125 quectel', '1-9 12d1:1506 dongle', '1-10 2c7c:0125 quectel']);
    assert.throws(() => listUsbModems(join(tmp, 'missing')), /ENOENT/);
    assert.deepEqual(listUsbModems(tree({ devices: [] })), []);
  });

  test('comparePorts orders by bus, then by each port level numerically; USB_PORT matches the registry syntax', () => {
    const ports = ['2-1', '1-10', '1-2', '1-1.10', '1-1.2', '1-1', '1-2.1.1'];
    assert.deepEqual([...ports].sort(comparePorts), ['1-1', '1-1.2', '1-1.10', '1-2', '1-2.1.1', '1-10', '2-1']);
    for (const ok of ['1-1', '1-2.3', '10-1.2.3']) assert.ok(USB_PORT.test(ok), ok);
    for (const bad of ['usb1', '1-1:1.0', '1-', '1', 'a-1', '1-1.']) assert.ok(!USB_PORT.test(bad), bad);
  });
});
