// `settleChange`: a registry change may answer 202 while still applying; wait for its operation before refetching.
// `runOperation`: start a device action (always 202) and wait for its outcome.
import { t } from '../i18n/index.js';
import { live } from './live.svelte.js';
import { messageOf } from './errors.js';
import { toasts } from './toasts.svelte.js';

/**
 * Whether a change is in place, waiting for its operation when the controller is still applying it.
 * @param {{ status: number, data: any }} answer  what api.js returns for a mutation
 * @returns {Promise<{ applied: boolean, operation: any | null }>}
 */
export async function settleChange({ status, data }) {
  const operation = data?.operation ?? null;
  if (status !== 202 && data?.ok !== false) return { applied: true, operation };
  if (typeof operation?.id !== 'number') return { applied: false, operation };
  toasts.push({ text: t('toast.applying') });
  const finished = await live.follow(operation.id);
  if (finished === null) {
    toasts.push({ kind: 'error', text: t('toast.apply_slow') });
    return { applied: false, operation };
  }
  return { applied: finished.status === 'done', operation: finished };
}

/**
 * Starts one device operation and waits for its end (done, failed or uncertain; null = it had not finished in time, which
 * is not an outcome). The error is the controller's own sentence, whether it refused the request or the operation failed.
 * @param {() => Promise<{ status: number, data: any }>} start
 * @returns {Promise<{ status: 'done' | 'failed' | 'uncertain' | 'pending' | 'refused', result: any | null, error: string | null, id: number | null }>}
 */
export async function runOperation(start) {
  /** @type {{ status: number, data: any }} */
  let answer;
  try {
    answer = await start();
  } catch (err) {
    return { status: 'refused', result: null, error: messageOf(err), id: null };
  }
  const id = answer.data?.operation?.id ?? null;
  if (typeof id !== 'number') return { status: 'refused', result: null, error: t('op.no_operation'), id: null };
  const finished = await live.follow(id);
  if (finished === null) return { status: 'pending', result: null, error: null, id };
  return { status: finished.status, result: finished.result ?? null, error: finished.error ?? null, id };
}
