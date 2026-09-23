-- Aster — migration 001: every table (store/db.js wraps it in a transaction). Times are epoch ms (UTC), flags 0/1;
-- AUTOINCREMENT so a deleted id is never reused.

CREATE TABLE settings (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id           TEXT NOT NULL PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

-- One row per ingested spool line; id is its event_id (<epoch_ns>-<pid>-<uniqueid|->), so a replayed file is a no-op.
CREATE TABLE events (
  id          TEXT NOT NULL PRIMARY KEY,
  kind        TEXT NOT NULL,
  modem_id    TEXT NOT NULL,
  uniqueid    TEXT,
  emitted_at  INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  fields_json TEXT NOT NULL CHECK (json_valid(fields_json))
) STRICT;

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE REFERENCES events (id),
  modem_id    TEXT NOT NULL,
  sender      TEXT,
  text        TEXT NOT NULL,
  scts        TEXT,
  received_at INTEGER NOT NULL
) STRICT;

CREATE INDEX messages_modem_received ON messages (modem_id, received_at);

CREATE TABLE calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL UNIQUE REFERENCES events (id),
  modem_id     TEXT NOT NULL,
  uniqueid     TEXT NOT NULL UNIQUE,
  caller       TEXT,
  did          TEXT,
  dialstatus   TEXT,
  answered_sec INTEGER,
  dialed_sec   INTEGER,
  disposition  TEXT,
  hangupcause  INTEGER,
  outcome      TEXT,
  ended_at     INTEGER NOT NULL
) STRICT;

-- An outbox id travels to the modem inside the SMS report payload (<outbox_id>:<attempt_no>), hence AUTOINCREMENT.
CREATE TABLE sms_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  modem_id   TEXT NOT NULL,
  number     TEXT NOT NULL,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL,
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
) STRICT;

CREATE TABLE sms_attempts (
  outbox_id       INTEGER NOT NULL REFERENCES sms_outbox (id) ON DELETE CASCADE,
  attempt_no      INTEGER NOT NULL CHECK (attempt_no >= 1),
  submitted_at    INTEGER,
  ami_result      TEXT,
  report0_at      INTEGER,
  report0_success INTEGER CHECK (report0_success IN (0, 1)),
  report1_at      INTEGER,
  report1_success INTEGER CHECK (report1_success IN (0, 1)),
  report2_at      INTEGER,
  report_raw      TEXT,
  status          TEXT NOT NULL,
  PRIMARY KEY (outbox_id, attempt_no)
) STRICT;

CREATE TABLE notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('sms', 'call', 'alert', 'test')),
  source_id     INTEGER,
  chat_id       TEXT NOT NULL,
  part_no       INTEGER NOT NULL CHECK (part_no >= 1),
  part_count    INTEGER NOT NULL,
  text          TEXT NOT NULL,
  status        TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at       INTEGER,
  tg_message_id INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER,
  CHECK (part_count >= part_no)
) STRICT;

CREATE INDEX notifications_status_next ON notifications (status, next_at);
CREATE INDEX notifications_created ON notifications (created_at);

CREATE TABLE operations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  modem_id    TEXT,
  status      TEXT NOT NULL,
  params_json TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error       TEXT,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
) STRICT;

CREATE INDEX operations_created ON operations (created_at);

CREATE TABLE devices_seen (
  usb_port   TEXT NOT NULL PRIMARY KEY,
  vendor     TEXT,
  product    TEXT,
  imei       TEXT,
  imsi       TEXT,
  data_tty   TEXT,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  present    INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0, 1))
) STRICT;

CREATE TABLE modem_state (
  modem_id     TEXT NOT NULL PRIMARY KEY,
  state        TEXT NOT NULL,
  driver_state TEXT,
  gsm_reg      TEXT,
  rssi         INTEGER,
  provider     TEXT,
  number       TEXT,
  data_tty     TEXT,
  usb_port     TEXT,
  observed_at  INTEGER NOT NULL,
  detail_json  TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;
