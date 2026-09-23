# asterisk-dongle-quectel

Asterisk 20 with the [chan_dongle](https://github.com/wdoekes/asterisk-chan-dongle) (mainly Huawei 3G sticks) and
[chan_quectel](https://github.com/IchthysMaranatha/asterisk-chan-quectel) (Quectel, SimCom) channel drivers, so USB
cellular modems carry calls, SMS and USSD over a SIM. For amd64 and arm64.

This is the Asterisk image of [Aster](https://github.com/Sheepsticked/aster), a web-managed GSM gateway, without the
rest of Aster. You write the Asterisk configuration yourself.

## Run

```sh
# Copy the image's starter files (both drivers, no modems, a SIP transport, an empty dialplan) into ./asterisk:
# tar packs /etc/asterisk inside a throwaway container, the second tar unpacks it here.
mkdir asterisk
docker run --rm --entrypoint tar sheepsticked/asterisk-dongle-quectel -cC /etc/asterisk . | tar -xC asterisk
# Run Asterisk with that folder as its configuration (a mounted folder hides the image's own files).
docker run -d --name asterisk --network host --privileged -v /dev:/dev \
  -v "$PWD/asterisk:/etc/asterisk" -v asterisk-state:/var/lib/asterisk sheepsticked/asterisk-dongle-quectel
```

Then add a section per modem to `dongle.conf` or `quectel.conf` (for example `[gsm1]` with `imei = <its IMEI>`), SIP
endpoints to `pjsip.conf` and a dialplan to `extensions.conf`. Calls and SMS from a modem arrive in the `default`
context. The console: `docker exec -it asterisk asterisk -r`.

## What is inside

- Asterisk 20 with PJSIP, the basic dialplan apps, English and Russian sounds and music on hold. Only the modules in
  [menuselect.opts](https://github.com/Sheepsticked/aster/blob/main/docker/asterisk/menuselect.opts) are built: no
  voicemail, queues, AGI or ARI.
- Both drivers at pinned commits with
  [patches](https://github.com/Sheepsticked/aster/blob/main/docker/asterisk/patches/README.md): a crash fix in
  Quectel port discovery, audio for two Quectel USB-sound-card calls at once, recovery from a sound card that does
  not start, Quectel SMS delivery reports, and a slow AT command no longer restarts the modem. New settings `radio`,
  `qrxgain` and `smsreport`; AMI actions `DongleAtCommand` and `QuectelAtCommand`.
- The exact versions are image labels: `docker image inspect -f '{{json .Config.Labels}}' sheepsticked/asterisk-dongle-quectel`.

## Notes

- Both drivers run in one process: keep a separate `smsdb` per driver, as the starter files do.
- Privileged with `/dev`, so a modem can be unplugged and come back; host networking for SIP and RTP.
- Keep ModemManager off the modems (the `ID_MM_*` lines of
  [90-aster.rules](https://github.com/Sheepsticked/aster/blob/main/install/udev/90-aster.rules)). A Quectel's USB
  sound card needs `options snd_usb_audio lowlatency=0` on the host
  ([why](https://github.com/Sheepsticked/aster#requirements)).

## Tags

`latest`, and `<Asterisk version>-<commit>` to pin one build.

## Licence

GPL-2.0, like Asterisk and both drivers. Source: [docker/asterisk](https://github.com/Sheepsticked/aster/tree/main/docker/asterisk).
