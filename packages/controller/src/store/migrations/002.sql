-- Aster — modem_state is not stored any more (it is rebuilt from ShowDevices); only the forwarding
-- verdict, which cannot be re-derived, moves to its own table.
CREATE TABLE modem_forwarding (
  modem_id        TEXT    NOT NULL PRIMARY KEY,
  forwarding_json TEXT    NOT NULL CHECK (json_valid(forwarding_json)),
  observed_at     INTEGER NOT NULL
) STRICT;

INSERT INTO modem_forwarding (modem_id, forwarding_json, observed_at)
  SELECT modem_id, json_extract(detail_json, '$.forwarding'), observed_at
  FROM modem_state
  WHERE detail_json IS NOT NULL AND json_extract(detail_json, '$.forwarding') IS NOT NULL;

DROP TABLE modem_state;
