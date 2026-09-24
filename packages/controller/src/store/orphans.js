// @ts-check
// Deletes the spool events of deleted SMS and calls: those events still hold the SMS text or the caller.

/** Every sms event has a messages row until that row is deleted. */
export const ORPHAN_SMS_EVENTS = "DELETE FROM events WHERE kind = 'sms' AND id NOT IN (SELECT event_id FROM messages)";
/** Every call-end event's uniqueid has a calls row until that row is deleted (a repeated call-end adds none). */
export const ORPHAN_CALL_EVENTS = "DELETE FROM events WHERE kind = 'call-end' AND uniqueid NOT IN (SELECT uniqueid FROM calls)";
