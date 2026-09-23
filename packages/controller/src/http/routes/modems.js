// @ts-check
// Aster controller — the modem routes. Registry changes (assign, edit, delete) go through one registry-apply and wait;
// device actions (start, stop, AT, USSD, ...) answer 202 at once and are followed on /api/events.
import { TIMED } from '../../at/forwarding.js';
import { assignWithStarterPhones } from '../../config/starter.js';
import { start as startOp, applyRegistry, loadForChange } from '../ops.js';
import { action as actionSchema, at as atSchema, create, forwarding as forwardingSchema, idParam, remove, update, ussd as ussdSchema,
  ussdCancel as ussdCancelSchema } from '../schemas/modems.js';

/** The device actions and the operation kind each one enqueues; `modem-remove` is reconcile's, not the API's. */
export const ACTIONS = Object.freeze(/** @type {Readonly<Record<string, string>>} */ ({
  start: 'modem-start', stop: 'modem-stop', restart: 'modem-restart', reset: 'modem-reset', remap: 'remap',
}));

/** @typedef {import('../../config/registry.js').Modem} Modem */
/** @typedef {import('../../config/registry.js').Registry} Registry */
/** @typedef {import('../server.js').Ctx} Ctx */

/**
 * One modem as every page shows it: its registry fields, the last observation and the UI state derived now.
 * @param {Modem} modem
 * @param {Ctx} ctx
 * @param {Map<string, any>} states  ctx.devices.states()
 */
