#!/bin/sh
# Aster — tests for install/udev/alsa-name, the udev helper that gives a Quectel UAC sound card a deterministic ALSA id
# (POSIX sh + sha1sum). The id must match generators.js alsaCardId; generators.test.js compares the two.
#
# Usage: sh test/install/alsa-name.test.sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
alsa_name="$root/install/udev/alsa-name"
failed=0
ran=0

# A devpath as udev passes it in %p: the sound card of an interface of a device on a USB port.
devpath() {
  printf '/devices/platform/scb/fd500000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0/usb1/%s/%s:1.4/sound/card2' "$1" "$1"
}

check() {
  ran=$((ran + 1))
  if [ "$2" = "$3" ]; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s: expected %s, got %s\n' "$1" "$3" "$2" >&2
    failed=$((failed + 1))
  fi
}

# The ordinary case: the port with - and . replaced by _, prefixed q_ (a hub port and a root port).
check '1-1.3 → q_1_1_3' "$(sh "$alsa_name" "$(devpath 1-1.3)")" 'q_1_1_3'
check '1-2 → q_1_2' "$(sh "$alsa_name" "$(devpath 1-2)")" 'q_1_2'
check '3-1.4.2 → q_3_1_4_2' "$(sh "$alsa_name" "$(devpath 3-1.4.2)")" 'q_3_1_4_2'

# 15 characters is the kernel's limit for a card id: q_10_1_2_3_4_56 is exactly 15 and stays, one more segment digit
# does not fit and becomes a hash. The expected hash is sha1(port) — the same value generators.test.js pins.
check '10-1.2.3.4.56 → q_10_1_2_3_4_56 (15 chars, the limit)' "$(sh "$alsa_name" "$(devpath 10-1.2.3.4.56)")" 'q_10_1_2_3_4_56'
check '10-1.2.3.4.567 → qh_<sha1>' "$(sh "$alsa_name" "$(devpath 10-1.2.3.4.567)")" "qh_$(printf '%s' '10-1.2.3.4.567' | sha1sum | cut -c1-12)"
check 'a deep chain hashes too' "$(sh "$alsa_name" "$(devpath 2-1.1.1.1.1.1.1)")" "qh_$(printf '%s' '2-1.1.1.1.1.1.1' | sha1sum | cut -c1-12)"

# The interface segment (1-1.3:1.4) is not the port, and the last port segment of the path wins: a card behind a hub
# must not be named after the hub.
check 'the interface segment is not the port' "$(sh "$alsa_name" '/devices/pci0000:00/usb1/1-1/1-1.3/1-1.3:1.4/sound/card2')" 'q_1_1_3'
check 'the last port segment wins' "$(sh "$alsa_name" '/devices/pci0000:00/usb2/2-1/2-1.4/sound/card0')" 'q_2_1_4'

# No USB port in the path: the helper fails, and udev then leaves the card id alone rather than naming it something
# arbitrary. An empty argument is the same case.
ran=$((ran + 1))
if sh "$alsa_name" '/devices/platform/soc/sound/card0' >/dev/null 2>&1; then
  printf 'FAIL a path without a USB port must exit non-zero\n' >&2
  failed=$((failed + 1))
else
  printf 'ok   a path without a USB port exits non-zero\n'
fi

ran=$((ran + 1))
if sh "$alsa_name" '' >/dev/null 2>&1; then
  printf 'FAIL an empty devpath must exit non-zero\n' >&2
  failed=$((failed + 1))
else
  printf 'ok   an empty devpath exits non-zero\n'
fi

printf '\n%s/%s passed\n' "$((ran - failed))" "$ran"
[ "$failed" -eq 0 ] || exit 1
