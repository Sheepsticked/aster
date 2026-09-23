#!/bin/sh
# Aster — hw-probe: the USB, tty, sound and old-appliance facts of the target host, as Markdown.
#
# First question: is each modem's USB id in its driver's discovery table? A modem missing from it (or with its
# interfaces elsewhere) is never discovered and needs `ports:` instead of an IMEI. The tables below are copied from
# the pinned driver sources (pdiscovery.c `device_ids[]`, chan_dongle 31eb619, chan_quectel 3d45c7f).
#
# Read-only: it opens no serial port, loads no module and writes nothing. Everything it needs is in /sys, so a host
# without usbutils still gets the answer; lsusb, udevadm and dmesg are extras and are skipped when absent.
#
# Usage: ssh <host> 'sh -s' < tools/hw-probe.sh > probe.md
#        ssh <host> 'sh -s -- --old-home /srv/asterisk' < tools/hw-probe.sh     (the -- is needed: a piped sh reads
#                                                                                --old-home as its own option)
#        sh tools/hw-probe.sh [--root <dir>] [--old-home <dir>]
#   --root <dir>      read /sys and /dev under <dir> (for testing against a captured tree)
#   --old-home <dir>  the old appliance's home (default <root>/srv/asterisk); its temp/ holds the driver choice
#   exit 0 = a report was printed (even when nothing is plugged in) · 2 = a bad argument or no readable /sys
set -eu

USAGE="usage: sh tools/hw-probe.sh [--root <dir>] [--old-home <dir>]
       over ssh: ssh <host> 'sh -s' < tools/hw-probe.sh    (with arguments: 'sh -s -- --old-home /srv/asterisk')"
ROOT=""
OLD_HOME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root|--old-home)
      [ $# -ge 2 ] || { echo "hw-probe.sh: $1 needs a directory" >&2; exit 2; }
      if [ "$1" = --root ]; then ROOT=$2; else OLD_HOME=$2; fi
      shift 2 ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    *) echo "hw-probe.sh: unknown argument $1" >&2; echo "$USAGE" >&2; exit 2 ;;
  esac
done
SYS="$ROOT/sys"
DEV="$ROOT/dev"
OLD=${OLD_HOME:-$ROOT/srv/asterisk}
[ -d "$SYS/bus/usb/devices" ] || { echo "hw-probe.sh: $SYS/bus/usb/devices is not there — is this a Linux host with sysfs?" >&2; exit 2; }

# vid:pid=<data interface>,<audio interface> of each driver's discovery table. Commented-out entries (12d1:1465 K3520)
# are left out on purpose: the driver does not know them either.
DONGLE_IDS="12d1:1001=2,1 12d1:140c=3,2 12d1:14ac=4,3 12d1:1436=4,3 12d1:1506=1,2 2c7c:0125=1,4"
QUECTEL_IDS="12d1:1001=2,1 12d1:140c=3,2 12d1:14ac=4,3 12d1:1436=4,3 12d1:1506=3,2 2c7c:0125=2,1"
# The names the tables carry, for the reader.
ID_NAMES="12d1:1001=E1550_and_generic 12d1:140c=E17xx 12d1:14ac=E153Du-1 12d1:1436=E1750 12d1:1506=E171_firmware_21.x 2c7c:0125=EC25"
# The driver Aster gives a USB vendor (src/devices/sysfs.js MODEM_VENDORS); nothing else counts as a modem here.
driver_for() {
  case "$1" in
    2c7c) printf 'quectel' ;;
    12d1) printf 'dongle' ;;
  esac
}

# One "<port> <interface> <tty>" line per USB serial port found, and the ports that have one.
TTYMAP=""
MODEM_PORTS=""
OTHER_PORTS=""

# $1 = table, $2 = vid:pid → the value after =, or nothing.
lookup() {
  for entry in $1; do
    case "$entry" in
      "$2="*) printf '%s' "${entry#*=}"; return 0 ;;
    esac
  done
  return 0
}

# The contents of a sysfs attribute, or nothing.
attr() {
  [ -r "$1" ] || return 0
  tr -d '\n' < "$1"
}

# $1 = port, $2 = interface number → the tty on it, or nothing.
tty_of() {
  printf '%s\n' "$TTYMAP" | awk -v port="$1" -v iface="$2" '$1 == port && $2 == iface { print $3; exit }'
}

# The interface number as the drivers and lsusb write it: if04, if12.
iface_label() {
  case "${#1}" in
    1) printf 'if0%s' "$1" ;;
    *) printf 'if%s' "$1" ;;
  esac
}

