### `1-1` — `12d1:1436` HUAWEI Mobile

- the driver Aster picks for this vendor: `dongle`
- ttys: if00 → /dev/ttyUSB0, if03 → /dev/ttyUSB1, if04 → /dev/ttyUSB2
- chan_dongle: known (`E1750`, data if04, audio if03) → data `/dev/ttyUSB2`, audio `/dev/ttyUSB1`
- chan_quectel: known (`E1750`, data if04, audio if03) → data `/dev/ttyUSB2`, audio `/dev/ttyUSB1`

### `1-2` — `2c7c:0125` EC25-EUX

- the driver Aster picks for this vendor: `quectel`
- ttys: if00 → /dev/ttyUSB3, if01 → /dev/ttyUSB4, if02 → /dev/ttyUSB5, if03 → /dev/ttyUSB6
- chan_dongle: **known (`EC25`) but its table probes data if01, audio if04, and if04 (audio) has no tty on this host** — `dongle discovery` cannot find this modem; give the registry entry `ports: { data: …, audio: … }` instead of an IMEI
- chan_quectel: known (`EC25`, data if02, audio if01) → data `/dev/ttyUSB5`, audio `/dev/ttyUSB4`
