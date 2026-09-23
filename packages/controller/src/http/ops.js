// @ts-check
// Aster controller — helpers for routes that start an operation (the only way the API changes Asterisk or a modem).
// Quick changes wait briefly for their outcome; long ones answer 202 with `{operation}` and the event stream carries the rest.
import { RegistryError, validate } from '../config/registry.js';

/** How long a route waits for a registry-apply or a config-apply before it answers 202 with the operation. */
export const DEFAULTS = Object.freeze(/** @type {Readonly<{ applyWaitMs: number }>} */ ({ applyWaitMs: 20_000 }));

/** @typedef {import('../ops/runner.js').Operation} Operation */
/** @typedef {import('../config/registry.js').Registry} Registry */
/** @typedef {import('./server.js').Ctx} Ctx */
/** @typedef {{ id: number, kind: string, status: string, error: string | null, result: Record<string, unknown> | null }} Started */

/**
 * An operations row as the API returns it, with params and result parsed.
 * @param {Operation} op
 */
export function view(op) {
  return {
    id: op.id,
    kind: op.kind,
    modem_id: op.modem_id,
    status: op.status,
    params: op.params,
    result: op.result,
    error: op.error,
    actor: op.actor,
    created_at: op.created_at,
    started_at: op.started_at,
    finished_at: op.finished_at,
  };
}

/**
 * The operation once it has finished, or null when it has not within `ms` (the caller answers 202 then). wait() resolves only for
 * a finished operation and rejects when there is none or the runner has stopped — neither is an outcome, so both are null here.
 * @param {Ctx} ctx
 * @param {number} id
 * @param {number} ms
 * @returns {Promise<Operation | null>}
 */
export async function settle(ctx, id, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  try {
    return /** @type {Operation | null} */ (await Promise.race([ctx.runner.wait(id).catch(() => null), deadline]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enqueues an operation and answers without waiting: the caller sends `{operation}` with 202.
 * @param {Ctx} ctx
 * @param {import('../ops/runner.js').EnqueueRequest} request
 * @returns {Started}
 */
export function start(ctx, request) {
  const id = ctx.runner.enqueue(request);
  const op = ctx.runner.get(id);
  return { id, kind: request.kind, status: op?.status ?? 'queued', error: null, result: null };
}

/**
 * Writes a registry through one registry-apply and waits for it: `{ok: true}` with the finished operation, or the refusal a route
 * sends unchanged (202 while it runs on, 409 when it failed — the registry is then untouched, because the operation writes the file
 * only after every check inside it passed).
 * @param {Ctx} ctx
 * @param {object} request
 * @param {unknown} request.registry     the whole registry as it should be (validated here, and again by the operation)
 * @param {string | null} request.baseHash  the hash of the file it was read from; null before install.sh has written one
 * @param {boolean} [request.force]      apply although the file changed on disk meanwhile
 * @param {number} [request.waitMs]
 * @returns {Promise<{ ok: true, operation: Started } | { ok: false, code: number, error: string, operation: Started | null,
 *   result: Record<string, unknown> | null, problems?: readonly { path: string, message: string }[] }>}
 */
export async function applyRegistry(ctx, { registry, baseHash, force = false, waitMs }) {
  const ms = waitMs ?? ctx.timing.applyWaitMs ?? DEFAULTS.applyWaitMs;
  try {
    validate(registry);
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err;
    return { ok: false, code: 400, error: `the change would make the registry invalid: ${err.errors.length} problem(s)`,
      operation: null, result: null, problems: err.errors };
  }
  const id = ctx.runner.enqueue({ kind: 'registry-apply', modemId: null, params: { registry, base_hash: baseHash, force }, actor: 'admin' });
  const finished = await settle(ctx, id, ms);
  /** @type {Started} */
  const operation = { id, kind: 'registry-apply', status: finished?.status ?? ctx.runner.get(id)?.status ?? 'running',
    error: finished?.error ?? null, result: finished?.result ?? null };
  if (operation.status === 'done') return { ok: true, operation };
  ctx.log.warn('a registry change was not applied', { operation: id, status: operation.status, error: operation.error });
  return {
    ok: false,
    code: finished === null ? 202 : 409,
    error: finished === null ? `the registry is still being applied after ${ms} ms; the operation continues` : String(operation.error),
    operation,
    result: finished?.result ?? null,
  };
}

/**
 * The registry on disk with its hash, for a route that is about to read or change it. A file that is not there yet is the empty
 * registry with hash null (install.sh has not run; registry-apply would create it); one that does not parse is the 409 the route
 * sends unchanged, with the problems, so the UI can point at config/aster.yaml.
 * @param {Ctx} ctx
 * @returns {{ ok: true, registry: Registry, hash: string | null, present: boolean }
 *   | { ok: false, code: number, error: string, problems: readonly { path: string, message: string }[] }}
 */
export function loadForChange(ctx) {
  try {
    const { registry, hash, present } = ctx.registryFile();
    return { ok: true, registry, hash, present };
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err;
    return { ok: false, code: 409, error: `config/aster.yaml is invalid, so it cannot be changed here: ${err.errors.length} problem(s)`, problems: err.errors };
  }
}
