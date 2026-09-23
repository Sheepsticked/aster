#!/usr/bin/env bash
# Aster — migrate: take a host over from the old /srv/asterisk appliance. Run it on the host.
#
# Usage: migrate.sh [--home DIR] [--old-home /srv/asterisk] <command> [--yes] [--force] [--keep-registry]
#   check      read-only: what of the old appliance is on this host, what of it conflicts with Aster, the next step
#   import     the old configuration as a draft registry, <home>/migrate/aster.yaml, and what was assumed,
#              <home>/migrate/import-report.txt. Installs nothing. --force replaces a draft that is already there
#   cutover    Aster takes over: moves the old Quectel sound-card rename aside, copies the old SMS history, stops the
#              old containers, installs the draft as config/aster.yaml (--keep-registry keeps the current one),
#              restarts Aster and checks that SIP is up. Calls in progress drop
#   rollback   undoes a cutover: stops Aster, puts the previous registry and the rename back, starts the old containers
#   cleanup    once the old appliance is retired: removes its containers, images, udev rules and the asterisk user
#              (uid 1456). /srv/asterisk itself is kept — it is the only copy of the old configuration
#   replace    cutover and cleanup in one, for when nothing of the old configuration is wanted: Aster keeps its own
#              registry, and once it answers with SIP up the old appliance is removed. No rollback after that
#   --yes      do not ask before cutover, rollback, cleanup or replace
# Everything cutover moves or replaces is kept in <home>/migrate/, which is what lets rollback put it all back.
set -euo pipefail

# The checkout is the one this file is in; the home is data/ inside it unless --home names another one.
SELF=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(CDPATH='' cd -- "$SELF/../.." && pwd)
HOME_DIR="$REPO/data"
OLD_HOME=/srv/asterisk
COMMAND=''
ASSUME_YES=0
FORCE=0
KEEP_REGISTRY=0
# The tests put every host path (/etc, /usr/local, /sys) under a scratch directory. Nothing of the real host is written
# then, so the root check is skipped too.
SYSTEM_ROOT=${ASTER_SYSTEM_ROOT:-/}
HEALTH_TIMEOUT=${ASTER_HEALTH_TIMEOUT:-120}

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'migrate.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --home) HOME_DIR=${2:?--home needs a directory}; shift 2 ;;
    --home=*) HOME_DIR=${1#*=}; shift ;;
    --old-home) OLD_HOME=${2:?--old-home needs a directory}; shift 2 ;;
    --old-home=*) OLD_HOME=${1#*=}; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --keep-registry) KEEP_REGISTRY=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    check|import|cutover|rollback|cleanup|replace)
      [ -z "$COMMAND" ] || die "one command at a time, not $COMMAND and $1"
      COMMAND=$1
      shift
      ;;
    *) printf 'migrate.sh: unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$COMMAND" ] || { usage >&2; exit 2; }

ENV_FILE=${ASTER_ENV_FILE:-$REPO/.env}
# Fallback: .env in the home (older installs).
[ -f "$ENV_FILE" ] || [ ! -f "$HOME_DIR/.env" ] || ENV_FILE="$HOME_DIR/.env"
COMPOSE_FILE="$REPO/docker-compose.yml"
REGISTRY="$HOME_DIR/config/aster.yaml"
MIG="$HOME_DIR/migrate"
STATE="$MIG/state"
DRAFT="$MIG/aster.yaml"
BEFORE="$MIG/aster.yaml.before-cutover"
MOVED="$MIG/host-files"
OLD_COMPOSE="$OLD_HOME/docker-compose.yml"

# The old Quectel sound-card rename: it renames the card Aster names q_<port>, so chan_quectel cannot open its audio.
# It is the one part of the old appliance that breaks Aster just by being there.
RENAME_FILES=(/etc/udev/rules.d/90-quectel-audio.rules /etc/systemd/system/quectel-audio@.service /usr/local/sbin/quectel-audio.py)
# Harmless next to Aster, only clutter: sound cards owned by the old uid (root opens them anyway), and ModemManager kept
# off every ttyUSB (90-aster.rules does that for the two modem vendors).
SOUND_RULE=/etc/udev/rules.d/99-asterisk-sound.rules
MM_RULE=/etc/udev/rules.d/99-mm-ignore.rules
OLD_USER=asterisk
OLD_UID=1456
# The old web UI listens on port 80 of the host network — Aster's default port — and the migration does not need it:
# install.sh stops it. It is also what starts the old modems (every 600 s; their drivers have initstate=stop).
OLD_WEBUI=asterisk-webui
OLD_WEBUI_PORT=80
# Inside the old Asterisk container only: the old compose file mounts /etc/asterisk and /dev, not /var/lib/asterisk.
SMS_HISTORY=/var/lib/asterisk/sms_GSM.txt

CONFLICTS=0
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok        %s\n' "$*"; }
note() { printf '   note      %s\n' "$*"; }
leftover() { printf '   leftover  %s\n' "$*"; }
conflict() { CONFLICTS=$((CONFLICTS + 1)); printf '   CONFLICT  %s\n' "$*"; }
did() { printf '   done      %s\n' "$*"; }
warn() { printf '   warning   %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
host() { printf '%s' "${SYSTEM_ROOT%/}$1"; }

need_root() {
  [ "$SYSTEM_ROOT" = / ] || return 0
  [ "$(id -u)" -eq 0 ] || die "$COMMAND changes /etc, the registry and the containers: run it as root (sudo aster migrate $COMMAND)"
}
need_docker() {
  have docker || die "docker is not installed on this host"
  docker info >/dev/null 2>&1 || die "the Docker daemon does not answer (is it running, and may this user talk to it?)"
}
need_aster() {
  [ -f "$ENV_FILE" ] ||
    die "no Aster appliance in $HOME_DIR: install it first (install/install.sh), --home names another one"
}

confirm() {
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  local answer=''
  printf '\n%s [y/N] ' "$1"
  read -r answer || true
  case $answer in
    y|Y|yes|YES) ;;
    *) say 'nothing was done'; exit 0 ;;
  esac
}

