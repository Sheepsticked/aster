// @ts-check
// SMS reports: a report names its outbox attempt through the `<outbox_id>:<attempt_no>` Payload and arrives both as an
// AMI event and as a spooled event; applying it is idempotent per type, and a late report never regresses the outbox row.

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('node:sqlite').SQLOutputValue} SQLOutputValue */
/** @typedef {import('../ami/client.js').AmiClient} AmiClient */
/** @typedef {import('../ami/parser.js').Packet} Packet */
/** @typedef {import('../log.js').Logger} Logger */
/**
 * @typedef {object} Report  an SMS report: the spooled sms-report event (spool/ingest.js) or the driver's …Report AMI event
 * @property {string} payload        SMS_REPORT_PAYLOAD / `Payload`: `<outbox_id>:<attempt_no>` for the controller's own SMS
 * @property {0 | 1 | 2} type        0 submit result (spool `i`), 1 status report (`e`), 2 no report within the validity (`t`)
 * @property {0 | 1} success
 * @property {string | null} scts    the service centre time stamp of a status report
 * @property {string | null} dt      the discharge time of a status report
 * @property {string | null} raw     SMS_REPORT / `Report`: the status of each part, `NNN,` per part (type 1)
 * @property {'spool' | 'ami'} source
 * @property {string} modemId        the device that reported (for type 2 whichever device polled the expiry)
 * @property {number} at             epoch ms: when aster-emit wrote the report, or when the AMI event arrived
 */
/** @typedef {'submitting' | 'submitted' | 'accepted' | 'rejected' | 'delivered' | 'undelivered' | 'undelivered_expired' | 'failed' | 'uncertain'} AttemptStatus */
/**
 * @typedef {object} Attempt  an sms_attempts row
 * @property {number} outbox_id
 * @property {number} attempt_no
 * @property {number | null} submitted_at
 * @property {string | null} ami_result
 * @property {number | null} report0_at
 * @property {0 | 1 | null} report0_success
 * @property {number | null} report1_at
 * @property {0 | 1 | null} report1_success
 * @property {number | null} report2_at
 * @property {string | null} report_raw
 * @property {AttemptStatus} status
 */
/**
 * @typedef {object} Applied
 * @property {'applied' | 'duplicate' | 'foreign' | 'unknown'} outcome  applied: the report was stored; duplicate: the attempt already
 *   had a report of this type; foreign: the payload is not `<outbox_id>:<attempt_no>`; unknown: no such attempt is stored
 * @property {number | null} outboxId
 * @property {number | null} attemptNo
 * @property {0 | 1 | 2} type
 * @property {AttemptStatus | null} attempt  the attempt's status afterwards
 * @property {string | null} outbox          the outbox row's status afterwards
 * @property {boolean} current               the report belongs to the outbox row's current attempt
 */

/** SMS report payload of an outbox attempt. */
export const PAYLOAD = /^([1-9][0-9]{0,14}):([1-9][0-9]{0,14})$/;
export const ATTEMPT_STATUSES = Object.freeze(/** @type {const} */ (['submitting', 'submitted', 'accepted', 'rejected', 'delivered', 'undelivered', 'undelivered_expired', 'failed', 'uncertain']));
/** The AMI event names of the two drivers' reports. */
export const REPORT_EVENTS = Object.freeze({ QuectelReport: 'quectel', DongleReport: 'dongle' });

/** @type {Logger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };
/** One statement per report type; `reportN_at IS NULL` makes the first report of a type win. */
const RECORD = Object.freeze({
  0: 'UPDATE sms_attempts SET report0_at = ?, report0_success = ? WHERE outbox_id = ? AND attempt_no = ? AND report0_at IS NULL',
  1: `UPDATE sms_attempts SET report1_at = ?, report1_success = ?, report_raw = COALESCE(?, report_raw)
    WHERE outbox_id = ? AND attempt_no = ? AND report1_at IS NULL`,
  2: 'UPDATE sms_attempts SET report2_at = ? WHERE outbox_id = ? AND attempt_no = ? AND report2_at IS NULL',
});
const SELECT_ATTEMPT = 'SELECT * FROM sms_attempts WHERE outbox_id = ? AND attempt_no = ?';
const SELECT_OUTBOX = 'SELECT status, attempt_no FROM sms_outbox WHERE id = ?';
const SET_ATTEMPT_STATUS = 'UPDATE sms_attempts SET status = ? WHERE outbox_id = ? AND attempt_no = ?';
const SET_OUTBOX_STATUS = 'UPDATE sms_outbox SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND attempt_no = ?';

