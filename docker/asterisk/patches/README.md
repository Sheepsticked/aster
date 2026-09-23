# AtCommand driver patches — protocol specification

One AtCommand patch per driver (`0001-chan-dongle-at-command-events.patch`,
`0001-chan-quectel-at-command-events.patch`), identical in structure, applied by the Dockerfile in the drivers stage
with `git apply` (`build-driver.sh`). `build-driver.sh` applies every `*-chan-<driver>-*.patch` it finds, in name
order, so each driver also carries the later patches listed under "Status" below: discovery fixes, the radio setting,
USB-sound-card audio, the Quectel receive gain, the sound-card recovery and the Quectel SMS delivery reports. None of
them changes the AtCommand contract.

Each patch is a `git format-patch` export whose commit message names the upstream commit it applies to (`Upstream:`)
and what it is for (`Purpose:`). This file is the protocol contract the controller's `at` module is written against.

## Action

```
Action: <Driver>AtCommand          Driver ∈ {Dongle, Quectel}
ActionID: <id>                     1–63 chars [A-Za-z0-9._-]; required
Device: <name>                     must exist, be connected and initialized
Command: <AT line>                 1–256 chars, no CR/LF; sent verbatim + CR
Timeout: <seconds>                 1–60, default 15
```

Reply: `Response: Success` (queued at head of the device queue) or `Response: Error` with
`Message:` one of `Device not found`, `Device not connected`, `Device not initialized`,
`Invalid Command`, `Invalid ActionID`, `Invalid Timeout`, `Queue error`.

Validation order: `ActionID`, `Command` and `Timeout` are checked first, then the device is
looked up (a missing `Device:` header is `Device not found`), then `connected`, then `initialized`;
a stopped device therefore still reports a malformed request. `Timeout` is one or two decimal digits,
no sign, no spaces. "At head" means inserted right after the command currently in flight, ahead of
every other pending command — the position the CLI `<driver> cmd` uses. `Response: Error` means the
command was not queued and no event will ever carry that ActionID. The `Success` message text is
`[<device>] AT command queued`.

## Events (all `EVENT_FLAG_SYSTEM`; values CR/LF-escaped like `manager_event_message`)

```
Event: <Driver>AtResponse           one per non-terminal response line
ActionID: <id>
Device: <name>
Line: <text>

Event: <Driver>AtDone               exactly once per accepted action
ActionID: <id>
Device: <name>
Result: OK | ERROR | TIMEOUT
Error: <text>                      present when Result != OK (the ERROR/+CMS/+CME line, "queue flushed", or "timeout")
```

`Error:` texts: for `Result: ERROR` the terminal line itself (`ERROR`, `COMMAND NOT SUPPORT`,
`+CMS ERROR: <n>`, `+CME ERROR: <n>`), `queue flushed` (guarantee 3) or `task removed` (the task
left the queue for another reason: an unexpected result such as the multi-line `+CMGR:` answer to
`AT+CMGR`, which the driver consumes itself, or a write error); for `Result: TIMEOUT` the text
`timeout`. `Line:` never carries results the modem sends on its own (`^RSSI`, `^MODE`, `^BOOT`,
`^SRVST`, `+CSSI`, `+CSSU`, `RING`, `^CEND`, `^CONN`, `^ORIG`, `^CONF`, `+CMTI`, `+CDSI`,
`^SMMEMFULL`); the driver processes them as usual while a command is in flight. The terminal
`OK`/`ERROR` line is not an `AtResponse`. Events are written after the action's `Response:` line in
practice (the response is sent by the action handler before the device can answer), but the client
keys on `ActionID`, never on order.

chan_quectel excludes the same result types from `Line:`; in that fork three of them carry other
texts (`^DSCI:` for `^ORIG`, `VOICE CALL:` for `^CEND`, `MISSED_CALL:` for `^CONF`) and its own
`REMOTE CALL END` report is excluded as well. Everything else the modem answers, including results
the fork does not classify (`+QIND:`, `+CCFC:`, …), is a `Line:` of the command in flight.