env_value() { if [ -f "$ENV_FILE" ]; then sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; fi; }
controller_image() {
  local ns version
  ns=$(env_value ASTER_IMAGE_NS)
  version=$(env_value ASTER_VERSION)
  printf '%s/aster-controller:%s' "${ns:-sheepsticked}" "${version:-latest}"
}
aster_compose() { ASTER_REPO=$REPO ASTER_HOME=$HOME_DIR docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# <home>/migrate holds the draft (SIP secrets), the old host files and the previous registry: root's alone.
ensure_mig() {
  mkdir -p "$MIG"
  chmod 700 "$MIG"
}
state_get() { if [ -f "$STATE" ]; then sed -n "s/^$1=//p" "$STATE" | tail -1; fi; }
state_set() {
  local key=$1 value=$2
  ensure_mig
  { if [ -f "$STATE" ]; then grep -v "^$key=" "$STATE" || true; fi; printf '%s=%s\n' "$key" "$value"; } > "$STATE.tmp"
  mv -f "$STATE.tmp" "$STATE"
}
set_phase() {
  state_set phase "$1"
  state_set at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# ---- the old appliance ------------------------------------------------------------------------------------------

# The containers named by the old compose file, in its order (Asterisk first: the other two depend on it). By name and
# not through `docker compose ps`, which knows only the project the stack was last started under.
old_containers() {
  if [ -f "$OLD_COMPOSE" ]; then
    sed -n "s/^[[:space:]]*container_name:[[:space:]]*[\"']\{0,1\}\([^\"' ]*\).*/\1/p" "$OLD_COMPOSE"
  fi
}
old_images() {
  local image
  if [ ! -f "$OLD_COMPOSE" ]; then return 0; fi
  sed -n "s/^[[:space:]]*image:[[:space:]]*[\"']\{0,1\}\([^\"' ]*\).*/\1/p" "$OLD_COMPOSE" | while read -r image; do
    case ${image##*/} in
      *:*) printf '%s\n' "$image" ;;
      *) printf '%s:latest\n' "$image" ;;
    esac
  done
}
# `docker container inspect`: a plain inspect answers for a same-named image. The exit status decides, since a missing
# container can still print an empty line.
container_state() {
  local state
  if state=$(docker container inspect -f '{{.State.Status}}' "$1" 2>/dev/null) && [ -n "$state" ]; then
    printf '%s' "$state"
  else
    printf 'absent'
  fi
}
container_running() { [ "$(container_state "$1")" = running ]; }
old_running() {
  local c
  for c in $(old_containers); do
    if [ "$(container_state "$c")" = running ]; then printf '%s\n' "$c"; fi
  done
}
old_existing() {
  local c
  for c in $(old_containers); do
    if [ "$(container_state "$c")" != absent ]; then printf '%s\n' "$c"; fi
  done
}
reversed() { printf '%s\n' "$@" | sed '/^$/d' | tac; }

rename_present() {
  local f
  for f in "${RENAME_FILES[@]}"; do
    if [ -e "$(host "$f")" ] || [ -L "$(host "$f")" ]; then return 0; fi
  done
  return 1
}

# "<tty> <idVendor>" for every USB serial port, found the way the controller and hw-probe.sh find them.
usb_ttys() {
  local link dir vendor
  for link in "$(host /sys/class/tty)"/ttyUSB* "$(host /sys/class/tty)"/ttyACM*; do
    [ -e "$link/device" ] || continue
    dir=$(readlink -f "$link/device") || continue
    vendor=''
    while [ -n "$dir" ] && [ "$dir" != / ]; do
      if [ -r "$dir/idVendor" ]; then vendor=$(cat "$dir/idVendor"); break; fi
      dir=${dir%/*}
    done
    if [ -n "$vendor" ]; then printf '%s %s\n' "${link##*/}" "$vendor"; fi
  done
}
is_modem_vendor() { case $1 in 2c7c|12d1) return 0 ;; *) return 1 ;; esac; }

# Modems the registry has put on a port: those are the ones Aster's Asterisk opens.
assigned_modems() {
  local n=''
  if [ -f "$REGISTRY" ]; then n=$(grep -cE '^[[:space:]]+(usb_port: "|ports: \{)' "$REGISTRY" || true); fi
  printf '%s' "${n:-0}"
}

# Captured, then matched: `… | grep -q` under pipefail fails whenever grep exits before the writer is done (SIGPIPE, 141),
# and the transport line comes before the "Objects found" line that is still being written.
sip_transport_up() {
  local transports
  transports=$(docker exec aster-asterisk asterisk -rx 'pjsip show transports' 2>/dev/null || true)
  case $transports in *':5060'*) return 0 ;; *) return 1 ;; esac
}

# ---- host changes, each one reversible ---------------------------------------------------------------------------

reload_units_and_rules() {
  if have systemctl; then systemctl daemon-reload || warn "systemctl daemon-reload failed"; fi
  if have udevadm; then udevadm control --reload || warn "udevadm control --reload failed; the change applies at the next boot"; fi
}
retrigger_sound_cards() {
  if have udevadm; then
    udevadm trigger --subsystem-match=sound --action=add ||
      warn "udevadm trigger failed for the sound cards; a Quectel card keeps its current name until it is replugged"
  fi
}

