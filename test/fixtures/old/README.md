# Old-appliance fixtures

Configuration files in the shape an older Asterisk appliance wrote them, used as input by the migration tools
(`tools/sip2pjsip.js`, `tools/import-old-registry.js`) and by the configuration lint and scanner tests.

Identifiers in these files — phone numbers, IMEIs, the Telegram chat id and the bot token — are placeholders, not
values from a real deployment. Everything else is the original structure, including the things the migration report
complains about: SIP peers whose secret is their own extension number, a Telegram bridge built out of `sendEmail`
calls in the dialplan, and DIDs wired straight into `Dial()` lines.

| File | Notes |
|---|---|
| `extensions.conf` | the dialplan, with the `sendEmail` notification lines and the per-modem DID extensions |
| `sip.conf` | 15 chan_sip peers — the input for `sip2pjsip.js` |
| `quectel.conf`, `dongle.conf` | the two driver configurations, one device each |
| `docker-compose.yml` | the old two-container stack |
| `temp/*` | the six files the old web UI wrote to pick a driver per modem and to say whether it was running. They are synthesized, not copied: the directory was written at runtime and never lived in a repository. The files of the *other* driver deliberately say the opposite of the selected one, so a tool that reads the wrong file gets the wrong answer. |

The expected output of both conversion tools is committed under `packages/controller/test/tools/snapshots/` and
compared by `packages/controller/test/tools/*.test.js`.