## Guarantees

1. Every accepted action produces exactly one `AtDone` with the same `ActionID`, after zero or more `AtResponse`.
2. Lines are attributed by the driver's queue task, never by timing: a response arriving after `AtDone` for that id is never emitted with that id.
3. `at_queue_flush()` (device disconnect/reset/restart) emits `AtDone Result=ERROR Error=queue flushed` for pending tagged tasks.
4. A response timeout emits `AtDone Result=TIMEOUT` **before** the driver's existing timeout handling (which restarts the modem — unchanged, documented in the UI).
5. Untagged user commands (CLI `<driver> cmd`) behave as before and emit nothing.

How 1 and 2 hold in chan_dongle: the ActionID lives in the queue task
(`at_queue_task_t.actionid`), is set only after the command was written to the device
(`at_queue_insert_actionid()`), is consumed by `at_queue_actionid_done()` (emit once, then clear)
and is checked one last time when a task is freed (`at_queue_remove()`: a still-tagged task emits
`Error: task removed`). All of it runs under the device lock (`pvt->lock`) like the rest of the queue,
so the manager thread and the monitor thread never interleave inside one step.

The same holds in chan_quectel: `at_queue.c`/`at_queue.h` are byte-identical in the two forks apart
from the include name, and the touched parts of `at_command.c`, `at_response.c`, `do_monitor_phone()` and
`manager.c` have the same shape, so the quectel patch is the dongle patch with the names changed plus the
`REMOTE CALL END` exclusion.

## Files touched (per driver)

| File | Change |
|---|---|
| `at_queue.h/.c` | `at_queue_task_t.actionid[64]`; `at_queue_insert_actionid()`; `at_queue_actionid_done()`; flush emits `AtDone` for tagged tasks; `at_queue_remove()` emits `task removed` for a task that is still tagged |
| `at_command.c/.h` | `at_enqueue_user_cmd_id(cpvt, input, actionid, timeout_s)` |
| `at_response.h` | `+CME ERROR:` added to the response table so that it is handled like `+CMS ERROR:` for every command (upstream ignored it until the command timed out and the modem was restarted) |
| `at_response.c` | tagged `CMD_USER`: `AtResponse` per line; OK → `AtDone OK`; ERROR/+CMS/+CME → `AtDone ERROR` (logged at debug level; the untagged CLI path keeps its ERROR log line); chan_quectel also treats `REMOTE CALL END` as unsolicited |
| `chan_<driver>.c` `do_monitor()` | timeout branch: tagged `CMD_USER` → `AtDone TIMEOUT` |
| `manager.c` | action registration + validation; `manager_event_at_response()`, `manager_event_at_done()`; `manager show command <Driver>AtCommand` documents ActionID/Device/Command/Timeout, the events and the error messages |

## Controller-side rules (for reference)

One in-flight transaction per modem; `ActionID = at-<op_id>`; deadline `Timeout + 5 s`;
`Status: Disconnect` fails the in-flight transaction as `disconnected`; events with an unknown
`ActionID` are logged at debug and ignored.

## Radio patches

`0002-chan-dongle-radio.patch` and `0004-chan-quectel-radio.patch`, the same change in both drivers, so that a modem
Aster disables leaves the mobile network and stays off it. Without them a disabled modem was a stopped device: the driver closed
its port, and the modem, still powered, stayed registered and kept taking the calls of its number.

```
radio = keep | on | off        default keep; read like every shared setting (Aster writes it in each device section)
```