move_rename_aside() {
  local f src moved=0
  for f in "${RENAME_FILES[@]}"; do
    src=$(host "$f")
    [ -e "$src" ] || [ -L "$src" ] || continue
    ensure_mig
    mkdir -p "$MOVED$(dirname "$f")"
    mv -f "$src" "$MOVED$f"
    did "moved $f to $MOVED$f"
    moved=1
  done
  if [ "$moved" -eq 0 ]; then
    ok "the old Quectel sound-card rename is not on this host"
    return 0
  fi
  reload_units_and_rules
}

put_rename_back() {
  local f put=0
  for f in "${RENAME_FILES[@]}"; do
    [ -e "$MOVED$f" ] || continue
    mkdir -p "$(dirname "$(host "$f")")"
    mv -f "$MOVED$f" "$(host "$f")"
    did "put $f back"
    put=1
  done
  if [ "$put" -eq 0 ]; then
    ok "nothing of the old rename was moved aside, so nothing goes back"
    return 0
  fi
  reload_units_and_rules
  retrigger_sound_cards
}

# The old appliance's received SMS file, kept as is (not imported) in state/old/, so every backup carries it.
copy_sms_history() {
  local c dest="$HOME_DIR/state/old" tmp
  mkdir -p "$dest"
  tmp=$(mktemp "$dest/.sms_GSM.XXXXXX")
  for c in $(old_existing); do
    if docker cp "$c:$SMS_HISTORY" "$tmp" >/dev/null 2>&1 && [ -s "$tmp" ]; then
      chmod 600 "$tmp"
      if [ -f "$dest/sms_GSM.txt" ] && cmp -s "$tmp" "$dest/sms_GSM.txt"; then
        rm -f "$tmp"
        ok "the SMS history of $c is already in $dest/sms_GSM.txt"
      elif [ -f "$dest/sms_GSM.txt" ]; then
        local other
        other="$dest/sms_GSM.$(date -u +%Y%m%dT%H%M%SZ).txt"
        mv -f "$tmp" "$other"
        did "copied the SMS history of $c to $other ($dest/sms_GSM.txt was already there and differs)"
      else
        mv -f "$tmp" "$dest/sms_GSM.txt"
        did "copied the SMS history of $c to $dest/sms_GSM.txt"
      fi
      return 0
    fi
  done
  rm -f "$tmp"
  note "no SMS history in the old containers (none received, or the container was recreated since — the old role recreated it on every deploy)"
}

# Dependents first (the web UI can restart Asterisk through the Docker socket), Asterisk last.
stop_old_containers() {
  local c running
  running=$(old_running)
  if [ -z "$running" ]; then
    ok "no container of the old appliance is running"
    return 0
  fi
  for c in $(reversed "$running"); do
    docker stop "$c" >/dev/null || die "could not stop $c — \`aster migrate rollback\` puts back what was done so far"
    did "stopped $c"
  done
  running=$(old_running)
  [ -z "$running" ] || die "still running after the stop: $running — \`aster migrate rollback\` puts back what was done so far"
}

start_old_containers() {
  local c missing=0 started=0
  for c in $(old_containers); do
    case $(container_state "$c") in
      running) ok "$c is running" ;;
      absent) missing=1 ;;
      *) docker start "$c" >/dev/null || die "could not start $c"; did "started $c"; started=1 ;;
    esac
  done
  if [ "$missing" -eq 1 ]; then
    [ -f "$OLD_COMPOSE" ] || die "a container of the old appliance is gone and there is no $OLD_COMPOSE to create it from"
    docker compose -f "$OLD_COMPOSE" up -d --no-build || die "docker compose up of $OLD_COMPOSE failed"
    did "created the missing containers from $OLD_COMPOSE"
    started=1
  fi
  local still
  still=$(for c in $(old_containers); do [ "$(container_state "$c")" = running ] || printf '%s ' "$c"; done)
  [ -z "$still" ] || die "not running after the start: $still"
  [ "$started" -eq 1 ] || ok "the old appliance was running already"
}

# The draft through the controller's own loader, in the image the appliance runs: what it accepts here is what the
# controller will accept at boot. Checked before anything is stopped, because an operator may have edited the draft.
validate_registry() {
  local file=$1 output
  if output=$(docker run --rm -v "$file:/tmp/aster.yaml:ro" "$(controller_image)" node --input-type=module -e '
      const { load, RegistryError } = await import("/app/packages/controller/src/config/registry.js");
      try {
        load("/tmp/aster.yaml");
      } catch (err) {
        if (err instanceof RegistryError) for (const p of err.errors) console.error(`${p.path || "(file)"}: ${p.message}`);
        else console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }' 2>&1); then
    return 0
  fi
  printf '%s\n' "$output" | sed 's/^/     /' >&2
  return 1
}

# aster.d from the registry, the way install.sh step 4b writes it: the controller does not regenerate at boot.
regenerate() {
  local output
  if output=$(docker run --rm -e ASTER_HOME=/srv/aster -v "$HOME_DIR/config:/srv/aster/config" "$(controller_image)" \
      node packages/controller/bin/generate.js 2>&1); then
    printf '%s\n' "$output" | tail -1 | sed 's/^/   done      /'
    return 0
  fi
  printf '%s\n' "$output" | sed 's/^/     /' >&2
  return 1
}

install_registry() {
  local src=$1
  install -m 644 "$src" "$REGISTRY.tmp.$$"
  mv -f "$REGISTRY.tmp.$$" "$REGISTRY"
}

wait_for_health() {
  local port waited=0 body=''
  port=$(env_value ASTER_HTTP_PORT)
  port=${port:-80}
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if have curl; then body=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)
    elif have wget; then body=$(wget -qO- --timeout=5 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)
    else body=$(docker exec aster-controller node -e "fetch('http://127.0.0.1:$port/api/health').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))" 2>/dev/null || true)
    fi
    case $body in *'"status":"'*) return 0 ;; esac
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Aster's Asterisk gets its SIP transport once the old one has let go of 5060; a minute is plenty for that.
wait_for_sip() {
  local waited=0
  until sip_transport_up; do
    [ "$waited" -lt 60 ] || return 1
    sleep 2
    waited=$((waited + 2))
  done
}

