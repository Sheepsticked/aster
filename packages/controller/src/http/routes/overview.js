// @ts-check
// Aster controller — GET /api/overview: each registry modem with its UI state derived now, the unassigned
// devices of the last scan (filtered by the same rule as scan.js), and the health strip, in one request.
import { RegistryError } from '../../config/registry.js';
import { modemView } from './modems.js';

/** @typedef {import('../../config/registry.js').Modem} Modem */
/** @typedef {import('../../config/registry.js').Registry} Registry */
/** @typedef {import('../../devices/scan.js').ScannedDevice} ScannedDevice */

/**
 * Whether no modem of the registry owns this device — the rule scan.js classifies with.
 * @param {ScannedDevice} device
 * @param {Registry} registry
 */
export function unassigned(device, registry) {
  return !registry.modems.some((modem) => (device.imei !== null && modem.imei === device.imei)
    || (modem.ports !== null && modem.ports.data === device.data_tty)
    || (modem.usb_port !== null && device.usb_port !== null && modem.usb_port === device.usb_port));
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function overviewRoutes(app, ctx) {
  app.get('/api/overview', async (request, reply) => {
    /** @type {Registry | null} */
    let registry = null;
    /** @type {readonly { path: string, message: string }[]} */
    let problems = [];
    try {
      registry = ctx.registry();
    } catch (err) {
      if (!(err instanceof RegistryError)) throw err;
      problems = err.errors;
    }
    const health = await ctx.health.check();
    if (registry === null) {
      return reply.send({ modems: [], unassigned: [], scan: null, health, registry: { valid: false, problems } });
    }

    const states = ctx.devices?.states() ?? new Map();
    const scan = ctx.scan?.latest() ?? null;
    const modems = registry.modems.map((modem) => modemView(modem, ctx, states));
    return reply.send({
      modems,
      unassigned: (scan?.unassigned ?? []).filter((device) => unassigned(device, /** @type {Registry} */ (registry))),
      scan: scan === null ? null : { at: scan.at, trigger: scan.trigger, devices: scan.devices.length, errors: scan.errors },
      health,
      registry: { valid: true, problems: [] },
    });
  });
}
