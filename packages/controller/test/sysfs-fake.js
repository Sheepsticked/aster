// @ts-check
// Test helper: builds a fake sysfs tree (devices, bus/usb/devices and class/tty symlinks as the kernel lays them out) from a
// test/fixtures/sysfs spec. Usage: const root = makeSysfs(join(tmp, 'sys'), loadSpec('two-modems.json')); usbPortOfTty('ttyUSB2', root)
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {object} SysfsSpec
 * @property {string} [usb]  path prefix under devices/ (the host controller)
 * @property {Array<{ port: string, path: string, idVendor?: string, idProduct?: string, product?: string }>} devices
 * @property {string[]} [interfaces]
 * @property {Record<string, string>} [ttys]  tty name → its usb-serial port directory under devices/ (prefix applied)
 */

const FIXTURES = new URL('./fixtures/sysfs/', import.meta.url);

/**
 * @param {string} name  a file of test/fixtures/sysfs
 * @returns {SysfsSpec & Record<string, any>}
 */
export const loadSpec = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

/**
 * @param {string} root  created; must not exist yet
 * @param {SysfsSpec} spec
 * @returns {string} root
 */
export function makeSysfs(root, spec) {
  const prefix = spec.usb ? `${spec.usb}/` : '';
  const devices = join(root, 'devices');
  const bus = join(root, 'bus', 'usb', 'devices');
  const classTty = join(root, 'class', 'tty');
  mkdirSync(bus, { recursive: true });
  mkdirSync(classTty, { recursive: true });
  for (const device of spec.devices) {
    const dir = join(devices, prefix + device.path);
    mkdirSync(dir, { recursive: true });
    if (device.idVendor !== undefined) writeFileSync(join(dir, 'idVendor'), `${device.idVendor}\n`);
    if (device.idProduct !== undefined) writeFileSync(join(dir, 'idProduct'), `${device.idProduct}\n`);
    if (device.product !== undefined) writeFileSync(join(dir, 'product'), `${device.product}\n`);
    symlinkSync(dir, join(bus, device.port));
  }
  for (const iface of spec.interfaces ?? []) mkdirSync(join(devices, prefix + iface), { recursive: true });
  for (const [tty, path] of Object.entries(spec.ttys ?? {})) {
    const portDir = join(devices, prefix + path);
    const ttyDir = join(portDir, 'tty', tty);
    mkdirSync(ttyDir, { recursive: true });
    symlinkSync(portDir, join(ttyDir, 'device'));
    symlinkSync(ttyDir, join(classTty, tty));
  }
  return root;
}