/**
 * `<outbox_id>:<attempt_no>` → its numbers; null for any other payload.
 * @param {string} payload
 * @returns {{ outboxId: number, attemptNo: number } | null}
 */
export function parsePayload(payload) {
  const match = PAYLOAD.exec(payload);
  return match ? { outboxId: Number(match[1]), attemptNo: Number(match[2]) } : null;
}

/**
 * The status an attempt's report columns give it: the status report decides, else the expiry, else the submit result, else the
 * status the send left (submitting, submitted, failed or uncertain).
 * @param {Pick<Attempt, 'report0_at' | 'report0_success' | 'report1_at' | 'report1_success' | 'report2_at' | 'status'>} attempt
 * @returns {AttemptStatus}
 */
export function attemptStatus(attempt) {
  if (attempt.report1_at !== null) return attempt.report1_success === 1 ? 'delivered' : 'undelivered';
  if (attempt.report2_at !== null) return 'undelivered_expired';
  if (attempt.report0_at !== null) return attempt.report0_success === 1 ? 'accepted' : 'rejected';
  return attempt.status;
}

/**
 * The text sms_outbox.last_error carries for a status a report produced; null for the successful ones.
 * @param {AttemptStatus} status
 * @param {string | null} raw  the status report's part statuses
 * @returns {string | null}
 */
export function failureText(status, raw) {
  switch (status) {
    case 'rejected':
      return 'the modem or the network rejected the submission (send error)';
    case 'undelivered':
      return `not delivered (status report ${raw ?? '?'})`;
    case 'undelivered_expired':
      return 'no delivery report within the validity period';
    default:
      return null;
  }
}

/** @param {DatabaseSync} db */
function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite has already rolled the transaction back; the original error is rethrown.
  }
}

/**
 * Applies one report; the first report of each type wins. Runs inside the caller's transaction when one is open (the spool
 * ingester), in its own otherwise (the AMI listener). Throws only on a database error.
 * @param {DatabaseSync} db
 * @param {Report} report
 * @param {{ now?: () => number, log?: Logger }} [options]
 * @returns {Applied}
 */