- `keep`: no `AT+CFUN` at all (upstream behaviour).
- `on`: right after `ATE0` the initialization sends `AT+CFUN?` and `AT+CFUN=1`, then continues as upstream.
- `off`: right after `ATE0` it sends `AT+CFUN?` and `AT+CFUN=0`, then only `AT+CGMI`, `AT+CGMM`, `AT+CGMR`, `AT+CMEE=0` and
  `AT+CGSN`, and stops there. The device stays connected (the monitor keeps pinging it) and is never initialized: no SIM
  command, no SMS poll; calls, `…SendSMS`, `…SendUSSD` and `…AtCommand` (`Device not initialized`) are refused as for any
  device that did not initialize. `State: Radio off`. A disconnect of such a device logs no "Error initializing".
- chan_quectel only: a radio-off device does not open its UAC sound card, so a missing card cannot keep a disabled modem's
  radio on; the audio tty of a non-UAC device is still opened, because the monitor checks it. `disconnect_quectel()` closes
  what the connect opened, not what the settings say by then, and clears the card handles.
- The switch is made at every connect — a start, a restart, a reload that restarts the device, and the reconnect after the
  modem re-enumerated (a reset, a power cut) — because the modems do not store `AT+CFUN`. From
  the modem's power-up to the driver's next connect (up to the discovery `interval`) the modem may register on its own.
- A radio-off device whose fixed data tty does not exist (a disabled modem configured with `ports:` that is not plugged in)
  waits without a log line — no `Trying to connect`, no `unable to open` every discovery interval — so an idle appliance
  writes nothing for it. A device found by IMEI is quiet already (its discovery fails at debug level).
- `0`, not `4`: 27.007 makes only `0` and `1` mandatory, and Huawei firmware treats `4` as an offline mode that refuses
  `AT+CFUN=1` and `AT+CFUN=0` until a reset. `+CFUN: 4` counts as off for `radio = off` ("Radio already off"); for
  `radio = on` the driver logs a WARNING, writes `AT+CFUN=1,1` and reconnects — once, until `AT+CFUN=1` has succeeded again,
  so a modem that keeps coming back offline is not reset in a loop.
- A change of `radio` restarts the device on reload, like `resetdongle`/`resetquectel` (`When=gracefully` waits for its calls).
- `+CFUN:` is a classified response (`RES_CFUN`, remembered per connection) but not an unsolicited one, so `…AtCommand` of
  `AT+CFUN?` still reports `+CFUN: <n>` as a `Line:`.
- `<driver> show device settings` prints `Radio`; `…DeviceEntry` carries `RadioSetting: keep|on|off`, which the controller's
  reconcile requires after a registry change (a driver without these patches reports none, and the apply fails naming it).

## Status

Every patch below is applied in the image.

