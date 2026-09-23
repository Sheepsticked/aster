# Discovery command output

Text printed by `quectel discovery` and `dongle discovery` (cli.c `cli_discovery()`, identical in both pinned forks): per device
`; discovered device`, `[dc_<last 4 of IMEI>_<last 4 of IMSI>](defaults)`, `;audio=<tty>`, `;data=<tty>`, `imei=<…>`, `imsi=<…>` and an
empty line. Through the AMI `Command` action the same lines arrive as `Output:` headers (the final empty line included).
`test/devices-scan.test.js` parses each file with `parseDiscovery()`.

## Captured on hardware (no SIM in either modem)

Both modems were plugged in: the Huawei E173 (`12d1:1436`) on USB port 1-1 with its data tty `/dev/ttyUSB2` and audio `/dev/ttyUSB1`,
the Quectel EC25-EUX (`2c7c:0125`) on 1-2 with data `/dev/ttyUSB5` and audio `/dev/ttyUSB4` (`test/fixtures/sysfs/two-modems.json`).

| File | Session |
|---|---|
| `quectel-free-ports.txt` | `asterisk -rx 'quectel discovery'` with both devices stopped (every port free): the EC25 with its correct IMEI and an empty IMSI (no SIM) |
| `dongle-free-ports.txt` | `asterisk -rx 'dongle discovery'` right after it: the E173 with its IMEI (the EC25 is not listed: chan_dongle's EC25 table entry probes interfaces that are not the EC25-EUX AT port) |
| `dongle-ami.txt` | `dongle discovery` through the AMI `Command` action: byte for byte the CLI output |
| `quectel-locked-ports.txt` | `quectel discovery` while both devices were started: the EC25's ports were locked by its running device; the E173, in its reconnect loop, was free and probed (chan_quectel's table knows it too) and its `imsi=` came out equal to the IMEI, because the fork's `pdiscovery_handle_cimi()` reads the wrong answer when `AT+CIMI` fails. `parseDiscovery()` drops such an IMSI |
| `dongle-empty.txt` | `dongle discovery` in the same situation: nothing (0 bytes), as the E173's ports were locked by the dongle device |

## Synthesized from the source format

| File | Content |
|---|---|
| `synthesized-with-sim.txt` | what a modem with a SIM prints: a 15-digit IMSI, so the section name carries both tails; plus a second block with CRLF line ends and an `imei=;` / `imsi=AT+GSN;` garbage pair, as seen on real hardware |