export function applyReport(db, report, { now = Date.now, log = SILENT } = {}) {
  const { type } = report;
  if (type !== 0 && type !== 1 && type !== 2) throw new TypeError(`an SMS report type is 0, 1 or 2, not ${JSON.stringify(type)}`);
  const key = parsePayload(report.payload);
  if (!key) {
    log.info('SMS report for a payload that is not an outbox attempt; ignored', { source: report.source, modem: report.modemId, type });
    return { outcome: 'foreign', outboxId: null, attemptNo: null, type, attempt: null, outbox: null, current: false };
  }
  const { outboxId, attemptNo } = key;
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN IMMEDIATE');
  try {
    /** @type {Applied} */
    let result;
    const before = /** @type {Attempt | undefined} */ (db.prepare(SELECT_ATTEMPT).get(outboxId, attemptNo));
    if (!before) {
      log.warn('SMS report for an attempt that is not stored; ignored', { source: report.source, modem: report.modemId, outbox: outboxId, attempt: attemptNo, type });
      result = { outcome: 'unknown', outboxId, attemptNo, type, attempt: null, outbox: null, current: false };
    } else {
      const statement = db.prepare(RECORD[type]);
      const { changes } = type === 0 ? statement.run(report.at, report.success, outboxId, attemptNo)
        : type === 1 ? statement.run(report.at, report.success, report.raw, outboxId, attemptNo)
          : statement.run(report.at, outboxId, attemptNo);
      const outbox = /** @type {{ status: string, attempt_no: number } | undefined} */ (db.prepare(SELECT_OUTBOX).get(outboxId));
      const current = outbox !== undefined && outbox.attempt_no === attemptNo;
      if (Number(changes) !== 1) {
        result = { outcome: 'duplicate', outboxId, attemptNo, type, attempt: before.status, outbox: outbox?.status ?? null, current };
      } else {
        const after = /** @type {Attempt} */ (db.prepare(SELECT_ATTEMPT).get(outboxId, attemptNo));
        const status = attemptStatus(after);
        if (status !== before.status) db.prepare(SET_ATTEMPT_STATUS).run(status, outboxId, attemptNo);
        if (current && status !== outbox.status) db.prepare(SET_OUTBOX_STATUS).run(status, failureText(status, after.report_raw), now(), outboxId, attemptNo);
        result = { outcome: 'applied', outboxId, attemptNo, type, attempt: status, outbox: current ? status : outbox?.status ?? null, current };
      }
    }
    if (own) db.exec('COMMIT');
    if (result.outcome === 'applied') {
      log.info('SMS report applied', { source: report.source, modem: report.modemId, outbox: outboxId, attempt: attemptNo, type, success: report.success, status: result.attempt, current: result.current });
    } else if (result.outcome === 'duplicate') {
      log.debug('SMS report already recorded', { source: report.source, outbox: outboxId, attempt: attemptNo, type });
    }
    return result;
  } catch (err) {
    if (own) rollback(db);
    throw err;
  }
}

/**
 * @param {Packet} packet
 * @param {string} name
 * @returns {string}
 */
function header(packet, name) {
  const value = packet.get(name);
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * A `…Report` AMI packet as a Report; null when it is not one (no Payload, a Type other than 0/1/2, a Success other than 0/1).
 * @param {Packet} packet
 * @param {number} at  epoch ms
 * @returns {Report | null}
 */
export function packetReport(packet, at) {
  const event = header(packet, 'Event');
  if (!Object.hasOwn(REPORT_EVENTS, event)) return null;
  const type = header(packet, 'Type');
  const success = header(packet, 'Success');
  const payload = header(packet, 'Payload');
  if (payload === '' || !/^[012]$/.test(type) || !/^[01]$/.test(success)) return null;
  /** @param {string} value */
  const optional = (value) => (value === '' ? null : value);
  return {
    payload,
    type: /** @type {0 | 1 | 2} */ (Number(type)),
    success: success === '1' ? 1 : 0,
    scts: optional(header(packet, 'SCTS')),
    dt: optional(header(packet, 'DT')),
    raw: optional(header(packet, 'Report')),
    source: 'ami',
    modemId: header(packet, 'Device'),
    at,
  };
}

/**
 * Applies every `QuectelReport` / `DongleReport` event of the AMI client (the spooled copy of the same report is a duplicate, and
 * vice versa). A malformed event is logged and dropped; a database error is logged (the spooled copy applies the report later).
 * @param {{ ami: AmiClient, db: DatabaseSync, log?: Logger, now?: () => number }} options
 * @returns {{ stop: () => void }}
 */
export function createReportListener({ ami, db, log = SILENT, now = Date.now }) {
  /** @param {Packet} packet */
  const onReport = (packet) => {
    const report = packetReport(packet, now());
    if (!report) {
      log.warn('driver Report event without a usable Payload, Type or Success; ignored', { event: header(packet, 'Event'), device: header(packet, 'Device') });
      return;
    }
    try {
      applyReport(db, report, { now, log });
    } catch (err) {
      log.error('SMS report from AMI could not be stored; the spooled copy is applied by the ingester', { modem: report.modemId, payload: report.payload, type: report.type, err });
    }
  };
  for (const event of Object.keys(REPORT_EVENTS)) ami.on(`event:${event}`, onReport);
  return {
    stop() {
      for (const event of Object.keys(REPORT_EVENTS)) ami.off(`event:${event}`, onReport);
    },
  };
}