| Patch | Upstream | What it does |
|---|---|---|
| `0001-chan-dongle-at-command-events.patch` | wdoekes/asterisk-chan-dongle @ `31eb619` | The AtCommand action and its events, as specified above. `smoke-test.sh` checks the documentation and the error replies of 15 requests against a stopped device; a real AT exchange needs hardware. |
| `0001-chan-quectel-at-command-events.patch` | IchthysMaranatha/asterisk-chan-quectel @ `3d45c7f` | The same protocol for chan_quectel. |
| `0002-chan-quectel-pdiscovery-bounds.patch` | @ `3d45c7f` | Fixes a crash in port discovery: `pdiscovery_handle_ati()`/`pdiscovery_handle_cimi()` read a port's answer with an unbounded `sscanf("… %s …")` into a 15-byte stack buffer, so a token longer than 14 characters — a Huawei `^BOOT:…` line landing in the probe read — smashed the stack of a module built without a stack protector. The conversion is now bound to `IMEI_SIZE`/`IMSI_SIZE` digits (`%15[0-9]`). |
| `0003-chan-quectel-pdiscovery-echo.patch` | @ `3d45c7f`, after 0002 | With AT echo on (V.250's default) the modem answers discovery's `AT+GSN; +CIMI` with the command echoed first, which 0002's patterns rejected, leaving `imei=` empty. Both handlers are replaced by one parser that takes the digit-only lines of the answer in the order the command asked for them and skips the rest. |
| `0002-chan-dongle-radio.patch` | wdoekes/asterisk-chan-dongle @ `31eb619`, after 0001 | The `radio` device setting ("Radio patches" above): a disabled modem stays connected with its radio off. |
| `0004-chan-quectel-radio.patch` | @ `3d45c7f`, after 0003 | The same setting for chan_quectel. |
| `0005-chan-quectel-uac-audio.patch` | @ `3d45c7f`, after 0004 | The UAC audio path. Upstream's `channel_read()`/`channel_write()` came from chan_alsa with function-static buffers that every `quec_uac = 1` device in the process shared, so two calls at once overwrote each other's audio; the state now lives in `struct pvt`. `rxgain`/`txgain` work on the UAC path, and capture overruns and playback underruns are counted per call and logged once when the call's audio ends. |
| `0006-chan-quectel-qrxgain.patch` | @ `3d45c7f`, after 0005 | New shared setting `qrxgain`, sent as `AT+QRXGAIN=<n>` at every connect because the modem forgets it on reset. The modem's default of 20577 clips a caller of normal loudness; the starter configuration sets 8192. |
| `0007-chan-quectel-alsa-recovery.patch` | @ `3d45c7f`, after 0006 | The sound card's setup is checked: a stream whose `snd_pcm_hw_params()`/`snd_pcm_sw_params()` failed (seen as `Couldn't set the new hw params: Broken pipe` on an EC25's first open after the kernel's USB audio module loaded) fails the connect, which the monitor retries at the next discovery round, instead of staying in SETUP where every write answers -77 and every call ends at answer. A playback stream that never runs — 25 writes in a row ending in XRUN, the kernel's `snd_usb_audio` in its low-latency mode on Linux 6.18, not one packet reaching the modem — is logged as a WARNING and the card is closed and reopened once per call; the per-call line gains `N sound card reopens`. The host-side cure is the module option `lowlatency=0`, which install.sh writes. |
| `0008-chan-quectel-sms-report-cds.patch` | @ `3d45c7f`, after 0007 | Upstream pull request [#75](https://github.com/IchthysMaranatha/asterisk-chan-quectel/pull/75) by vskiwi (head `e810ed6`), whole. An EC25 keeps an SMS status report in its separate `"SR"` storage while upstream reads it with `AT+CMGR` from `"SM"`, so every delivery report was lost and each sent SMS ended with the driver's own expiry (type 2). The initialization now sends `AT+CNMI=2,1,0,1,0`: the modem passes each report at once as `+CDS: <length>` plus the PDU, which goes through the same smsdb matching, `report` extension and `QuectelReport` event as before. New shared setting `smsreport = cds | cdsi` (default `cds`); a modem that refuses `<ds>=1` falls back to the old `+CDSI` path with a warning. Aster adds `+CDS` to 0001's unsolicited results, so a report arriving during an AtCommand is not returned as its output. |
| `0009-chan-quectel-user-command-deadline.patch` | @ `3d45c7f`, after 0008 | An AtCommand is written by the AMI thread while the monitor thread already sits in its 10 s idle wait, so the command timed out when that wait ended (after 0–10 s) and the modem was restarted, whatever `Timeout` it had. A written head command whose own deadline is still ahead is now waited for. |
| `0010-chan-dongle-user-command-deadline.patch` | wdoekes/asterisk-chan-dongle @ `31eb619`, after 0002 | The same fix for chan_dongle. |

Line endings: 12 of the 25 chan_quectel files the series touches (`at_command.[ch]`, `at_parse.c`, `at_response.[ch]`,
`chan_quectel.[ch]`, `dc_config.[ch]`, `manager.c`, `pdiscovery.c`, `quectel.conf`) are committed upstream with CRLF
although `.gitattributes` says `* text eol=lf`. `git apply` normalizes a
file while reading it and writes it back with the attribute's ending, so the patch is an LF diff against the
normalized text and those files come out LF in the image. A CRLF patch would not apply.
