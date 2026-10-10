#!/usr/bin/env bash
# Aster — doctor: one screen that says whether the appliance is healthy and, when it is not, where to look.
# It only reads: nothing here changes the appliance.
#
# Usage: doctor.sh [--home DIR] [--write-seconds N]
#   --home           the appliance's data (default: data/ in the checkout this script is in)
#   --write-seconds  also measure the disk's write rate by sampling it for N seconds (off by default)
#
# Exit status: 0 when everything it can check is fine, 1 when something is wrong — so `aster doctor` can be used in a
# cron job or an Ansible check. A note (a recommendation, a missing optional tool, errors in the logs) does not fail it.
# The last lines list every problem and note found.
#
# Examples (`aster doctor` runs this script):
#   doctor.sh                       every check, without the write measurement
#   doctor.sh --write-seconds 20    every check, and the write rate sampled for 20 seconds
#   doctor.sh || echo 'needs a look'     the exit status is 1 when something is wrong
set -euo pipefail

# The checkout is the one this file is in; the home is data/ inside it unless --home names another one.
SELF=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(CDPATH='' cd -- "$SELF/../.." && pwd)
HOME_DIR="$REPO/data"
WRITE_SECONDS=0
PROBLEMS=0
PROBLEM_LIST=()
NOTE_LIST=()

while [ $# -gt 0 ]; do
  case $1 in
    --home) HOME_DIR=${2:?--home needs a directory}; shift 2 ;;
    --home=*) HOME_DIR=${1#*=}; shift ;;
    --write-seconds) WRITE_SECONDS=${2:?--write-seconds needs a number}; shift 2 ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/p;}' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'doctor.sh: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case $WRITE_SECONDS in ''|*[!0-9]*) printf 'doctor.sh: --write-seconds needs a number of seconds\n' >&2; exit 2 ;; esac

# Problems and notes are marked in colour on a terminal and listed again in the summary at the end.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  C_BAD=$'\033[1;31m' C_NOTE=$'\033[1;33m' C_OK=$'\033[32m' C_OFF=$'\033[0m'
else
  C_BAD='' C_NOTE='' C_OK='' C_OFF=''
fi
have() { command -v "$1" >/dev/null 2>&1; }
head_line() { printf '\n== %s\n' "$*"; }
ok() { printf '   %sok%s       %s\n' "$C_OK" "$C_OFF" "$*"; }
info() { printf '            %s\n' "$*"; }
bad() { PROBLEMS=$((PROBLEMS + 1)); PROBLEM_LIST+=("$*"); printf '   %sPROBLEM%s  %s\n' "$C_BAD" "$C_OFF" "$*"; }
warn() { NOTE_LIST+=("$*"); printf '   %snote%s     %s\n' "$C_NOTE" "$C_OFF" "$*"; }
# A numbered list, one item per line.
list_items() {
  local colour=$1 i text
  shift
  i=0
  for text in "$@"; do
    i=$((i + 1))
    printf '%s  %2d.%s %s\n' "$colour" "$i" "$C_OFF" "$text"
  done
}

ENV_FILE=${ASTER_ENV_FILE:-$REPO/.env}
# Fallback: .env in the home (older installs).
[ -f "$ENV_FILE" ] || [ ! -f "$HOME_DIR/.env" ] || ENV_FILE="$HOME_DIR/.env"
# The controller's own default (src/env.js) when the .env does not say; install.sh always writes the line.
HTTP_PORT=80
[ -f "$ENV_FILE" ] && HTTP_PORT=$(sed -n 's/^ASTER_HTTP_PORT=//p' "$ENV_FILE" | tail -1)
HTTP_PORT=${HTTP_PORT:-80}

printf 'Aster doctor — %s (home %s)\n' "$REPO" "$HOME_DIR"

# ---- containers -------------------------------------------------------------------------------------------------

head_line "containers"
if ! have docker; then
  bad "docker is not installed on this host"
