// @ts-check
// Aster controller — the phone routes. Every change is one registry-apply (200 when done, 202 while running, 409 on failure);
// `rings_for` edits the modems' ring lists in the same apply. The secret is returned as stored, for handset setup.
import { applyRegistry, loadForChange } from '../ops.js';
import { create, numberParam, one, remove, update } from '../schemas/phones.js';

/** @typedef {import('../../config/registry.js').Phone} Phone */
/** @typedef {import('../../config/registry.js').Registry} Registry */

/**
 * One phone with the modems that ring it (and on the phone itself).
 * @param {Phone} phone
 * @param {Registry} registry
 */
export function phoneView(phone, registry) {
  return {
    number: phone.number,
    label: phone.label,
    secret: phone.secret,
    outbound: phone.outbound,
    context: phone.context,
    direct_media: phone.direct_media,
    rings_for: registry.modems.filter((modem) => modem.ring.includes(phone.number)).map((modem) => modem.id),
  };
}

/**
 * The modems after `number` is put into exactly the ring lists of `ringsFor`: a modem that gains it gets it appended (the others
 * keep their order), a modem that loses it keeps the rest, and every other modem is left as it is.
 * @param {Registry} registry
 * @param {string} number
 * @param {readonly string[]} ringsFor
 * @returns {{ ok: true, modems: Registry['modems'] } | { ok: false, error: string }}
 */
export function withRings(registry, number, ringsFor) {
  const unknown = ringsFor.filter((id) => !registry.modems.some((modem) => modem.id === id));
  if (unknown.length > 0) return { ok: false, error: `modem ${unknown.join(', ')} is not in modems` };
  const modems = registry.modems.map((modem) => {
    const wanted = ringsFor.includes(modem.id);
    if (wanted === modem.ring.includes(number)) return modem;
    return { ...modem, ring: wanted ? [...modem.ring, number] : modem.ring.filter((member) => member !== number) };
  });
  return { ok: true, modems };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function phoneRoutes(app, ctx) {
  /**
   * @param {string} number
   * @param {import('fastify').FastifyReply} reply
   * @returns {{ registry: Registry, hash: string | null, phone: Phone } | null}
   */
  function find(number, reply) {
    const current = loadForChange(ctx);
    if (!current.ok) {
      void reply.code(current.code).send({ error: current.error, problems: current.problems });
      return null;
    }
    const phone = current.registry.phones.find((entry) => entry.number === number);
    if (!phone) {
      void reply.code(404).send({ error: `no phone ${number} in config/aster.yaml` });
      return null;
    }
    return { registry: current.registry, hash: current.hash, phone };
  }

  app.get('/api/phones', async (request, reply) => {
    const current = loadForChange(ctx);
    if (!current.ok) return reply.code(current.code).send({ error: current.error, problems: current.problems });
    return reply.send({
      phones: current.registry.phones.map((phone) => phoneView(phone, current.registry)),
      registry: { present: current.present, hash: current.hash },
    });
  });

  app.get('/api/phones/:number', { schema: one }, async (request, reply) => {
    const found = find(/** @type {any} */ (request.params).number, reply);
    if (!found) return reply;
    return reply.send({ phone: phoneView(found.phone, found.registry), registry: { hash: found.hash } });
  });

  app.post('/api/phones', { schema: create }, async (request, reply) => {
    const body = /** @type {Record<string, any>} */ (request.body);
    const current = loadForChange(ctx);
    if (!current.ok) return reply.code(current.code).send({ error: current.error, problems: current.problems });
    const { force = false, rings_for: ringsFor, ...fields } = body;
    if (current.registry.phones.some((phone) => phone.number === fields.number)) {
      return reply.code(409).send({ error: `phone ${fields.number} already exists` });
    }
    const rings = withRings(current.registry, fields.number, ringsFor ?? []);
    if (!rings.ok) return reply.code(400).send({ error: rings.error });
    const next = { ...current.registry, modems: rings.modems, phones: [...current.registry.phones, fields] };
    const applied = await applyRegistry(ctx, { registry: next, baseHash: current.hash, force });
    if (!applied.ok) return reply.code(applied.code).send({ ok: false, error: applied.error, problems: applied.problems, operation: applied.operation, result: applied.result });
    ctx.log.info('phone added', { phone: fields.number, operation: applied.operation.id });
    const written = loadForChange(ctx);
    const phone = written.ok ? written.registry.phones.find((entry) => entry.number === fields.number) : null;
    return reply.code(201).send({ ok: true, operation: applied.operation, phone: phone && written.ok ? phoneView(phone, written.registry) : null });
  });

  app.put('/api/phones/:number', { schema: update }, async (request, reply) => {
    const number = /** @type {any} */ (request.params).number;
    const found = find(number, reply);
    if (!found) return reply;
    const { force = false, rings_for: ringsFor, ...fields } = /** @type {Record<string, any>} */ (request.body);
    const rings = ringsFor === undefined ? { ok: /** @type {const} */ (true), modems: found.registry.modems } : withRings(found.registry, number, ringsFor);
    if (!rings.ok) return reply.code(400).send({ error: rings.error });
    const merged = { ...found.phone, ...fields };
    const next = { ...found.registry, modems: rings.modems, phones: found.registry.phones.map((phone) => (phone.number === number ? merged : phone)) };
    const applied = await applyRegistry(ctx, { registry: next, baseHash: found.hash, force });
    if (!applied.ok) return reply.code(applied.code).send({ ok: false, error: applied.error, problems: applied.problems, operation: applied.operation, result: applied.result });
    const changed = ringsFor === undefined ? Object.keys(fields) : [...Object.keys(fields), 'rings_for'];
    ctx.log.info('phone changed', { phone: number, fields: changed, operation: applied.operation.id });
    const written = loadForChange(ctx);
    const phone = written.ok ? written.registry.phones.find((entry) => entry.number === number) : null;
    return reply.send({ ok: true, operation: applied.operation, phone: phone && written.ok ? phoneView(phone, written.registry) : null });
  });

  app.delete('/api/phones/:number', { schema: remove }, async (request, reply) => {
    const number = /** @type {any} */ (request.params).number;
    const found = find(number, reply);
    if (!found) return reply;
    const rings = found.registry.modems.filter((modem) => modem.ring.includes(number)).map((modem) => modem.id);
    if (rings.length > 0) {
      return reply.code(409).send({ error: `modem ${rings.join(', ')} rings phone ${number}; take it out of ${rings.length === 1 ? 'that ring group' : 'those ring groups'} first` });
    }
    const next = { ...found.registry, phones: found.registry.phones.filter((phone) => phone.number !== number) };
    const applied = await applyRegistry(ctx, { registry: next, baseHash: found.hash, force: /** @type {any} */ (request.body)?.force === true });
    if (!applied.ok) return reply.code(applied.code).send({ ok: false, error: applied.error, problems: applied.problems, operation: applied.operation, result: applied.result });
    ctx.log.info('phone deleted', { phone: number, operation: applied.operation.id });
    return reply.send({ ok: true, operation: applied.operation, phone: null });
  });
}
