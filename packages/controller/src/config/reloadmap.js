// @ts-check
// Reload map: the AMI actions that make Asterisk re-read a file under config/asterisk after Apply wrote it.
// A file whose module cannot reload (ccss, stasis) or that is not listed needs a graceful restart.

/**
 * An AMI action as the AMI client sends it: `action` is the Action header, the other keys are headers.
 * @typedef {Readonly<{ action: 'Command', Command: string }> | Readonly<{ action: 'QuectelReload' | 'DongleReload', When: 'gracefully' }>} ReloadAction
 */

/** @param {string} line @returns {ReloadAction} */
const command = (line) => Object.freeze({ action: 'Command', Command: line });

/** Waits until no call is up, then restarts Asterisk: the only way to apply asterisk.conf and modules.conf. */
export const RESTART = command('core restart gracefully');

const DIALPLAN = command('dialplan reload');
// `pjsip reload` does not exist in Asterisk 20 ("No such command"); res_pjsip's module reload re-reads pjsip.conf (sorcery).
const PJSIP = command('module reload res_pjsip.so');
const QUECTEL = Object.freeze({ action: 'QuectelReload', When: 'gracefully' });
const DONGLE = Object.freeze({ action: 'DongleReload', When: 'gracefully' });

/**
 * The driver's reload action; `gracefully` applies device changes once the device has no call.
 * @param {'quectel' | 'dongle'} driver
 * @returns {ReloadAction}
 */
export function driverReload(driver) {
  return driver === 'quectel' ? QUECTEL : DONGLE;
}

/**
 * File (relative to config/asterisk) → actions after it changed. null: never applied by the controller (install.sh
 * writes manager.conf from secrets.env).
 * @type {Readonly<Record<string, readonly ReloadAction[] | null>>}
 */
export const RELOAD = Object.freeze({
  'asterisk.conf': Object.freeze([RESTART]),
  'modules.conf': Object.freeze([RESTART]),
  'extensions.conf': Object.freeze([DIALPLAN]),
  'aster.d/globals.conf': Object.freeze([DIALPLAN]),
  'aster.d/modems.conf': Object.freeze([DIALPLAN]),
  'pjsip.conf': Object.freeze([PJSIP]),
  'aster.d/phones.conf': Object.freeze([PJSIP]),
  'quectel.conf': Object.freeze([QUECTEL]),
  'aster.d/quectel-devices.conf': Object.freeze([QUECTEL]),
  'dongle.conf': Object.freeze([DONGLE]),
  'aster.d/dongle-devices.conf': Object.freeze([DONGLE]),
  'musiconhold.conf': Object.freeze([command('moh reload')]),
  'rtp.conf': Object.freeze([command('module reload res_rtp_asterisk.so')]),
  'logger.conf': Object.freeze([command('logger reload')]),
  'cdr.conf': Object.freeze([command('module reload cdr')]),
  'cel.conf': Object.freeze([command('module reload cel')]),
  'features.conf': Object.freeze([command('module reload features')]),
  'indications.conf': Object.freeze([command('module reload indications')]),
  'acl.conf': Object.freeze([command('module reload acl')]),
  'udptl.conf': Object.freeze([command('module reload udptl')]),
  'pjproject.conf': Object.freeze([command('module reload res_pjproject.so')]),
  'ccss.conf': Object.freeze([RESTART]),
  'stasis.conf': Object.freeze([RESTART]),
  'sorcery.conf': Object.freeze([RESTART]),
  'manager.conf': null,
});

/**
 * A short, stable name of an action: `Command: dialplan reload`, `QuectelReload` (operation results and logs use it).
 * @param {ReloadAction} action
 */
export const actionKey = (action) => ('Command' in action ? `Command: ${action.Command}` : action.action);

/** Order of a batch: contexts before the endpoints and devices that name them, drivers last among the reloads. */
const ORDER = [DIALPLAN, PJSIP, QUECTEL, DONGLE].map(actionKey);

/**
 * Actions for one file; a name the map does not list gets a restart (a module may read it only at startup).
 * @param {string} file name relative to config/asterisk, e.g. `pjsip.conf` or `aster.d/phones.conf`
 * @returns {readonly ReloadAction[]}
 */
export function reloadFor(file) {
  if (!Object.hasOwn(RELOAD, file)) return [RESTART];
  const actions = RELOAD[file];
  if (actions === null || actions === undefined) throw new Error(`${file} is written by install.sh only; the controller never applies it`);
  return actions;
}

/**
 * The actions to run after `files` changed: each at most once, dialplan → res_pjsip → quectel → dongle → the rest in
 * map order; when any file needs a restart, the restart is the only action.
 * @param {Iterable<string>} files
 * @returns {ReloadAction[]}
 */
export function reloadActions(files) {
  /** @type {Map<string, ReloadAction>} */
  const byKey = new Map();
  for (const file of files) {
    for (const action of reloadFor(file)) byKey.set(actionKey(action), action);
  }
  if (byKey.has(actionKey(RESTART))) return [RESTART];
  const rank = (/** @type {string} */ key) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
  return [...byKey.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([, action]) => action);
}