else
  for name in aster-asterisk aster-controller; do
    state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo none)
    case "$state/$health" in
      running/healthy) ok "$name is running and healthy" ;;
      running/starting) warn "$name is still starting" ;;
      running/none) ok "$name is running (no healthcheck)" ;;
      running/*) bad "$name is running but its healthcheck says $health" ;;
      missing/*) bad "$name does not exist (install.sh brings it up)" ;;
      *) bad "$name is $state" ;;
    esac
  done
fi

# ---- Asterisk ---------------------------------------------------------------------------------------------------

head_line "Asterisk"
if have docker && docker ps --format '{{.Names}}' | grep -qx aster-asterisk; then
  if uptime_line=$(docker exec aster-asterisk asterisk -rx "core show uptime" 2>/dev/null); then
    printf '%s\n' "$uptime_line" | sed 's/^/   /'
  else
    bad "Asterisk does not answer the CLI (asterisk -rx \"core show uptime\")"
  fi
else
  bad "the Asterisk container is not running"
fi

# ---- the controller's own view ----------------------------------------------------------------------------------

head_line "controller (/api/health on port $HTTP_PORT)"
health_body=''
asked=0
if have curl; then asked=1; health_body=$(curl -fsS --max-time 5 "http://127.0.0.1:$HTTP_PORT/api/health" 2>/dev/null || true)
elif have wget; then asked=1; health_body=$(wget -qO- --timeout=5 "http://127.0.0.1:$HTTP_PORT/api/health" 2>/dev/null || true)
elif have docker && docker ps --format '{{.Names}}' | grep -qx aster-controller; then
  # No curl or wget: the controller's Node asks instead (host network, so 127.0.0.1 is the same port).
  asked=1
  health_body=$(docker exec aster-controller node -e "fetch('http://127.0.0.1:$HTTP_PORT/api/health').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))" 2>/dev/null || true)
fi
case $health_body in
  '')
    if [ "$asked" -eq 0 ]; then
      # Nothing to ask with and no controller to ask from; the containers section above already said so if it is down.
      warn "cannot ask the API: no curl, no wget and no running controller to ask from — install one of them to check this"
    else
      bad "the API does not answer on port $HTTP_PORT"
    fi
    ;;
  *'"status":"ok"'*) ok "status ok" ;;
  *'"status":"degraded"'*)
    bad "status degraded"
    printf '%s' "$health_body" | tr ',' '\n' | grep -i 'reasons\|"ami"\|schema_version\|disk_free_mb\|spool_backlog' | sed 's/^/            /' || true
    ;;
  *) bad "the API answered something unexpected: $(printf '%s' "$health_body" | head -c 120)" ;;
esac

# ---- modems, sound cards, USB -----------------------------------------------------------------------------------

head_line "modems"
ttys=$(ls /dev/ttyUSB* 2>/dev/null | tr '\n' ' ' || true)
[ -n "$ttys" ] && ok "serial ports: $ttys" || warn "no /dev/ttyUSB* — no modem is plugged in, or usb-modeswitch has not flipped a Huawei dongle yet"
for card in /sys/class/sound/card*/id; do
  [ -e "$card" ] || continue
  info "sound card $(basename "$(dirname "$card")"): $(cat "$card")"
done
if have lsusb; then
  lsusb | grep -Ei '2c7c|12d1' | sed 's/^/            /' || warn "lsusb lists no Quectel (2c7c) or Huawei (12d1) device"
else
  warn "lsusb is not installed (apt-get install usbutils) — cannot list the USB devices"
fi
if [ -f "$HOME_DIR/config/aster.yaml" ]; then
  registry_imeis=$(grep -c '^[[:space:]]*-[[:space:]]*id:' "$HOME_DIR/config/aster.yaml" 2>/dev/null || true)
  registry_imeis=${registry_imeis:-0}
  info "the registry configures $registry_imeis modem(s); the Modems page compares them with what the drivers see"
else
  warn "no $HOME_DIR/config/aster.yaml yet"
fi

# ---- USB audio (a Quectel modem in UAC mode) ---------------------------------------------------------------------

# snd_usb_audio's low-latency mode can stall a Quectel UAC playback stream (silent calls); install.sh sets lowlatency=0.
# In the log a silent call shows as many playback underruns, a failed card setup as "Couldn't set the new hw params".
head_line "USB audio (UAC modems)"
uac_card=$(cat /sys/class/sound/card*/id 2>/dev/null | grep -E '^(q_|qh_)' | head -1 || true)
uac_configured=$(grep -c '^[[:space:]]*uac:[[:space:]]*true' "$HOME_DIR/config/aster.yaml" 2>/dev/null || true)
if [ -z "$uac_card" ] && [ "${uac_configured:-0}" = 0 ]; then
  ok "no USB-audio modem configured or plugged in"