export function modemView(modem, ctx, states) {
  const row = states.get(modem.id) ?? null;
  const detail = row?.detail ?? null;
  return {
    id: modem.id,
    driver: modem.driver,
    imei: modem.imei,
    enabled: modem.enabled,
    uac: modem.uac,
    usb_port: modem.usb_port,
    group: modem.group,
    ring: [...modem.ring],
    ring_timeout: modem.ring_timeout,
    incoming_context: modem.incoming_context,
    recipients: modem.recipients === null ? null : [...modem.recipients],
    ports: modem.ports === null ? null : { ...modem.ports },
    state: ctx.devices?.stateOf(modem) ?? 'unverified',
    driver_state: row?.driver_state ?? null,
    gsm_registration: row?.gsm_reg ?? null,
    rssi: row?.rssi ?? null,
    provider: row?.provider ?? null,
    number: row?.number ?? null,
    data_tty: row?.data_tty ?? null,
    observed_at: row?.observed_at ?? null,
    forwarding: detail?.forwarding ?? null,
    detail: detail === null ? null : {
      listed: detail.listed,
      current: detail.current,
      desired: detail.desired,
      flapping: detail.flapping,
      imsi: detail.imsi,
      model: detail.model,
      firmware: detail.firmware,
      calls: detail.calls,
      disconnects: detail.disconnects,
      reason: detail.reason,
      radio: detail.radio,
    },
  };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {Ctx} ctx
 */
export function modemRoutes(app, ctx) {
  /**
   * The registry for a read, the modem in it, and the reply when either is missing.
   * @param {string} id
   * @param {import('fastify').FastifyReply} reply
   * @returns {{ registry: Registry, hash: string | null, modem: Modem } | null}
   */
  function find(id, reply) {
    const current = loadForChange(ctx);
    if (!current.ok) {
      void reply.code(current.code).send({ error: current.error, problems: current.problems });
      return null;
    }
    const modem = current.registry.modems.find((entry) => entry.id === id);
    if (!modem) {
      void reply.code(404).send({ error: `no modem ${id} in config/aster.yaml` });
      return null;
    }
    return { registry: current.registry, hash: current.hash, modem };
  }

  /** The modems of a registry as the list and the single-modem route return them. @param {Registry} registry */
  const views = (registry) => {
    const states = ctx.devices?.states() ?? new Map();
    return registry.modems.map((modem) => modemView(modem, ctx, states));
  };

  app.get('/api/modems', async (request, reply) => {
    const current = loadForChange(ctx);
    if (!current.ok) return reply.code(current.code).send({ error: current.error, problems: current.problems });
    return reply.send({ modems: views(current.registry), registry: { present: current.present, hash: current.hash } });
  });

  app.get('/api/modems/:id', { schema: { params: idParam } }, async (request, reply) => {
    const found = find(/** @type {any} */ (request.params).id, reply);
    if (!found) return reply;
    const states = ctx.devices?.states() ?? new Map();
    return reply.send({ modem: modemView(found.modem, ctx, states), registry: { hash: found.hash } });
  });

  // Assign: a scanned device (its IMEI, USB port and driver come from /api/scan/latest) or an IMEI typed by hand becomes a modem.
  // gsm1 and gsm2 take over their internal-only starter phones in the same apply (config/starter.js).
  app.post('/api/modems', { schema: create }, async (request, reply) => {
    const body = /** @type {Record<string, any>} */ (request.body);
    const current = loadForChange(ctx);
    if (!current.ok) return reply.code(current.code).send({ error: current.error, problems: current.problems });
    const { force = false, ...fields } = body;
    const taken = current.registry.modems.find((modem) => modem.id === fields.id || modem.imei === fields.imei
      || (fields.usb_port != null && modem.usb_port === fields.usb_port));
    if (taken) {
      return reply.code(409).send({ error: `modem ${taken.id} already has that ${taken.id === fields.id ? 'id' : taken.imei === fields.imei ? 'IMEI' : 'USB port'}` });
    }
    const { registry: next, linked } = assignWithStarterPhones(current.registry, fields);
    const applied = await applyRegistry(ctx, { registry: next, baseHash: current.hash, force });
    if (!applied.ok) return reply.code(applied.code).send({ ok: false, error: applied.error, problems: applied.problems, operation: applied.operation, result: applied.result });
    ctx.log.info('modem assigned', { modem: fields.id, imei: fields.imei, linked, operation: applied.operation.id });
    const written = loadForChange(ctx);
    const modem = written.ok ? written.registry.modems.find((entry) => entry.id === fields.id) : null;
    return reply.code(201).send({ ok: true, operation: applied.operation, modem: modem ? modemView(modem, ctx, ctx.devices?.states() ?? new Map()) : null });
  });

  app.put('/api/modems/:id', { schema: update }, async (request, reply) => {
    const id = /** @type {any} */ (request.params).id;
    const body = /** @type {Record<string, any>} */ (request.body);
    const found = find(id, reply);
    if (!found) return reply;
    const { force = false, ...fields } = body;
    const merged = { ...found.modem, ...fields };
    const next = { ...found.registry, modems: found.registry.modems.map((modem) => (modem.id === id ? merged : modem)) };
    const applied = await applyRegistry(ctx, { registry: next, baseHash: found.hash, force });
    if (!applied.ok) return reply.code(applied.code).send({ ok: false, error: applied.error, problems: applied.problems, operation: applied.operation, result: applied.result });
    ctx.log.info('modem changed', { modem: id, fields: Object.keys(fields), operation: applied.operation.id });
    const written = loadForChange(ctx);
    const modem = written.ok ? written.registry.modems.find((entry) => entry.id === id) : null;
    return reply.send({ ok: true, operation: applied.operation, modem: modem ? modemView(modem, ctx, ctx.devices?.states() ?? new Map()) : null });
  });

  // Delete: the apply's reconcile step tells the driver to Remove the device that is no longer generated (src/reconcile.js).
  app.delete('/api/modems/:id', { schema: remove }, async (request, reply) => {
    const id = /** @type {any} */ (request.params).id;
    const found = find(id, reply);
    if (!found) return reply;
    const rings = found.registry.phones.filter((phone) => phone.outbound === id).map((phone) => phone.number);
    if (rings.length > 0) {
      return reply.code(409).send({ error: `phone ${rings.join(', ')} dials out through modem ${id}; change or delete ${rings.length === 1 ? 'it' : 'them'} first` });
    }
    const next = { ...found.registry, modems: found.registry.modems.filter((modem) => modem.id !== id) };
    const applied = await applyRegistry(ctx, { registry: next, baseHash: found.hash, force: /** @type {any} */ (request.body)?.force === true });
    if (!applied.ok) return reply.code(applied.code).send({ ok: false, error: applied.error, problems: applied.problems, operation: applied.operation, result: applied.result });
    ctx.log.info('modem deleted', { modem: id, operation: applied.operation.id });
    return reply.send({ ok: true, operation: applied.operation, modem: null });
  });

  // The device actions: enqueued and answered at once, because a graceful stop waits for calls to end (up to the drivers' own time).
  for (const [verb, kind] of Object.entries(ACTIONS)) {
    app.post(`/api/modems/:id/${verb}`, { schema: actionSchema }, async (request, reply) => {
      const id = /** @type {any} */ (request.params).id;
      const found = find(id, reply);
      if (!found) return reply;
      const when = /** @type {any} */ (request.body)?.when;
      const params = kind === 'remap' ? { reason: 'asked for through the API', trigger: 'admin' } : (when === undefined ? {} : { when });
      const operation = startOp(ctx, { kind, modemId: id, params, actor: 'admin' });
      ctx.log.info('modem action queued', { modem: id, kind, operation: operation.id });
      return reply.code(202).send({ operation });
    });
  }

  // Forwarding: GET is what the last queries observed per condition (only a query writes it, never a mutation), POST runs the next one.
  app.get('/api/modems/:id/forwarding', { schema: { params: idParam } }, async (request, reply) => {
    const found = find(/** @type {any} */ (request.params).id, reply);
    if (!found) return reply;
    const row = ctx.devices?.states().get(found.modem.id) ?? null;
    return reply.send({ modem_id: found.modem.id, forwarding: row?.detail?.forwarding ?? null });
  });

  app.post('/api/modems/:id/forwarding', { schema: forwardingSchema }, async (request, reply) => {
    const id = /** @type {any} */ (request.params).id;
    const body = /** @type {{ action: string, reason?: string, number?: string, time?: number }} */ (request.body);
    const found = find(id, reply);
    if (!found) return reply;
    if (body.action === 'set' && body.number === undefined) return reply.code(400).send({ error: 'forwarding action "set" needs the number to forward to' });
    if (body.action !== 'set' && body.number !== undefined) return reply.code(400).send({ error: `forwarding action ${JSON.stringify(body.action)} takes no number` });
    if (body.time !== undefined && (body.action !== 'set' || !TIMED.includes(/** @type {any} */ (body.reason)))) {
      return reply.code(400).send({ error: `a wait goes only with "set" for ${TIMED.join(' or ')}` });
    }
    if (body.reason === 'all' && body.action !== 'query') return reply.code(400).send({ error: 'reason "all" is only for "query"' });
    const operation = startOp(ctx, { kind: 'forwarding', modemId: id, params: { ...body }, actor: 'admin' });
    ctx.log.info('forwarding queued', { modem: id, action: body.action, reason: body.reason ?? 'unconditional', operation: operation.id });
    return reply.code(202).send({ operation });
  });

  app.post('/api/modems/:id/at', { schema: atSchema }, async (request, reply) => {
    const id = /** @type {any} */ (request.params).id;
    const body = /** @type {{ command: string, timeout?: number }} */ (request.body);
    const found = find(id, reply);
    if (!found) return reply;
    const operation = startOp(ctx, { kind: 'at', modemId: id, params: { command: body.command, ...(body.timeout === undefined ? {} : { timeout: body.timeout }) }, actor: 'admin' });
    ctx.log.info('AT command queued', { modem: id, operation: operation.id });
    return reply.code(202).send({ operation });
  });

  app.post('/api/modems/:id/ussd', { schema: ussdSchema }, async (request, reply) => {
    const id = /** @type {any} */ (request.params).id;
    const body = /** @type {{ code: string }} */ (request.body);
    const found = find(id, reply);
    if (!found) return reply;
    const operation = startOp(ctx, { kind: 'ussd', modemId: id, params: { code: body.code }, actor: 'admin' });
    ctx.log.info('USSD queued', { modem: id, code: body.code, operation: operation.id });
    return reply.code(202).send({ operation });
  });

  // Ends a USSD session the network keeps open for an answer (a menu).
  app.post('/api/modems/:id/ussd/cancel', { schema: ussdCancelSchema }, async (request, reply) => {
    const id = /** @type {any} */ (request.params).id;
    const found = find(id, reply);
    if (!found) return reply;
    const operation = startOp(ctx, { kind: 'ussd-cancel', modemId: id, params: {}, actor: 'admin' });
    ctx.log.info('USSD cancel queued', { modem: id, operation: operation.id });
    return reply.code(202).send({ operation });
  });
}