backup_aster() {
  if container_running aster-controller; then
    "$SELF/backup.sh" --home "$HOME_DIR" || die "the backup failed; nothing was changed"
  else
    warn "the controller is not running, so no backup was taken"
  fi
}

# ---- what is left of the old appliance, for cleanup and replace -------------------------------------------------

# Globals, because the plan shown before the question and the removal after it have to be about the same things.
LEFT_CONTAINERS=''
LEFT_IMAGES=''
LEFT_UID=''
OTHER_SERIAL=''
survey_old_appliance() {
  local image tty vendor
  LEFT_CONTAINERS=$(old_existing)
  LEFT_IMAGES=''
  for image in $(old_images); do
    if docker image inspect "$image" >/dev/null 2>&1; then LEFT_IMAGES="$LEFT_IMAGES $image"; fi
  done
  LEFT_UID=$(getent passwd "$OLD_USER" 2>/dev/null | cut -d: -f3 || true)
  OTHER_SERIAL=''
  while read -r tty vendor; do
    [ -n "$tty" ] || continue
    is_modem_vendor "$vendor" || OTHER_SERIAL="$OTHER_SERIAL $tty"
  done < <(usb_ttys)
}

# One line for each thing remove_old_appliance takes; false when there is nothing. The rename is left to the caller:
# cleanup lists it here, replace has moved it aside before the removal starts.
say_removals() {
  local found=0
  if [ -n "$LEFT_CONTAINERS" ]; then say "  - the containers $(printf '%s ' $LEFT_CONTAINERS)(the SMS history is copied first)"; found=1; fi
  if [ -n "$LEFT_IMAGES" ]; then say "  - the images$LEFT_IMAGES"; found=1; fi
  if [ -f "$(host "$SOUND_RULE")" ]; then say "  - $SOUND_RULE"; found=1; fi
  if [ -f "$(host "$MM_RULE")" ]; then
    if [ -n "$OTHER_SERIAL" ]; then
      say "  - (kept) $MM_RULE: another USB serial device is here ($OTHER_SERIAL ) and may need ModemManager kept away"
    else
      say "  - $MM_RULE"
      found=1
    fi
  fi
  if [ "$LEFT_UID" = "$OLD_UID" ]; then say "  - the user and group $OLD_USER (uid $OLD_UID)"; found=1; fi
  [ "$found" -eq 1 ]
}

remove_old_appliance() {
  local c image f src rules_changed=0
  if [ -n "$LEFT_CONTAINERS" ]; then
    step "containers"
    copy_sms_history
    for c in $(reversed "$LEFT_CONTAINERS"); do
      docker rm -f "$c" >/dev/null && did "removed container $c" || warn "could not remove container $c"
    done
  fi
  if [ -n "$LEFT_IMAGES" ]; then
    step "images"
    for image in $LEFT_IMAGES; do
      docker image rm "$image" >/dev/null && did "removed image $image" || warn "could not remove image $image (docker image rm $image says why)"
    done
  fi
  step "udev rules and units"
  if rename_present; then
    for f in "${RENAME_FILES[@]}"; do
      src=$(host "$f")
      [ -e "$src" ] || [ -L "$src" ] || continue
      ensure_mig
      mkdir -p "$MOVED$(dirname "$f")"
      mv -f "$src" "$MOVED$f"
      did "moved $f to $MOVED$f"
    done
    rules_changed=1
  fi
  if [ -f "$(host "$SOUND_RULE")" ]; then rm -f "$(host "$SOUND_RULE")"; did "removed $SOUND_RULE"; rules_changed=1; fi
  if [ -f "$(host "$MM_RULE")" ] && [ -z "$OTHER_SERIAL" ]; then rm -f "$(host "$MM_RULE")"; did "removed $MM_RULE"; rules_changed=1; fi
  if [ "$rules_changed" -eq 1 ]; then reload_units_and_rules; else ok "nothing to remove"; fi

  if [ "$LEFT_UID" = "$OLD_UID" ]; then
    step "the $OLD_USER user"
    if [ -n "$(ps -u "$OLD_UID" -o pid= 2>/dev/null || true)" ]; then
      warn "a process runs as uid $OLD_UID, so the user is kept (ps -u $OLD_UID)"
    else
      userdel "$OLD_USER" && did "removed user $OLD_USER" || warn "userdel $OLD_USER failed"
      if getent group "$OLD_USER" >/dev/null 2>&1; then
        groupdel "$OLD_USER" && did "removed group $OLD_USER" || warn "groupdel $OLD_USER failed"
      fi
    fi
  fi
}

# ---- check ------------------------------------------------------------------------------------------------------

