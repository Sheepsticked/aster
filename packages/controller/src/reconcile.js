// @ts-check
// Aster controller — reconciliation after a registry apply: gracefully removes modems still listed by their driver and waits
// until every changed modem shows its generated desired state and radio setting; a mismatch fails the apply.
// Restarts for changed audio settings are done by config/apply.js.
// Usage: createConfigOps({ paths, hooks: { applied: createReconciler({ log }).afterRegistryApply } })
import { initstateOf, radioOf } from './config/generators.js';
import { showAllDevices, showDevices } from './devices/state.js';

/** @typedef {import('./ops/runner.js').Context} Context */
/** @typedef {import('./ami/client.js').AmiClient} AmiClient */
/** @typedef {import('./log.js').Logger} Logger */
/** @typedef {import('./config/registry.js').Registry} Registry */
/** @typedef {import('./config/registry.js').Modem} Modem */
/**
 * @typedef {object} Timing
 * @property {number} actionTimeoutMs  each AMI request (30 s)
 * @property {number} deviceTimeoutMs  how long a removal or a desired state may take (60 s)
 * @property {number} devicePollMs     ShowDevices poll period (2 s)
 */
/**
 * @typedef {object} ReconcileResult
 * @property {Array<{ id: string, driver: string, action: 'Remove' | null }>} removed  modems no longer in the registry; action when the driver still listed them
 * @property {Record<string, 'start' | 'stop'>} desired  the desired state confirmed per checked modem
 * @property {Record<string, 'on' | 'off'>} radio  the radio setting confirmed per checked modem (`RadioSetting`)
 */

export const DEFAULTS = Object.freeze({ actionTimeoutMs: 30_000, deviceTimeoutMs: 60_000, devicePollMs: 2_000 });

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {'quectel' | 'dongle'} driver */
const prefix = (driver) => (driver === 'quectel' ? 'Quectel' : 'Dongle');

/**
 * The initstate the generators write for a modem (generators.js initstateOf).
 * @param {Modem} modem
 * @returns {'start' | 'stop'}
 */
export const desiredState = (modem) => initstateOf(modem);

/**
 * The radio setting the generators write for a modem (generators.js radioOf).
 * @param {Modem} modem
 * @returns {'on' | 'off'}
 */
export const desiredRadio = (modem) => radioOf(modem);

/**
 * The modems whose driver desired state and radio setting must be checked after `before` became `after`: added ones and those
 * whose enabled, uac or usb_port mapping changed. With no `before` (the first apply) every modem is checked.
 * @param {Registry | null} before
 * @param {Registry} after
 * @returns {Modem[]}
 */
export function modemsToVerify(before, after) {
  if (!before) return [...after.modems];
  return after.modems.filter((modem) => {
    const previous = before.modems.find((entry) => entry.id === modem.id);
    return !previous || previous.driver !== modem.driver || desiredState(previous) !== desiredState(modem)
      || desiredRadio(previous) !== desiredRadio(modem);
  });
}

/**
 * @param {{ log?: Logger, now?: () => number, timing?: Partial<Timing> }} [options]
 */
export function createReconciler({ log = SILENT, now = Date.now, timing = {} } = {}) {
  const t = { ...DEFAULTS, ...timing };

  /**
   * @param {Context} ctx
   * @param {{ ami: AmiClient, before: Registry | null, after: Registry }} change
   * @returns {Promise<ReconcileResult>}
   */
  async function afterRegistryApply(ctx, { ami, before, after }) {
    /** @type {ReconcileResult} */
    const result = { removed: [], desired: {}, radio: {} };
    const removed = before ? before.modems.filter((modem) => !after.modems.some((entry) => entry.id === modem.id)) : [];
    for (const modem of removed) {
      const listed = (await showDevices(ami, modem.driver, { device: modem.id, timeout: t.actionTimeoutMs })).length > 0;
      if (!listed) {
        result.removed.push({ id: modem.id, driver: modem.driver, action: null });
        continue;
      }
      const action = `${prefix(modem.driver)}Remove`;
      ctx.progress(`${action} ${modem.id}`);
      await ami.action(action, { Device: modem.id, When: 'gracefully' }, { timeout: t.actionTimeoutMs });
      result.removed.push({ id: modem.id, driver: modem.driver, action: 'Remove' });
      const deadline = now() + t.deviceTimeoutMs;
      while ((await showDevices(ami, modem.driver, { device: modem.id, timeout: t.actionTimeoutMs })).length > 0) {
        if (now() >= deadline) throw new Error(`chan_${modem.driver} still lists the removed modem ${modem.id} ${Math.round(t.deviceTimeoutMs / 1000)} s after ${action} (a graceful removal waits for calls to end)`);
        await sleep(t.devicePollMs);
      }
      log.info('removed modem gone from the driver', { modem: modem.id, driver: modem.driver });
    }
    const toVerify = modemsToVerify(before, after);
    if (toVerify.length > 0) {
      ctx.progress('verifying desired device states');
      const deadline = now() + t.deviceTimeoutMs;
      for (;;) {
        const { entries, errors } = await showAllDevices(ami, { timeout: t.actionTimeoutMs });
        /** @type {string[]} */
        const mismatches = [];
        for (const modem of toVerify) {
          const expected = desiredState(modem);
          const radio = desiredRadio(modem);
          const entry = entries.get(modem.id);
          if (entry && entry.desired === expected && entry.radio === radio) {
            result.desired[modem.id] = expected;
            result.radio[modem.id] = radio;
          } else if (!entry || entry.desired !== expected) {
            mismatches.push(`${modem.id}: desired ${entry ? entry.desired : errors[modem.driver] ? `unknown (${errors[modem.driver]})` : 'unlisted'}, expected ${expected}`);
          } else {
            mismatches.push(`${modem.id}: radio ${entry.radio ?? 'not reported (Asterisk without the radio patches)'}, expected ${radio}`);
          }
        }
        if (mismatches.length === 0) break;
        if (now() >= deadline) throw new Error(`the drivers do not show the desired state of the registry after ${Math.round(t.deviceTimeoutMs / 1000)} s: ${mismatches.join('; ')}`);
        await sleep(t.devicePollMs);
      }
    }
    return result;
  }

  return { afterRegistryApply };
}
