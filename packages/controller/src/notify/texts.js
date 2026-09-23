// @ts-check
// Notification texts, plain and as received; each starts with `[<host>] ` so messages from several Asters in one chat
// say which one sent them. Times use the registry's display time zone (UTC when Intl does not know it).

/**
 * The time of `ms` in `timeZone` as `YYYY-MM-DD HH:MM:SS ±HH:MM`; UTC when the zone is not a time zone Intl knows.
 * @param {number} ms  epoch milliseconds
 * @param {string} [timeZone]  IANA name (registry settings.timezone)
 * @returns {string}
 */
export function formatTime(ms, timeZone = 'UTC') {
  /** @type {Intl.DateTimeFormat} */
  let format;
  try {
    format = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
  } catch (err) {
    if (timeZone !== 'UTC' && err instanceof RangeError) return formatTime(ms, 'UTC');
    throw err;
  }
  /** @type {Record<string, string>} */
  const part = {};
  for (const { type, value } of format.formatToParts(ms)) part[type] = value;
  const offset = /^GMT([+-][0-9]{2}:[0-9]{2})$/.exec(part.timeZoneName ?? '')?.[1] ?? '+00:00';
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second} ${offset}`;
}

/** @param {string} value */
const orUnknown = (value) => (value === '' ? 'unknown' : value);

/**
 * @param {string} host
 * @param {string} text
 */
const fromHost = (host, text) => (host === '' ? text : `[${host}] ${text}`);

/**
 * @param {{ host: string, modem: string, sender: string, scts: string, text: string }} sms
 * @returns {string}
 */
export const smsText = ({ host, modem, sender, scts, text }) =>
  fromHost(host, `SMS ${modem} from ${orUnknown(sender)}${scts === '' ? '' : ` [${scts}]`}\n${text}`);

/**
 * @param {{ host: string, modem: string, caller: string, at: number, timeZone: string, reason: string }} call
 * @returns {string}
 */
export const missedCallText = ({ host, modem, caller, at, timeZone, reason }) =>
  fromHost(host, `Missed call ${modem} from ${orUnknown(caller)} [${formatTime(at, timeZone)}] (${reason})`);

/**
 * @param {{ host: string, at: number, timeZone: string }} probe
 * @returns {string}
 */
export const testText = ({ host, at, timeZone }) => fromHost(host, `Aster test notification [${formatTime(at, timeZone)}]`);

/** How an alert names the modem states that raise it (alerts.js ALERT_STATES). */
const MODEM_PROBLEM = Object.freeze(/** @type {Readonly<Record<string, string>>} */ ({ absent: 'is absent', 'no-network': 'has no GSM network' }));

/**
 * @param {{ host: string, modem: string, state: string, since: number, timeZone: string }} alert
 * @returns {string}
 */
export const modemAlertText = ({ host, modem, state, since, timeZone }) =>
  fromHost(host, `Alert: modem ${modem} ${MODEM_PROBLEM[state] ?? `is ${state}`} since ${formatTime(since, timeZone)}`);

/** The same states in a recovery text. */
const MODEM_PROBLEM_PAST = Object.freeze(/** @type {Readonly<Record<string, string>>} */ ({ absent: 'absent', 'no-network': 'without GSM network' }));

/**
 * @param {{ host: string, modem: string, state: string, alertState: string, since: number, timeZone: string }} recovery
 * @returns {string}
 */
export const modemRecoveredText = ({ host, modem, state, alertState, since, timeZone }) =>
  fromHost(host, `Recovered: modem ${modem} is ${state} (${MODEM_PROBLEM_PAST[alertState] ?? alertState} since ${formatTime(since, timeZone)})`);

/**
 * @param {{ host: string, since: number, timeZone: string }} alert
 * @returns {string}
 */
export const amiAlertText = ({ host, since, timeZone }) => fromHost(host, `Alert: Asterisk is unreachable (no AMI connection) since ${formatTime(since, timeZone)}`);

/**
 * @param {{ host: string, since: number, timeZone: string }} recovery
 * @returns {string}
 */
export const amiRecoveredText = ({ host, since, timeZone }) =>
  fromHost(host, `Recovered: Asterisk is reachable again (unreachable since ${formatTime(since, timeZone)})`);