cmd_check() {
  need_docker
  say "Aster migrate check — Aster in $HOME_DIR, the old appliance in $OLD_HOME"

  step "the old appliance"
  local running existing c
  if [ -f "$OLD_COMPOSE" ]; then
    ok "found $OLD_COMPOSE"
  elif [ -d "$OLD_HOME" ]; then
    note "$OLD_HOME is here but has no docker-compose.yml, so its containers cannot be found by name"
  else
    ok "no $OLD_HOME on this host (--old-home names another place)"
  fi
  if [ -d "$OLD_HOME/asterisk" ]; then ok "its configuration, for import: $OLD_HOME/asterisk"; fi
  if [ -d "$OLD_HOME/asterisk" ] && [ ! -d "$OLD_HOME/temp" ]; then
    note "no $OLD_HOME/temp: import cannot tell which driver each slot ran, and assumes dongle"
  fi
  running=$(old_running)
  existing=$(old_existing)
  local aster_port=''
  if [ -f "$ENV_FILE" ]; then aster_port=$(env_value ASTER_HTTP_PORT); aster_port=${aster_port:-80}; fi
  for c in $(old_containers); do
    case $c:$(container_state "$c") in
      "$OLD_WEBUI:running")
        if [ "$aster_port" = "$OLD_WEBUI_PORT" ]; then
          conflict "container $c is running and holds port $OLD_WEBUI_PORT, Aster's port: docker stop $c — the migration does not need it (the old Quectel rename starts it again when a modem is plugged or the host boots)"
        elif [ -z "$aster_port" ]; then
          note "container $c is running on port $OLD_WEBUI_PORT: install.sh stops it to give Aster the port"
        else
          note "container $c is running"
        fi
        ;;
      *:running) note "container $c is running" ;;
      *:absent) ok "container $c is gone" ;;
      "$OLD_WEBUI:"*)
        if container_running asterisk; then
          note "container $c is stopped (Aster has port $OLD_WEBUI_PORT). It is what starts the old modems: if the old Asterisk restarts before the cutover they stay stopped — docker exec asterisk asterisk -rx '<dongle|quectel> start GSM<n>' starts one"
        else
          leftover "container $c exists, stopped"
        fi
        ;;
      *) leftover "container $c exists, stopped" ;;
    esac
  done

  step "udev and systemd"
  if [ -f "$(host /etc/udev/rules.d/90-aster.rules)" ]; then
    ok "Aster's rule is installed (/etc/udev/rules.d/90-aster.rules)"
  else
    conflict "Aster's udev rule is missing: without it the Quectel cards are not named q_<port> — run install.sh as root"
  fi
  local f
  for f in "${RENAME_FILES[@]}"; do
    if [ -e "$(host "$f")" ]; then
      conflict "$f — the old Quectel sound-card rename: it renames the card Aster names q_<port>, so chan_quectel cannot open its audio (cutover moves it aside)"
    fi
  done
  local card id
  for card in "$(host /sys/class/sound)"/card*; do
    [ -r "$card/id" ] || continue
    id=$(cat "$card/id")
    case $id in quectel_*) note "sound card ${card##*/} is named $id — the old rename's name; Aster's is q_<port>" ;; esac
  done
  if [ -f "$(host "$SOUND_RULE")" ]; then leftover "$SOUND_RULE — harmless (the cards stay in group audio, which Asterisk's user is in), cleanup removes it"; fi
  if [ -f "$(host "$MM_RULE")" ]; then leftover "$MM_RULE — harmless (ModemManager kept off every ttyUSB), cleanup removes it"; fi
  local rule
  for rule in "$(host /etc/udev/rules.d)"/*.rules; do
    [ -f "$rule" ] || continue
    case ${rule##*/} in 90-aster.rules|90-quectel-audio.rules|99-asterisk-sound.rules|99-mm-ignore.rules) continue ;; esac
    if grep -qE '2c7c|12d1|ATTR\{id\}' "$rule"; then
      note "${rule#"${SYSTEM_ROOT%/}"} also matches a modem vendor or renames a device — read it: a rule that renames a card or opens a modem port fights Aster the same way"
    fi
  done

  step "SIP and the modems"
  if [ -n "$running" ]; then
    note "while the old Asterisk runs it holds SIP port 5060 and the modem ports: phones register only after the cutover"
  fi
  if container_running aster-asterisk; then
    if sip_transport_up; then
      ok "Aster's Asterisk has its SIP transport on 5060"
    elif [ -n "$running" ]; then
      conflict "Aster's Asterisk has no SIP transport: port 5060 is taken (expected until the cutover)"
    else
      conflict "Aster's Asterisk has no SIP transport and the old appliance is not running: something else holds port 5060 (ss -lunp 'sport = :5060')"
    fi
  else
    note "Aster's Asterisk is not running"
  fi
  local assigned
  assigned=$(assigned_modems)
  if [ -n "$running" ] && [ "$assigned" -gt 0 ]; then
    conflict "$assigned modem(s) assigned in Aster while the old appliance runs: both Asterisks open the same serial ports — do not Scan or Assign until the cutover"
  fi
  if have systemctl && systemctl is-active --quiet ModemManager 2>/dev/null && ! have udevadm; then
    note "ModemManager is running and udevadm is not here to ask whether the modem ports carry the ignore flag"
  elif have systemctl && systemctl is-active --quiet ModemManager 2>/dev/null; then
    local tty vendor props exposed=''
    while read -r tty vendor; do
      [ -n "$tty" ] && is_modem_vendor "$vendor" || continue
      props=$(udevadm info --query=property --name="/dev/$tty" 2>/dev/null || true)
      if ! grep -qE '^ID_MM_(DEVICE|PORT)_IGNORE=1$' <<< "$props"; then exposed="$exposed $tty"; fi
    done < <(usb_ttys)
    if [ -n "$exposed" ]; then
      conflict "ModemManager is running and may open the modem ports:$exposed — reload the udev rules (udevadm trigger --subsystem-match=tty --action=add) or disable it (systemctl disable --now ModemManager)"
    else
      ok "ModemManager is running, but every modem port carries the ignore flag"
    fi
  else
    ok "ModemManager is not running"
  fi

  step "leftovers of the old role"
  local uid
  uid=$(getent passwd "$OLD_USER" 2>/dev/null | cut -d: -f3 || true)
  if [ "$uid" = "$OLD_UID" ]; then leftover "user $OLD_USER (uid $OLD_UID) — nothing of Aster runs as it, cleanup removes it"; fi
  local image any_image=0
  for image in $(old_images); do
    if docker image inspect "$image" >/dev/null 2>&1; then
      leftover "image $image ($(docker image ls --format '{{.Size}}' "$image" 2>/dev/null | head -1))"
      any_image=1
    fi
  done
  if [ "$uid" != "$OLD_UID" ] && [ "$any_image" -eq 0 ] && [ -z "$existing" ]; then ok "none"; fi

  step "Aster"
  if [ -f "$ENV_FILE" ]; then ok "installed in $HOME_DIR"; else conflict "Aster is not installed in $HOME_DIR (install/install.sh)"; fi
  local phase
  phase=$(state_get phase)
  [ -z "$phase" ] || ok "migration state: $phase since $(state_get at)"
  if [ -f "$DRAFT" ]; then ok "draft registry: $DRAFT"; fi

  step "next"
  if [ "$phase" = cleaned ]; then
    say "   the migration is finished"
  elif [ "$phase" = cutover-started ]; then
    say "   the cutover stopped half-way: \`aster migrate cutover\` runs it again, \`aster migrate rollback\` undoes it"
  elif [ "$phase" = rolled-back ] && [ -n "$running" ]; then
    say "   the old appliance runs again after a rollback; \`aster migrate cutover\` tries again"
  elif [ -n "$running" ] && [ ! -f "$DRAFT" ]; then
    say "   aster migrate import"
    say "   (or, to start from Aster's own configuration and remove the old appliance in one go: aster migrate replace)"
  elif [ -n "$running" ]; then
    say "   read $MIG/import-report.txt and the draft, then: aster migrate cutover"
  elif [ "$phase" = cutover ]; then
    say "   Overview → Scan, then Assign each modem; check every call and SMS path; when it all works: aster migrate cleanup"
  elif [ -n "$existing" ] || [ "$any_image" -eq 1 ] || [ "$uid" = "$OLD_UID" ] || rename_present ||
    [ -f "$(host "$SOUND_RULE")" ] || [ -f "$(host "$MM_RULE")" ]; then
    say "   the old appliance is not running: when Aster has taken over, \`aster migrate cleanup\` removes what it left"
  else
    say "   nothing of the old appliance is left to migrate"
  fi

  [ "$CONFLICTS" -eq 0 ]
}