else
  param=/sys/module/snd_usb_audio/parameters/lowlatency
  if [ ! -f "$param" ]; then
    warn "snd_usb_audio is not loaded although a UAC modem is configured or plugged in"
  else
    case $(cat "$param" 2>/dev/null) in
      N) ok "snd_usb_audio runs in the classic mode (lowlatency=N)" ;;
      *) bad "snd_usb_audio runs in its low-latency mode (lowlatency=Y): calls through a UAC modem have no audio. Reboot (install.sh wrote /etc/modprobe.d/aster-snd-usb-audio.conf), or stop the modems and reload the module" ;;
    esac
  fi
  if [ -f /etc/modprobe.d/aster-snd-usb-audio.conf ] && grep -q '^options snd_usb_audio lowlatency=0' /etc/modprobe.d/aster-snd-usb-audio.conf; then
    ok "/etc/modprobe.d/aster-snd-usb-audio.conf sets lowlatency=0 for the next boot"
  else
    bad "/etc/modprobe.d/aster-snd-usb-audio.conf is missing (install.sh writes it): the next boot runs snd_usb_audio in its low-latency mode"
  fi
  if [ -f "$HOME_DIR/logs/asterisk/full" ]; then
    # Counted only since Asterisk last started (its version banner resets the counts).
    since_start=$(awk '/\] Asterisk [0-9][0-9.]* built by / {n = 0; c = 0; f = 0} /UAC audio of this call/ {n++; for (i = 1; i < NF; i++) if ($(i+1) == "playback" && $i + 0 >= 100) {c++; break}} /Couldn.t set the new hw params/ {f++} END {print n + 0, c + 0, f + 0}' "$HOME_DIR/logs/asterisk/full" 2>/dev/null || true)
    read -r uac_calls dead_calls setup_failures <<< "${since_start:-0 0 0}"
    [ "${dead_calls:-0}" = 0 ] && ok "no silent UAC call since Asterisk started ($uac_calls call(s) checked)" \
      || bad "$dead_calls of $uac_calls UAC call(s) since Asterisk started had 100 or more playback underruns: the far end heard nothing (lowlatency above, or a sound card that needs a driver restart)"
    [ "${setup_failures:-0}" = 0 ] || warn "the sound card's setup failed $setup_failures time(s) since Asterisk started (Couldn't set the new hw params); a driver without patch 0007 then runs calls with no audio until 'quectel restart now <id>'"
  fi
fi

# ---- the USB controller of a Raspberry Pi 3 or older ------------------------------------------------------------