# Adds "$1" to the space-separated list named by $2 unless it is already in it.
list_add() {
  case " $2 " in
    *" $1 "*) printf '%s' "$2" ;;
    *) printf '%s' "${2:+$2 }$1" ;;
  esac
}

# ---- the tty → USB port map, the way the controller reads it (src/devices/sysfs.js) --------------------------------
for link in "$SYS"/class/tty/*; do
  [ -e "$link/device" ] || continue
  tty=${link##*/}
  device=$(readlink -f "$link/device" 2>/dev/null) || continue
  # Walk up to the interface directory (<port>:<config>.<interface>); its parent is the USB device.
  dir=$device
  iface=""
  while [ "$dir" != "/" ] && [ "$dir" != "." ]; do
    name=${dir##*/}
    case "$name" in
      *:*.*) iface=${name##*.}; break ;;
    esac
    dir=${dir%/*}
    [ -n "$dir" ] || break
  done
  [ -n "$iface" ] || continue
  parent=${dir%/*}
  port=${parent##*/}
  [ -n "$(attr "$parent/idVendor")" ] || continue
  TTYMAP="$TTYMAP$port $iface $tty
"
  if [ -n "$(driver_for "$(attr "$parent/idVendor")")" ]; then
    MODEM_PORTS=$(list_add "$port" "$MODEM_PORTS")
  else
    OTHER_PORTS=$(list_add "$port" "$OTHER_PORTS")
  fi
done

say() { printf '%s\n' "$*"; }

say "# Hardware probe — $(uname -n 2>/dev/null || echo 'unknown host'), $(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo 'unknown date')"
say ""
say "\`$(uname -srm 2>/dev/null || echo 'uname failed')\`${ROOT:+  (sysfs read under \`$ROOT\`)}"
say ""
say "## Modems"
say ""
if [ -z "$MODEM_PORTS" ]; then
  say "No USB device of a modem vendor (2c7c Quectel, 12d1 Huawei) is plugged in."
  say ""
fi
for port in $MODEM_PORTS; do
  dir="$SYS/bus/usb/devices/$port"
  vendor=$(attr "$dir/idVendor")
  product=$(attr "$dir/idProduct")
  id="$vendor:$product"
  driver=$(driver_for "$vendor")
  product=$(attr "$dir/product")
  say "### \`$port\` — \`$id\`${product:+ $product}"
  say ""
  maker=$(attr "$dir/manufacturer")
  serial=$(attr "$dir/serial")
  say "- the driver Aster picks for this vendor: \`$driver\`${maker:+ · manufacturer: $maker}${serial:+ · USB serial: $serial}"
  ttys=""
  for line in $(printf '%s\n' "$TTYMAP" | awk -v p="$port" '$1 == p { print $2 "=" $3 }'); do
    ttys="${ttys:+$ttys, }$(iface_label "${line%%=*}") → /dev/${line#*=}"
  done
  say "- ttys: ${ttys:-none (the kernel bound no serial driver to this device)}"
  for table in dongle quectel; do
    if [ "$table" = dongle ]; then pair=$(lookup "$DONGLE_IDS" "$id"); else pair=$(lookup "$QUECTEL_IDS" "$id"); fi
    if [ -z "$pair" ]; then
      say "- chan_$table: **\`$id\` is not in its discovery table** — \`$table discovery\` will never list this modem; give the registry entry \`ports: { data: …, audio: … }\` instead of an IMEI"
      continue
    fi
    data_if=$(iface_label "${pair%,*}")
    audio_if=$(iface_label "${pair#*,}")
    data_tty=$(tty_of "$port" "${pair%,*}")
    audio_tty=$(tty_of "$port" "${pair#*,}")
    name=$(lookup "$ID_NAMES" "$id")
    where="data $data_if, audio $audio_if"
    if [ -n "$data_tty" ] && [ -n "$audio_tty" ]; then
      say "- chan_$table: known (\`${name:-unnamed}\`, $where) → data \`/dev/$data_tty\`, audio \`/dev/$audio_tty\`"
    else
      missing=""
      [ -n "$data_tty" ] || missing="$data_if (data)"
      [ -n "$audio_tty" ] || missing="${missing:+$missing and }$audio_if (audio)"
      say "- chan_$table: **known (\`${name:-unnamed}\`) but its table probes $where, and $missing has no tty on this host** — \`$table discovery\` cannot find this modem; give the registry entry \`ports: { data: …, audio: … }\` instead of an IMEI"
    fi
  done
  say ""
done
if [ -n "$OTHER_PORTS" ]; then
  say "Other USB devices with a serial port (not a modem vendor Aster knows):"
  say ""
  for port in $OTHER_PORTS; do
    dir="$SYS/bus/usb/devices/$port"
    say "- \`$port\` — \`$(attr "$dir/idVendor"):$(attr "$dir/idProduct")\` $(attr "$dir/product" || true)"
  done
  say ""
fi

say "## USB devices"
say ""
say '```'
if command -v lsusb >/dev/null 2>&1 && [ -z "$ROOT" ]; then
  lsusb 2>&1 || true
else
  if [ -n "$ROOT" ]; then say "lsusb: skipped (--root) — from sysfs instead:"; else say "lsusb: not installed — from sysfs instead:"; fi
  for dir in "$SYS"/bus/usb/devices/*; do
    [ -r "$dir/idVendor" ] || continue
    product=$(attr "$dir/product")
    say "$(printf '%-8s %s:%s%s' "${dir##*/}" "$(attr "$dir/idVendor")" "$(attr "$dir/idProduct")" "${product:+ $product}")"
  done