# ---- import -----------------------------------------------------------------------------------------------------

cmd_import() {
  need_root
  need_docker
  need_aster
  [ -d "$OLD_HOME/asterisk" ] || die "no $OLD_HOME/asterisk to import (--old-home names another place)"
  [ -f "$REPO/tools/import-old-registry.js" ] ||
    die "the checkout $REPO has no tools/import-old-registry.js — it looks incomplete"
  if [ -f "$DRAFT" ] && [ "$FORCE" -eq 0 ]; then
    die "$DRAFT is already there; --force replaces it (any edit made to it is lost)"
  fi
  ensure_mig

  local args=("$OLD_HOME/asterisk")
  if [ -d "$OLD_HOME/temp" ]; then
    args+=("$OLD_HOME/temp")
  else
    warn "no $OLD_HOME/temp: the importer cannot tell which driver each slot ran and assumes dongle — check both driver: lines"
  fi
  # The tools are not in the image (it ships the controller only), so the checkout's tools/ is mounted next to the
  # controller sources they import; the old home is mounted read-only at its own path, so the report names real paths.
  local status=0
  docker run --rm -v "$REPO/tools:/app/tools:ro" -v "$OLD_HOME:$OLD_HOME:ro" "$(controller_image)" \
    node tools/import-old-registry.js "${args[@]}" > "$DRAFT.tmp" 2> "$MIG/import-report.txt.tmp" || status=$?
  if [ "$status" -ne 0 ]; then
    cat "$MIG/import-report.txt.tmp" >&2
    rm -f "$DRAFT.tmp" "$MIG/import-report.txt.tmp"
    die "the import failed (exit $status); nothing was written"
  fi
  chmod 600 "$DRAFT.tmp" "$MIG/import-report.txt.tmp"
  mv -f "$DRAFT.tmp" "$DRAFT"
  mv -f "$MIG/import-report.txt.tmp" "$MIG/import-report.txt"
  cat "$MIG/import-report.txt"
  say ""
  say "migrate.sh: the draft is $DRAFT (the report above is $MIG/import-report.txt)."
  say "Nothing is installed yet. Read every assumption, edit the draft if one is wrong, then: aster migrate cutover"
}

# ---- cutover ----------------------------------------------------------------------------------------------------

