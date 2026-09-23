// @ts-check
// Aster controller — USB topology from sysfs (read-only): which USB port a tty hangs off, and which modem devices are
// plugged in. A tty maps to its nearest ancestor named like a port path (`1-2.3`) that holds idVendor.
// Usage: usbPortOfTty('/dev/ttyUSB2') → { port: '1-1', vendor: '12d1', product: '1436' } | null
//        listUsbModems() → [{ port: '1-1', vendor: '12d1', product: '1436', driver: 'dongle' }, …]  (throws when /sys is unreadable)
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** USB vendor id → the driver that speaks to it. */
export const MODEM_VENDORS = Object.freeze({ '2c7c': 'quectel', '12d1': 'dongle' });
/** A kernel USB port path: `<bus>-<port>[.<port>…]` (the registry's usb_port rule). */
export const USB_PORT = /^[0-9]+-[0-9]+(?:\.[0-9]+)*$/;
/** Where the host's sysfs is mounted in the controller container. */
export const DEFAULT_ROOT = '/sys';
const TTY_NAME = /^[A-Za-z0-9_.:+@-]+$/;
const ID = /^[0-9a-f]{4}$/;

/** @typedef {{ port: string, vendor: string, product: string }} UsbDevice */
/** @typedef {UsbDevice & { driver: 'quectel' | 'dongle' }} UsbModem */

/**
 * The tty name of `/dev/ttyUSB0` or `ttyUSB0`; anything else (a path elsewhere, `..`, an empty name) is a TypeError.
 * @param {string} tty
 */
export function ttyName(tty) {
  if (typeof tty !== 'string') throw new TypeError('the tty must be a string');
  const name = tty.startsWith('/dev/') ? tty.slice('/dev/'.length) : tty;
  if (!TTY_NAME.test(name) || name === '.' || name === '..') throw new TypeError(`not a tty name: ${JSON.stringify(tty)}`);
  return name;
}

/**
 * The 4-hex-digit content of an id file (`idVendor`, `idProduct`), lower case; null when absent or not an id.
 * @param {string} dir
 * @param {string} file
 */
function readId(dir, file) {
  let text;
  try {
    text = fs.readFileSync(join(dir, file), 'latin1');
  } catch {
    return null;
  }
  const id = text.trim().toLowerCase();
  return ID.test(id) ? id : null;
}

/**
 * The USB device a tty belongs to: the nearest ancestor of its sysfs device whose name is a port path and which carries idVendor.
 * null when the tty does not exist, has no sysfs device, or is not on USB (`ttyS0`, a virtual tty).
 * @param {string} tty  `ttyUSB2` or `/dev/ttyUSB2`
 * @param {string} [root]  the sysfs mount (tests pass a fake tree)
 * @returns {UsbDevice | null}
 */
export function usbPortOfTty(tty, root = DEFAULT_ROOT) {
  const name = ttyName(tty);
  let device;
  try {
    device = fs.realpathSync(join(root, 'class', 'tty', name, 'device'));
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null;
    throw err;
  }
  let top;
  try {
    top = fs.realpathSync(root);
  } catch {
    top = root;
  }
  for (let dir = device; dir.startsWith(`${top}/`); dir = dirname(dir)) {
    if (USB_PORT.test(basename(dir))) {
      const vendor = readId(dir, 'idVendor');
      if (vendor !== null) return { port: basename(dir), vendor, product: readId(dir, 'idProduct') ?? '' };
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

/**
 * Port paths in tree order: `1-1` before `1-1.2` before `1-2`, numerically within each level.
 * @param {string} a
 * @param {string} b
 */
export function comparePorts(a, b) {
  const pa = a.split(/[-.]/).map(Number);
  const pb = b.split(/[-.]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Every plugged-in USB device of a modem vendor, by port. Throws when the sysfs tree is unreadable (no /sys mount): the caller
 * decides whether that is fatal or "presence unknown".
 * @param {string} [root]
 * @returns {UsbModem[]}
 */
export function listUsbModems(root = DEFAULT_ROOT) {
  const dir = join(root, 'bus', 'usb', 'devices');
  const names = fs.readdirSync(dir);
  /** @type {UsbModem[]} */
  const out = [];
  for (const name of names) {
    if (!USB_PORT.test(name)) continue;
    const vendor = readId(join(dir, name), 'idVendor');
    if (vendor === null) continue;
    const driver = /** @type {('quectel' | 'dongle') | undefined} */ (MODEM_VENDORS[/** @type {keyof typeof MODEM_VENDORS} */ (vendor)]);
    if (!driver) continue;
    out.push({ port: name, vendor, product: readId(join(dir, name), 'idProduct') ?? '', driver });
  }
  return out.sort((a, b) => comparePorts(a.port, b.port));
}