fi
say '```'
say ""

say "## Serial ports"
say ""
say '```'
found=0
for tty in "$DEV"/ttyUSB*; do
  [ -e "$tty" ] || continue
  found=1
  say "$tty"
done
for link in "$DEV"/serial/by-path/*; do
  [ -e "$link" ] || continue
  found=1
  say "${link##*/} -> $(readlink -f "$link" 2>/dev/null || echo '?')"
done
[ "$found" = 1 ] || say "no /dev/ttyUSB* and no /dev/serial/by-path"
say '```'
say ""

say "## Sound cards"
say ""
say '```'
found=0
for card in "$SYS"/class/sound/card*; do
  [ -r "$card/id" ] || continue
  found=1
  where=$(readlink -f "$card/device" 2>/dev/null || echo "")
  port=""
  dir=$where
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    name=${dir##*/}
    case "$name" in
      *:*) : ;;
      [0-9]*-[0-9]*) port=$name; break ;;
    esac
    dir=${dir%/*}
  done
  say "${card##*/}: id=$(attr "$card/id")${port:+ (usb port $port)}"
done
[ "$found" = 1 ] || say "no sound card (a Quectel in UAC mode registers one; udev renames it to q_<port>)"
say '```'
say ""

say "## udev properties of the modem ttys"
say ""
say '```'
if [ -n "$ROOT" ]; then
  say "udevadm: skipped (--root)"
elif ! command -v udevadm >/dev/null 2>&1; then
  say "udevadm: not installed"
elif [ -z "$MODEM_PORTS" ]; then
  say "no modem tty to ask about"
else
  printf '%s\n' "$TTYMAP" | while IFS=' ' read -r port iface tty; do
    [ -n "${tty:-}" ] || continue
    case " $MODEM_PORTS " in *" $port "*) ;; *) continue ;; esac
    say "--- $tty (port $port, interface $iface)"
    udevadm info --query=property --name="/dev/$tty" 2>&1 | grep -E '^(DEVNAME|ID_VENDOR_ID|ID_MODEL_ID|ID_USB_INTERFACE_NUM|ID_PATH|ID_MM_|SUBSYSTEM)' || true
  done
fi
say '```'
say ""

say "## Kernel messages (USB, last 20)"
say ""
say '```'
if [ -n "$ROOT" ]; then
  say "dmesg: skipped (--root)"
elif ! command -v dmesg >/dev/null 2>&1; then
  say "dmesg: not installed"
else
  # The exit status of the pipeline is tail's, which succeeds on empty input, so the output itself is the test.
  usb_lines=$(dmesg 2>/dev/null | grep -i usb | tail -n 20 || true)
  if [ -n "$usb_lines" ]; then say "$usb_lines"; else say "dmesg: nothing about USB (kernel.dmesg_restrict=1? run this with sudo)"; fi
fi
say '```'
say ""

say "## The old appliance"
say ""
say '```'
say "home: $OLD"
found=0
for file in "$OLD"/temp/*; do
  [ -f "$file" ] || continue
  found=1
  say "temp/${file##*/} = $(tr -d '\n' < "$file")"
done
[ "$found" = 1 ] || say "temp/: no state file (the driver choice and the desired state of each slot live here)"
for file in "$OLD"/asterisk/quectel.conf "$OLD"/asterisk/dongle.conf "$OLD"/asterisk/sip.conf "$OLD"/asterisk/extensions.conf; do
  if [ -f "$file" ]; then say "have $file"; fi
done
say '```'
say ""
say "Keep this block with your notes. The conversion tools read the files above:"
say "\`node tools/import-old-registry.js $OLD/asterisk $OLD/temp\`."