cmd_cutover() {
  need_root
  need_docker
  need_aster
  local phase
  phase=$(state_get phase)
  if [ "$phase" = cutover ]; then
    say "migrate.sh: the cutover was done already ($(state_get at)); \`aster migrate rollback\` undoes it"
    return 0
  fi
  [ "$phase" != cleaned ] || die "the migration is finished and cleaned up; there is nothing to cut over"
  [ -f "$OLD_COMPOSE" ] || rename_present || die "no old appliance at $OLD_HOME (--old-home names another place)"
  if [ "$KEEP_REGISTRY" -eq 0 ]; then
    [ -f "$DRAFT" ] || die "no draft registry: run \`aster migrate import\` first, or --keep-registry to keep $REGISTRY as it is"
    step "the draft registry"
    validate_registry "$DRAFT" || die "the controller refuses $DRAFT (above); fix it — nothing was changed"
    ok "$DRAFT is a registry the controller accepts"
  fi

  local running
  running=$(old_running)
  say ""
  say "The cutover will:"
  if rename_present; then say "  - move the old Quectel sound-card rename aside, into $MOVED"; fi
  if [ -n "$running" ]; then
    say "  - copy the old SMS history, then stop $(printf '%s ' $running)— calls in progress drop"
  fi
  if [ "$KEEP_REGISTRY" -eq 0 ]; then
    say "  - install $DRAFT as $REGISTRY (the current one is kept as $BEFORE) and regenerate aster.d"
  else
    say "  - keep $REGISTRY as it is"
  fi
  say "  - restart Aster and check that its SIP transport is up"
  say "\`aster migrate rollback\` undoes all of it."
  confirm "Cut over now?"

  step "1/6 backup of Aster"
  backup_aster
  set_phase cutover-started

  step "2/6 the old Quectel sound-card rename"
  move_rename_aside

  step "3/6 the old SMS history"
  copy_sms_history

  step "4/6 stop the old appliance"
  stop_old_containers

  step "5/6 the registry"
  if [ "$KEEP_REGISTRY" -eq 0 ]; then
    # A cutover that stopped half-way is run again from the top, and by then the registry in place may already be the
    # draft: the copy taken the first time is the one that matters.
    if [ "$phase" != cutover-started ] || [ ! -f "$BEFORE" ]; then
      if [ -f "$REGISTRY" ]; then install -m 600 "$REGISTRY" "$BEFORE"; did "kept the previous registry as $BEFORE"; fi
    fi
    install_registry "$DRAFT"
    did "installed the draft as $REGISTRY"
    regenerate || die "aster.d could not be generated from the new registry (above) — \`aster migrate rollback\` puts everything back"
  else
    ok "kept $REGISTRY"
  fi
  retrigger_sound_cards

  step "6/6 restart Aster"
  aster_compose restart
  wait_for_health || warn "the controller does not answer after ${HEALTH_TIMEOUT}s; \`aster doctor\` says why"
  if ! wait_for_sip; then
    set_phase cutover
    die "Aster's Asterisk has no SIP transport on 5060 after 60 s: something still holds the port (ss -lunp 'sport = :5060'). \`aster migrate rollback\` brings the old appliance back"
  fi
  ok "SIP transport up on 5060"
  local endpoints
  endpoints=$(docker exec aster-asterisk asterisk -rx 'pjsip show endpoints' 2>/dev/null | sed -n 's/^Objects found: //p' | tail -1 || true)
  ok "pjsip endpoints: ${endpoints:-0}"

  set_phase cutover
  say ""
  say "Aster carries the calls now. Still to do, in this order:"
  say "  1. Overview → Scan, then Assign each modem: that fills usb_port, and a modem stays stopped until it is set"
  say "  2. check that the phones registered (same host, same port — they need no change)"
  say "  3. check every call and SMS path; while any of them fails, \`aster migrate rollback\` brings the old appliance back"
  say "  4. when it all works: aster migrate cleanup"
}

# ---- rollback ---------------------------------------------------------------------------------------------------

cmd_rollback() {
  need_root
  need_docker
  need_aster
  local phase
  phase=$(state_get phase)
  case $phase in
    cutover|cutover-started) ;;
    rolled-back) say "migrate.sh: rolled back already ($(state_get at))"; return 0 ;;
    cleaned) die "the old appliance was cleaned up (its containers and images are gone); there is nothing to roll back to" ;;
    *) die "no cutover by \`aster migrate\` on this host, so nothing to roll back (undo it by hand)" ;;
  esac

  say "The rollback will:"
  say "  - stop Aster"
  if [ -f "$BEFORE" ]; then say "  - put back the registry from before the cutover (the current one is kept as $MIG/aster.yaml.at-rollback)"; fi
  say "  - start the old appliance and put its Quectel sound-card rename back"
  confirm "Roll back now?"

  step "1/4 stop Aster"
  aster_compose stop
  did "stopped Aster"

  step "2/4 the registry"
  if [ -f "$BEFORE" ]; then
    if [ -f "$REGISTRY" ]; then install -m 600 "$REGISTRY" "$MIG/aster.yaml.at-rollback"; fi
    install_registry "$BEFORE"
    did "put back the registry from before the cutover"
    regenerate || warn "aster.d could not be regenerated; it is written again by the next install.sh or apply"
  else
    ok "the cutover kept the registry, so it stays"
  fi

  step "3/4 start the old appliance"
  start_old_containers

  step "4/4 the old Quectel sound-card rename"
  put_rename_back

  set_phase rolled-back
  say ""
  local aster_port
  aster_port=$(env_value ASTER_HTTP_PORT)
  if [ "${aster_port:-80}" = "$OLD_WEBUI_PORT" ] && [ -n "$(old_containers | grep -x "$OLD_WEBUI" || true)" ]; then
    say "The old appliance carries the calls again, and its web UI has port $OLD_WEBUI_PORT back (it starts the old modems about"
    say "45 s after it starts). Aster is stopped: to run it beside the old one, \`docker stop $OLD_WEBUI\`, then \`aster restart\`"
    say "(no SIP and no modems until the next cutover)."
  else
    say "The old appliance carries the calls again. Aster is stopped: \`aster restart\` starts it beside the old one"
    say "(no SIP and no modems until the next cutover)."
  fi
}

# ---- cleanup ----------------------------------------------------------------------------------------------------

