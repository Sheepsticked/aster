// @ts-check
// Aster controller — the configuration file routes: hand-owned config/asterisk files are edited and applied via
// `config-apply`; generated aster.d files are read-only. Each listed file carries its hash and applied/restart state.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HAND_FILES } from '../../config/apply.js';
import { fileHash, readFile, sha256 } from '../../config/atomic.js';
import { GENERATED_FILES, generateAll } from '../../config/generators.js';
import { RELOAD, RESTART, reloadFor } from '../../config/reloadmap.js';
import { prevPath } from '../../config/prev.js';
import { DEFAULTS, settle, view } from '../ops.js';
import { apply as applySchema, restore as restoreSchema } from '../schemas/config.js';

/** Every file the API knows, hand-owned first; anything else is a 404 before a path is built from a name. */
export const FILES = Object.freeze([...HAND_FILES, ...GENERATED_FILES]);
/** The hash of the file each done config-apply/config-restore left behind — what "applied" means for a hand-owned file. */
const LAST_APPLIED = `SELECT json_extract(result_json, '$.name') AS name, json_extract(result_json, '$.hash') AS hash, MAX(id) AS id
  FROM operations WHERE kind IN ('config-apply', 'config-restore') AND status = 'done' AND result_json IS NOT NULL
  GROUP BY json_extract(result_json, '$.name')`;

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function configRoutes(app, ctx) {
  const applyWaitMs = ctx.timing.applyWaitMs ?? DEFAULTS.applyWaitMs;
  const dir = ctx.paths.asteriskConfig;

  /** The name of the file a request addresses, or null when it is not one of ours. @param {unknown} raw */
  const nameOf = (raw) => (typeof raw === 'string' && FILES.includes(raw) ? raw : null);

  /** @returns {Map<string, string>} name → the hash the last done operation left */
  function appliedHashes() {
    /** @type {Map<string, string>} */
    const out = new Map();
    for (const row of ctx.db.prepare(LAST_APPLIED).all()) {
      if (typeof row.name === 'string' && typeof row.hash === 'string') out.set(row.name, row.hash);
    }
    return out;
  }

  /**
   * One entry of the file list.
   * @param {string} name
   * @param {Map<string, string>} applied
   * @param {Map<string, string>} generated  the aster.d files the registry would produce now
   */
  function entry(name, applied, generated) {
    const path = join(dir, name);
    const isGenerated = GENERATED_FILES.includes(name);
    let hash = null;
    let size = null;
    let modified_at = null;
    try {
      const stat = statSync(path);
      size = stat.size;
      modified_at = Math.round(stat.mtimeMs);
      hash = fileHash(path);
    } catch {
      hash = null; // not written yet (install.sh copies the templates; the aster.d files appear with the first apply)
    }
    const last = applied.get(name) ?? null;
    const status = hash === null ? 'missing'
      : isGenerated ? 'generated'
      : last === null || last === hash ? 'applied' : 'modified';
    return {
      name,
      kind: isGenerated ? 'generated' : 'hand',
      editable: !isGenerated,
      present: hash !== null,
      hash,
      size,
      modified_at,
      status,
      applied_hash: last,
      // For a generated file this says whether it is still what the registry produces; the registry route rewrites it if not.
      matches_registry: isGenerated ? (generated.has(name) ? generated.get(name) === hash : null) : null,
      restorable: !isGenerated && existsSync(prevPath(ctx.paths.prev, name)),
      restart_required: (RELOAD[name] ?? []).includes(RESTART),
      reload: (reloadFor(name) ?? []).map((action) => ('Command' in action ? `Command: ${action.Command}` : action.action)),
    };
  }

  app.get('/api/config/files', async (request, reply) => {
    /** @type {Map<string, string>} */
    const generated = new Map();
    try {
      const registry = ctx.registry();
      if (registry) {
        for (const [name, text] of Object.entries(generateAll(registry))) generated.set(name, sha256(text));
      }
    } catch {
      // An invalid registry: the generated files are listed without the comparison rather than failing the whole list.
    }
    const applied = appliedHashes();
    return reply.send({ files: FILES.map((name) => entry(name, applied, generated)), dir });
  });

  app.get('/api/config/files/*', async (request, reply) => {
    const name = nameOf(/** @type {any} */ (request.params)['*']);
    if (name === null) return reply.code(404).send({ error: `no configuration file ${JSON.stringify(String(/** @type {any} */ (request.params)['*']))}; GET /api/config/files lists them` });
    const path = join(dir, name);
    /** @type {import('../../config/atomic.js').FileContent | null} */
    let current = null;
    try {
      current = readFile(path);
    } catch (err) {
      return reply.code(500).send({ error: `${name} cannot be read: ${err instanceof Error ? err.message : String(err)}` });
    }
    const file = entry(name, appliedHashes(), new Map());
    if (current === null) return reply.code(404).send({ error: `${name} does not exist in ${dir}`, file });
    return reply.send({ ...file, content: current.text });
  });

  app.put('/api/config/files/*', { schema: applySchema }, async (request, reply) => {
    const raw = /** @type {any} */ (request.params)['*'];
    const name = nameOf(raw);
    if (name === null) return reply.code(404).send({ error: `no configuration file ${JSON.stringify(String(raw))}; GET /api/config/files lists them` });
    if (GENERATED_FILES.includes(name)) {
      return reply.code(409).send({ error: `${name} is generated from config/aster.yaml and cannot be edited; change the modems, phones or settings instead` });
    }
    const body = /** @type {{ content: string, base_hash?: string | null, force?: boolean, restart?: boolean }} */ (request.body);
    const id = ctx.runner.enqueue({
      kind: 'config-apply',
      modemId: null,
      params: { name, content: body.content, base_hash: body.base_hash ?? null, force: body.force === true, restart: body.restart === true },
      actor: 'admin',
    });
    return answer(reply, id, `${name} is still being applied`);
  });

  app.post('/api/config/files/:name/restore', { schema: restoreSchema }, async (request, reply) => {
    const raw = /** @type {any} */ (request.params).name;
    const name = nameOf(raw);
    if (name === null || GENERATED_FILES.includes(name)) {
      return reply.code(404).send({ error: `no restorable configuration file ${JSON.stringify(String(raw))}; GET /api/config/files lists them` });
    }
    if (!existsSync(prevPath(ctx.paths.prev, name))) {
      return reply.code(409).send({ error: `no previous version of ${name} is stored; one is kept from the first apply through the controller` });
    }
    const body = /** @type {{ base_hash?: string | null, restart?: boolean }} */ (request.body ?? {});
    const id = ctx.runner.enqueue({
      kind: 'config-restore',
      modemId: null,
      params: { name, base_hash: body.base_hash ?? null, restart: body.restart === true },
      actor: 'admin',
    });
    return answer(reply, id, `${name} is still being restored`);
  });

  /**
   * The reply of a config operation: its outcome when it finished quickly, 202 with the operation while it runs on (a file that
   * needs `core restart gracefully` waits for the last call to end), 409 with the operation's own message when it failed.
   * @param {import('fastify').FastifyReply} reply
   * @param {number} id
   * @param {string} waiting
   */
  async function answer(reply, id, waiting) {
    const finished = await settle(ctx, id, applyWaitMs);
    if (finished === null) {
      const op = ctx.runner.get(id);
      return reply.code(202).send({ ok: false, error: `${waiting} after ${applyWaitMs} ms; the operation continues`, operation: op ? view(op) : { id, status: 'running' } });
    }
    if (finished.status !== 'done') {
      ctx.log.warn('a configuration file was not applied', { operation: id, status: finished.status, error: finished.error });
      return reply.code(409).send({ ok: false, error: finished.error, operation: view(finished) });
    }
    return reply.send({ ok: true, operation: view(finished) });
  }
}