# dwc_otg loses a host channel until reboot whenever an isochronous transfer its FIQ runs is cancelled (UAC calls,
# driver restarts); install.sh adds dwc_otg.fiq_fsm_mask=0x3 to cmdline.txt. Bound to a device = actually in use.
head_line "USB controller (Raspberry Pi 3 and older)"
# Whether a fiq_fsm_mask value (decimal or 0x hex) still sends isochronous transfers (bit 2) to the FIQ.
mask_has_iso() {
  local mask
  if [[ $1 =~ ^0[xX][0-9a-fA-F]{1,4}$ ]]; then mask=$((16#${1:2}))
  elif [[ $1 =~ ^[0-9]{1,5}$ ]]; then mask=$((10#$1))
  else return 0
  fi
  [ $((mask & 4)) -ne 0 ]
}
dwc_bound=0
for dev in /sys/bus/platform/drivers/dwc_otg/*.usb; do [ -L "$dev" ] && dwc_bound=1; done
if [ "$dwc_bound" -eq 0 ]; then
  ok "no dwc_otg USB controller here (only a Raspberry Pi 3 or older has one)"
else
  dwc_params=/sys/module/dwc_otg/parameters
  dwc_mask=$(cat "$dwc_params/fiq_fsm_mask" 2>/dev/null || echo '?')
  cmdline=/boot/cmdline.txt
  [ -f /boot/firmware/cmdline.txt ] && cmdline=/boot/firmware/cmdline.txt
  if [ "$(cat "$dwc_params/fiq_enable" 2>/dev/null)" != Y ] || [ "$(cat "$dwc_params/fiq_fsm_enable" 2>/dev/null)" != Y ] ||
     ! mask_has_iso "$dwc_mask"; then
    ok "dwc_otg keeps isochronous transfers out of its FIQ (fiq_fsm_mask=$dwc_mask)"
  else
    dwc_text="dwc_otg runs isochronous transfers in its FIQ (fiq_fsm_mask=$dwc_mask): every UAC call and driver restart can lose one of its 8 USB channels until reboot; after a few calls the call audio fails, then the network."
    boot_mask=$(head -n 1 "$cmdline" 2>/dev/null | tr ' ' '\n' | sed -n 's/^dwc_otg\.fiq_fsm_mask=//p' | tail -1)
    if [ -n "$boot_mask" ] && ! mask_has_iso "$boot_mask"; then
      dwc_text="$dwc_text $cmdline already sets dwc_otg.fiq_fsm_mask=$boot_mask: reboot to apply it"
    else
      dwc_text="$dwc_text Run install/install.sh again (it adds dwc_otg.fiq_fsm_mask=0x3 to $cmdline), then reboot"
    fi
    if [ -n "$uac_card" ] || [ "${uac_configured:-0}" != 0 ]; then bad "$dwc_text"; else warn "$dwc_text (no UAC modem yet)"; fi
  fi
fi

# ---- disk and the write budget  ------------------------------------------------------------------------------

head_line "disk and the write budget"
df -h "$HOME_DIR" 2>/dev/null | sed 's/^/   /' || bad "cannot read the free space of $HOME_DIR"

if have findmnt; then
  opts=$(findmnt -no OPTIONS --target "$HOME_DIR" 2>/dev/null || echo unknown)
  case $opts in
    *noatime*) ok "mount options: $opts" ;;
    *) warn "mount options: $opts — noatime would stop every read from writing an access time (the write budget; add it to /etc/fstab yourself)" ;;
  esac
fi

# Swap on the card is the largest avoidable write source; zram (compressed RAM, no backing device) never reaches it.
if have swapon; then
  swap=$(swapon --show=NAME --noheadings 2>/dev/null || true)
  swap_on_disk=$(printf '%s\n' "$swap" | awk '$1 != "" && $1 !~ /zram/ {print $1}' | tr '\n' ' ')
  if [ -z "$swap" ]; then
    ok "swap is off"
  elif [ -z "$swap_on_disk" ]; then
    ok "swap is zram only ($(printf '%s' "$swap" | tr '\n' ' ')) — compressed RAM, never written to the card"
  else
    warn "swap on disk ($swap_on_disk) — on a card it is the largest avoidable write source; turn it off in the OS image, the installer does not (README: SD-card wear)"
  fi
fi

journald_storage=$(grep -rhs '^Storage=' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf 2>/dev/null | tail -1 | cut -d= -f2 || true)
case ${journald_storage:-default} in
  volatile|none) ok "journald storage: ${journald_storage}" ;;
  *) warn "journald storage: ${journald_storage:-default (persistent on most systems)} — Storage=volatile keeps the journal in RAM; set it in the OS image, the installer does not (README: SD-card wear)" ;;
esac

# Healthcheck temporary files are in RAM when containerd and each container's shim (its init's parent) have the TMPDIR
# of install.sh's drop-in.
if have systemctl && systemctl cat containerd.service >/dev/null 2>&1; then
  dropin=/etc/systemd/system/containerd.service.d/aster-tmpdir.conf
  tmpdir_line=TMPDIR=/run/aster-containerd
  containerd_pid=$(systemctl show -p MainPID --value containerd 2>/dev/null || echo 0)
  if ! grep -qx "Environment=$tmpdir_line" "$dropin" 2>/dev/null; then
    warn "no $dropin (install.sh writes it): healthchecks write temporary files to /tmp"
  elif [ ! -r "/proc/${containerd_pid:-0}/environ" ]; then
    info "$dropin is in place (run doctor as root to check that it is used)"
  elif ! tr '\0' '\n' < "/proc/$containerd_pid/environ" | grep -qx "$tmpdir_line"; then
    warn "containerd runs without $dropin: systemctl restart containerd"
  else
    stale=''
    for name in aster-asterisk aster-controller; do
      init_pid=$(docker inspect -f '{{.State.Pid}}' "$name" 2>/dev/null || echo 0)
      [ "${init_pid:-0}" != 0 ] || continue
      shim_pid=$(awk '/^PPid:/ {print $2}' "/proc/$init_pid/status" 2>/dev/null || true)
      tr '\0' '\n' < "/proc/${shim_pid:-0}/environ" 2>/dev/null | grep -qx "$tmpdir_line" || stale="$stale $name"
    done
    if [ -z "$stale" ]; then
      ok "the healthchecks' temporary files are in RAM (${tmpdir_line#TMPDIR=})"
    else
      warn "healthchecks still write to /tmp until a restart (aster restart):$stale"
    fi
  fi
fi

# The card's own lifetime counter, where the device exposes one (eMMC does; most SD cards do not).
for life in /sys/block/mmcblk*/device/life_time /sys/block/mmcblk*/device/pre_eol_info; do
  [ -e "$life" ] || continue
  info "$(basename "$(dirname "$(dirname "$life")")") $(basename "$life"): $(cat "$life" 2>/dev/null || echo '?')"
done

if [ "$WRITE_SECONDS" -gt 0 ] && [ -x "$REPO/tools/write-budget.sh" ]; then
  info "sampling the disk for ${WRITE_SECONDS}s …"
  "$REPO/tools/write-budget.sh" --seconds "$WRITE_SECONDS" --home "$HOME_DIR" 2>/dev/null | sed 's/^/   /' \
    || warn "the write rate is above the budget; the lines above say what was measured"
elif [ "$WRITE_SECONDS" -gt 0 ]; then
  warn "no $REPO/tools/write-budget.sh — this checkout looks incomplete"
else
  info "the write rate is not measured (aster doctor --write-seconds 20 samples it)"
fi

# ---- the last errors --------------------------------------------------------------------------------------------

head_line "the last 20 error lines"
errors=''
[ -f "$HOME_DIR/logs/asterisk/full" ] && errors=$(grep -E 'ERROR|WARNING' "$HOME_DIR/logs/asterisk/full" 2>/dev/null | tail -20 || true)
if [ -n "$errors" ]; then
  printf '%s\n' "$errors" | sed 's/^/   /'
  # Counted since Asterisk last started (its version banner resets the count), so the summary says they are there.
  log_errors=$(awk '/\] Asterisk [0-9][0-9.]* built by / {n = 0} / ERROR\[/ {n++} END {print n + 0}' "$HOME_DIR/logs/asterisk/full" 2>/dev/null || echo 0)
  [ "${log_errors:-0}" = 0 ] || warn "$log_errors ERROR line(s) in logs/asterisk/full since Asterisk started; the last ones are listed under \"the last 20 error lines\""
else
  ok "nothing in logs/asterisk/full"
fi
if have docker && docker ps --format '{{.Names}}' | grep -qx aster-controller; then
  controller_errors=$(docker logs --tail 200 aster-controller 2>&1 | grep '"level":"error"' | tail -5 || true)
  if [ -n "$controller_errors" ]; then
    printf '%s\n' "$controller_errors" | sed 's/^/   /'
    warn "the controller logged errors recently (docker logs aster-controller); the last ones are listed above"
  else
    ok "no error line in the controller log"
  fi
fi

# ---- verdict ----------------------------------------------------------------------------------------------------

RULE='================================================================================================'
printf '\n'
if [ "$PROBLEMS" -eq 0 ]; then
  printf '%sdoctor: everything checked is fine.%s\n' "$C_OK" "$C_OFF"
  if [ "${#NOTE_LIST[@]}" -gt 0 ]; then
    printf '%s%d note(s), worth a look but not failing the check:%s\n' "$C_NOTE" "${#NOTE_LIST[@]}" "$C_OFF"
    list_items "$C_NOTE" "${NOTE_LIST[@]}"
  fi
else
  printf '%s%s%s\n' "$C_BAD" "$RULE" "$C_OFF"
  printf '%s  doctor: %d PROBLEM(S) — fix these:%s\n' "$C_BAD" "$PROBLEMS" "$C_OFF"
  list_items "$C_BAD" "${PROBLEM_LIST[@]}"
  if [ "${#NOTE_LIST[@]}" -gt 0 ]; then
    printf '%s  and %d note(s), worth a look but not failing the check:%s\n' "$C_NOTE" "${#NOTE_LIST[@]}" "$C_OFF"
    list_items "$C_NOTE" "${NOTE_LIST[@]}"
  fi
  printf '%s%s%s\n' "$C_BAD" "$RULE" "$C_OFF"
  exit 1
fi