cmd_cleanup() {
  need_root
  need_docker
  local phase running
  phase=$(state_get phase)
  running=$(old_running)
  [ -z "$running" ] || die "the old appliance is running ($(printf '%s ' $running)): cut over first (aster migrate cutover)"
  case $phase in
    rolled-back) die "the last step was a rollback: cleanup would remove the appliance the host went back to" ;;
    cutover-started) die "the cutover stopped half-way: run \`aster migrate cutover\` again, or \`aster migrate rollback\`" ;;
  esac
  if ! container_running aster-asterisk; then
    [ "$FORCE" -eq 1 ] || die "Aster's Asterisk is not running: clean up only once Aster has taken over (--force to do it anyway)"
  fi

  survey_old_appliance
  say "The cleanup will remove:"
  local anything=0
  if rename_present; then say "  - the old Quectel sound-card rename (moved into $MOVED)"; anything=1; fi
  if say_removals; then anything=1; fi
  say "Kept: $OLD_HOME (the only copy of the old configuration) and $MIG."
  if [ "$anything" -eq 0 ]; then
    set_phase cleaned
    say "migrate.sh: nothing of the old appliance is left to remove"
    return 0
  fi
  confirm "Remove these now?"

  remove_old_appliance
  set_phase cleaned
  say ""
  say "The old appliance is gone from this host. One thing is still yours to do: rotate the"
  say "Telegram bot token (Settings) and the SIP secrets (Phones) — the old ones are in the old repository's history."
}

# ---- replace ----------------------------------------------------------------------------------------------------

# cutover --keep-registry and cleanup in one. Nothing is removed until the controller answers and SIP is up on 5060,
# so a failure before that leaves the old appliance only stopped (rollback brings it back).
cmd_replace() {
  need_root
  need_docker
  need_aster
  local phase running
  phase=$(state_get phase)
  case $phase in
    cleaned) say "migrate.sh: the old appliance was removed already ($(state_get at)); there is nothing to replace"; return 0 ;;
    cutover) die "the cutover was done already ($(state_get at)): \`aster migrate cleanup\` removes the old appliance" ;;
    cutover-started) die "the cutover stopped half-way: run \`aster migrate cutover\` again, or \`aster migrate rollback\`" ;;
  esac
  [ -f "$OLD_COMPOSE" ] || rename_present || die "no old appliance at $OLD_HOME (--old-home names another place)"

  survey_old_appliance
  running=$(old_running)
  # Only the old home left (cleanup keeps it): restarting Aster would drop calls to change nothing.
  if [ -z "$running" ] && ! rename_present && ! say_removals >/dev/null; then
    set_phase cleaned
    say "migrate.sh: nothing of the old appliance is left on this host but $OLD_HOME, so there is nothing to replace"
    return 0
  fi
  say ""
  say "The replace will:"
  if rename_present; then say "  - move the old Quectel sound-card rename aside, into $MOVED"; fi
  if [ -n "$running" ]; then say "  - copy the old SMS history, then stop $(printf '%s ' $running)— calls in progress drop"; fi
  say "  - keep Aster's registry as it is: nothing of the old configuration is imported"
  say "  - restart Aster and check that it answers and that its SIP transport is up"
  say "and only then remove for good:"
  say_removals || say "  - nothing: no other part of the old appliance is on this host"
  say "Kept: $OLD_HOME (the only copy of the old configuration) and $MIG."
  if [ -f "$DRAFT" ]; then say "The draft $DRAFT from \`aster migrate import\` is not used; \`aster migrate cutover\` is what installs it."; fi
  say "There is no rollback once the removal has started. To keep one until every call and SMS path is checked, run"
  say "\`aster migrate cutover --keep-registry\` instead, and \`aster migrate cleanup\` afterwards."
  confirm "Replace the old appliance now?"

  step "1/5 backup of Aster"
  backup_aster
  set_phase cutover-started

  step "2/5 the old Quectel sound-card rename"
  move_rename_aside

  step "3/5 stop the old appliance"
  copy_sms_history
  stop_old_containers
  retrigger_sound_cards

  step "4/5 restart Aster"
  aster_compose restart
  if ! wait_for_health; then
    set_phase cutover
    die "the controller does not answer after ${HEALTH_TIMEOUT}s, so nothing was removed: \`aster doctor\` says why, \`aster migrate rollback\` brings the old appliance back"
  fi
  ok "the controller answers"
  if ! wait_for_sip; then
    set_phase cutover
    die "Aster's Asterisk has no SIP transport on 5060 after 60 s, so nothing was removed: something still holds the port (ss -lunp 'sport = :5060'). \`aster migrate rollback\` brings the old appliance back"
  fi
  ok "SIP transport up on 5060"
  set_phase cutover

  step "5/5 remove the old appliance"
  remove_old_appliance
  set_phase cleaned

  say ""
  say "Aster has replaced the old appliance and runs on its own configuration. Still to do:"
  say "  1. Overview → Scan, then Assign each modem: that fills usb_port, and a modem stays stopped until it is set"
  say "  2. the phones: Aster's, not the old sip.conf — a desk phone registers once its number and password match the"
  say "     Phones page (a fresh install has 501–515, each with its own number as the password: change those)"
  say "  3. Settings: the Telegram bot token and the chat ids. A bot the old appliance used has its token in the old"
  say "     repository's history, so give it a new one (@BotFather, /revoke)"
  say "$OLD_HOME is kept; delete it yourself once nothing in it is needed."
}

case $COMMAND in
  check) cmd_check ;;
  import) cmd_import ;;
  cutover) cmd_cutover ;;
  rollback) cmd_rollback ;;
  cleanup) cmd_cleanup ;;
  replace) cmd_replace ;;
esac
