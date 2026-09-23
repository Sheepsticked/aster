// @ts-check
// Default phone layout: the starter phones are internal only until modem gsm1 or gsm2 is assigned; then that
// modem's block dials out through it and is rung by it. Phones the admin already changed are left alone.
// Usage: const { registry, linked } = assignWithStarterPhones(current, fields)

/** @typedef {import('./registry.js').Registry} Registry */

/** The phones of each default modem id, in ring order. */
export const STARTER_BLOCKS = Object.freeze(/** @type {Readonly<Record<string, readonly string[]>>} */ ({
  gsm1: Object.freeze(['504', '505', '506', '507', '508']),
  gsm2: Object.freeze(['511', '512', '513', '514', '515']),
}));

/**
 * The registry with the new modem added and, when it has a default id and no ring group of its own, its internal-only starter
 * phones pointed at it and rung by it.
 * @param {Registry} registry  the registry as it is now
 * @param {Record<string, any>} fields  the new modem as the request gave it
 * @returns {{ registry: Record<string, any>, linked: string[] }}  linked = the phone numbers now dialing out through the modem
 */
export function assignWithStarterPhones(registry, fields) {
  const block = (Object.hasOwn(STARTER_BLOCKS, fields.id) && !Object.hasOwn(fields, 'ring') && STARTER_BLOCKS[fields.id]) || [];
  const linked = block.filter((number) => registry.phones.some((phone) => phone.number === number && phone.outbound === null));
  if (linked.length === 0) return { registry: { ...registry, modems: [...registry.modems, fields] }, linked };
  return {
    registry: {
      ...registry,
      modems: [...registry.modems, { ...fields, ring: linked }],
      phones: registry.phones.map((phone) => (linked.includes(phone.number) ? { ...phone, outbound: fields.id } : phone)),
    },
    linked,
  };
}
