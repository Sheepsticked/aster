#!/usr/bin/env bash
# Aster — tests for install/bin/migrate.sh: check, import, cutover, rollback and cleanup against a scratch host.
#
# Host paths live under ASTER_SYSTEM_ROOT and docker, systemctl, udevadm etc. are recording stubs, so it runs without
# root, Docker or an old appliance. The real importer, generator and SIP transport are only exercised on a real host.
#
# Usage: bash test/install/migrate.test.sh
set -uo pipefail

REPO=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
SNAPSHOT="$REPO/packages/controller/test/tools/snapshots/aster.yaml"
WORK=$(mktemp -d)
# migrate.sh finds the backup script and the importer in its own checkout, so it runs from a scratch one: a copy of it,
# a stub backup.sh beside it, and an importer the docker stub stands in for.
CHECKOUT="$WORK/checkout"
MIGRATE="$CHECKOUT/install/bin/migrate.sh"
ROOT="$WORK/root"
HOME_DIR="$WORK/srv/aster"
OLD="$WORK/srv/asterisk"
FAKE="$WORK/fake"
STUBS="$WORK/bin"
failed=0
ran=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

check() {
  ran=$((ran + 1))
  if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s], got [%s]\n' "$1" "$3" "$2" >&2; failed=$((failed + 1)); fi
}
has() {
  ran=$((ran + 1))
  if grep -qF -- "$3" <<< "$2"; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: no [%s] in:\n%s\n' "$1" "$3" "$2" >&2; failed=$((failed + 1)); fi
}
exists() { if [ -e "$1" ]; then printf yes; else printf no; fi; }
state_of() { cat "$FAKE/containers/$1" 2>/dev/null || printf absent; }
phase() { sed -n 's/^phase=//p' "$HOME_DIR/migrate/state" 2>/dev/null | tail -1; }
# The line number of the first log entry matching the extended regex $1 (0 when there is none), for order assertions.
at() { local n; n=$(grep -nE -- "$1" "$FAKE/log" | head -1 | cut -d: -f1); printf '%s' "${n:-0}"; }
before() {
  local a b
  a=$(at "$2"); b=$(at "$3")
  ran=$((ran + 1))
  if [ "${a:-0}" -gt 0 ] && [ "${b:-0}" -gt 0 ] && [ "$a" -lt "$b" ]; then printf 'ok   %s\n' "$1"
  else printf 'FAIL %s: [%s] at line %s, [%s] at line %s\n' "$1" "$2" "${a:-0}" "$3" "${b:-0}" >&2; failed=$((failed + 1)); fi
}
run() {
  : > "$FAKE/log"
  PATH="$STUBS:$PATH" FAKE="$FAKE" SNAPSHOT="$SNAPSHOT" ASTER_SYSTEM_ROOT="$ROOT" ASTER_HEALTH_TIMEOUT=4 \
    bash "$MIGRATE" --home "$HOME_DIR" --old-home "$OLD" "$@" 2>&1
}

# ---- the stubs --------------------------------------------------------------------------------------------------

mkdir -p "$STUBS" "$FAKE/containers" "$FAKE/images" "$FAKE/files/asterisk"
cat > "$STUBS/docker" <<'STUB'
#!/usr/bin/env bash
F=$FAKE
printf 'docker %s\n' "$*" >> "$F/log"
state() { cat "$F/containers/$1" 2>/dev/null; }
last=${!#}
case $1 in
  info) ;;
  ps) for c in "$F"/containers/*; do if [ -f "$c" ] && [ "$(cat "$c")" = running ]; then basename "$c"; fi; done ;;
  container) [ "$2" = inspect ] && [ -f "$F/containers/$last" ] || { echo; echo "Error response from daemon: No such container: $last" >&2; exit 1; }
    cat "$F/containers/$last" ;;
  inspect) echo 'a plain inspect also matches an image of the same name' >&2; exit 3 ;;
  stop) shift; for c in "$@"; do echo exited > "$F/containers/$c"; done ;;
  start) shift; for c in "$@"; do echo running > "$F/containers/$c"; done ;;
  rm) shift; [ "$1" != -f ] || shift; for c in "$@"; do rm -f "$F/containers/$c"; done ;;
  cp)
    c=${2%%:*}; file="$F/files/$c/$(basename "${2#*:}")"
    [ -f "$F/containers/$c" ] && [ -f "$file" ] || { echo "Error response from daemon: Could not find the file" >&2; exit 1; }
    cp "$file" "$3" ;;
  exec)
    [ "$(state "$2")" = running ] || exit 1
    case $last in
      'pjsip show transports')
        if [ "$(state asterisk)" = running ] || [ -f "$F/port-taken" ]; then echo 'No objects found.'
        else echo 'Transport:  transport-udp             udp      0      0  0.0.0.0:5060'; fi ;;
      'pjsip show endpoints') echo 'Objects found: 15' ;;
    esac ;;
  image)
    [ -f "$F/images/$last" ] || exit 1
    case $2 in inspect) echo '[{}]' ;; ls) cat "$F/images/$last" ;; rm) rm -f "$F/images/$last" ;; esac ;;
  compose)
    case " $* " in
      *' restart '*) echo running > "$F/containers/aster-asterisk"; echo running > "$F/containers/aster-controller" ;;
      *' stop '*) echo exited > "$F/containers/aster-asterisk"; echo exited > "$F/containers/aster-controller" ;;
      *' up -d --no-build '*) for c in asterisk asterisk-webui smtp-py-telegram; do echo running > "$F/containers/$c"; done ;;
    esac ;;
  run)
    case " $* " in
      *import-old-registry.js*) cat "$SNAPSHOT"; echo 'wrote a registry with 2 modem(s) and 15 phone(s)' >&2 ;;
      *generate.js*) echo 'generate.js: 5 of 5 file(s) written into /srv/aster/config/asterisk/aster.d' ;;
      *registry.js*)
        file=$(printf '%s\n' "$@" | sed -n 's#^\(.*\):/tmp/aster.yaml:ro$#\1#p')
        if grep -q BROKEN "$file"; then echo 'modems[0].imei: must be 15 digits' >&2; exit 2; fi ;;
    esac ;;
esac
STUB
cat > "$STUBS/systemctl" <<'STUB'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$FAKE/log"
case " $* " in *' is-active '*) [ -f "$FAKE/mm-active" ] ;; esac
STUB
cat > "$STUBS/udevadm" <<'STUB'
#!/usr/bin/env bash
printf 'udevadm %s\n' "$*" >> "$FAKE/log"
case $1 in info) if [ -f "$FAKE/mm-flag" ]; then echo 'ID_MM_DEVICE_IGNORE=1'; fi ;; esac
STUB
cat > "$STUBS/getent" <<'STUB'
#!/usr/bin/env bash
case $1 in
  passwd) [ -f "$FAKE/user" ] && echo 'asterisk:x:1456:1456::/home/asterisk:/usr/sbin/nologin' ;;
  group) [ -f "$FAKE/group" ] && echo 'asterisk:x:1456:' ;;
  *) exit 2 ;;
esac
STUB
cat > "$STUBS/userdel" <<'STUB'
#!/usr/bin/env bash
printf 'userdel %s\n' "$*" >> "$FAKE/log"; rm -f "$FAKE/user"
STUB
cat > "$STUBS/groupdel" <<'STUB'
#!/usr/bin/env bash
printf 'groupdel %s\n' "$*" >> "$FAKE/log"; rm -f "$FAKE/group"
STUB
printf '#!/bin/sh\necho %s\n' "'{\"status\":\"ok\"}'" > "$STUBS/curl"
printf '#!/bin/sh\n:\n' > "$STUBS/sleep"
chmod +x "$STUBS"/*

# ---- a host in the middle of a coexistence install --------------------------------------------------------------

# What the old role leaves on a host — its rename, its two rules, its containers running, its images and its user — beside
# a running Aster. Planted once here, and again for replace once cleanup has taken it all away.
old_appliance_on_host() {
  local c image
  printf 'ACTION=="add", SUBSYSTEM=="sound", KERNEL=="card[0-9]*", ATTRS{idVendor}=="2c7c", TAG+="systemd", ENV{SYSTEMD_WANTS}="quectel-audio@%%k.service"\n' \
    > "$ROOT/etc/udev/rules.d/90-quectel-audio.rules"
  printf '[Service]\nExecStart=/usr/local/sbin/quectel-audio.py %%I\n' > "$ROOT/etc/systemd/system/quectel-audio@.service"
  printf '#!/usr/bin/env python3\n' > "$ROOT/usr/local/sbin/quectel-audio.py"
  printf 'SUBSYSTEM=="sound", ACTION=="add", OWNER="asterisk", GROUP="audio", MODE="0660"\n' > "$ROOT/etc/udev/rules.d/99-asterisk-sound.rules"
  printf 'KERNEL=="ttyUSB*", ENV{ID_MM_PORT_IGNORE}="1"\n' > "$ROOT/etc/udev/rules.d/99-mm-ignore.rules"
  for c in asterisk asterisk-webui smtp-py-telegram aster-asterisk aster-controller; do echo running > "$FAKE/containers/$c"; done
  for image in sheepsticked/asterisk-dongle-quectel-rpi:latest asterisk-webui:latest smtp-py-telegram:latest; do
    mkdir -p "$(dirname "$FAKE/images/$image")"
    echo 1.48GB > "$FAKE/images/$image"
  done
  touch "$FAKE/user" "$FAKE/group"
}

mkdir -p "$ROOT/etc/udev/rules.d" "$ROOT/etc/systemd/system" "$ROOT/usr/local/sbin"
cp "$REPO/install/udev/90-aster.rules" "$ROOT/etc/udev/rules.d/"
old_appliance_on_host
rename_hash=$(cat "$ROOT/etc/udev/rules.d/90-quectel-audio.rules" "$ROOT/etc/systemd/system/quectel-audio@.service" "$ROOT/usr/local/sbin/quectel-audio.py" | md5sum)

# A Quectel on USB port 1-1 with one tty, and the name the old rename gave its sound card.
add_tty() {
  local tty=$1 port=$2 vendor=$3
  mkdir -p "$ROOT/sys/devices/usb1/$port/$port:1.2/$tty" "$ROOT/sys/class/tty/$tty"
  printf '%s\n' "$vendor" > "$ROOT/sys/devices/usb1/$port/idVendor"
  ln -s "$ROOT/sys/devices/usb1/$port/$port:1.2" "$ROOT/sys/class/tty/$tty/device"
}
add_tty ttyUSB0 1-1 2c7c
mkdir -p "$ROOT/sys/class/sound/card1"
printf 'quectel_7654321\n' > "$ROOT/sys/class/sound/card1/id"

mkdir -p "$OLD/asterisk" "$OLD/temp"
cp "$REPO/test/fixtures/old/docker-compose.yml" "$OLD/"
cp "$REPO"/test/fixtures/old/*.conf "$OLD/asterisk/"
cp "$REPO"/test/fixtures/old/temp/* "$OLD/temp/"
printf '01-09-2026 10:00:00 - hello\n' > "$FAKE/files/asterisk/sms_GSM.txt"
touch "$FAKE/mm-active" "$FAKE/mm-flag"

mkdir -p "$CHECKOUT/install/bin" "$CHECKOUT/tools"
cp "$REPO/install/bin/migrate.sh" "$MIGRATE"
: > "$CHECKOUT/tools/import-old-registry.js"
mkdir -p "$HOME_DIR/config" "$HOME_DIR/state"
printf 'ASTER_HTTP_PORT=18123\nASTER_IMAGE_NS=aster\nASTER_VERSION=dev\n' > "$CHECKOUT/.env"
cp "$REPO/install/templates/aster.yaml" "$HOME_DIR/config/aster.yaml"
starter_hash=$(md5sum < "$HOME_DIR/config/aster.yaml")
printf '#!/bin/sh\nprintf "backup.sh %%s\\n" "$*" >> "%s/log"\n' "$FAKE" > "$CHECKOUT/install/bin/backup.sh"
chmod +x "$CHECKOUT/install/bin/backup.sh"

tree_hash() { (cd "$WORK" && find root srv -printf '%m %p\n' | sort && find root srv -type f -exec md5sum {} + | sort) | md5sum; }

# ---- check ------------------------------------------------------------------------------------------------------

printf '== check, while both stacks run\n'
before_check=$(tree_hash)
out=$(run check); status=$?
check "check reports conflicts with exit 1" "$status" 1
has "the old rename is a conflict" "$out" 'CONFLICT  /etc/udev/rules.d/90-quectel-audio.rules'
has "the card named by the old rename is pointed out" "$out" 'card1 is named quectel_7654321'
has "Aster's missing SIP transport is explained by the old stack" "$out" 'port 5060 is taken (expected until the cutover)'
has "the 99-mm-ignore rule is a leftover, not a conflict" "$out" 'leftover  /etc/udev/rules.d/99-mm-ignore.rules'
has "the old user is a leftover" "$out" 'leftover  user asterisk (uid 1456)'
has "an old image is listed with the size docker image ls shows" "$out" 'leftover  image asterisk-webui:latest (1.48GB)'
has "ModemManager with the ignore flag on every modem port is fine" "$out" 'every modem port carries the ignore flag'
has "the next step is the import" "$out" 'aster migrate import'
has "or replace, for a host that wants none of the old configuration" "$out" 'aster migrate replace'
check "check wrote nothing" "$(tree_hash)" "$before_check"
check "check stopped, started or removed nothing" "$(grep -cE 'docker (stop|start|rm|compose)|systemctl daemon-reload|udevadm (control|trigger)' "$FAKE/log")" 0

# The old web UI listens on port 80. With Aster on that port it is a conflict (the old rename starts it again on a plug or
# a boot); stopped beside a running old Asterisk it is a note about the old modems, which only the web UI starts.
env_keep=$(cat "$CHECKOUT/.env")
printf 'ASTER_HTTP_PORT=80\nASTER_IMAGE_NS=aster\nASTER_VERSION=dev\n' > "$CHECKOUT/.env"
out=$(run check)
has "the old web UI on Aster's port is a conflict" "$out" "CONFLICT  container asterisk-webui is running and holds port 80, Aster's port: docker stop asterisk-webui"
echo exited > "$FAKE/containers/asterisk-webui"
out=$(run check)
has "a stopped web UI beside the running old Asterisk is a note about its modems" "$out" 'note      container asterisk-webui is stopped (Aster has port 80). It is what starts the old modems'
echo running > "$FAKE/containers/asterisk-webui"
printf '%s\n' "$env_keep" > "$CHECKOUT/.env"
out=$(run check)
has "on another port the running web UI is only a note" "$out" 'note      container asterisk-webui is running'

rm -f "$FAKE/mm-flag"
out=$(run check)
has "ModemManager without the flag on a modem port is a conflict" "$out" 'ModemManager is running and may open the modem ports: ttyUSB0'
touch "$FAKE/mm-flag"
cp "$HOME_DIR/config/aster.yaml" "$WORK/registry.keep"
printf 'modems:\n  - id: "gsm1"\n    usb_port: "1-1"\n' > "$HOME_DIR/config/aster.yaml"
out=$(run check)
has "a modem assigned in Aster while the old stack runs is a conflict" "$out" '1 modem(s) assigned in Aster while the old appliance runs'
cp "$WORK/registry.keep" "$HOME_DIR/config/aster.yaml"

# ---- import -----------------------------------------------------------------------------------------------------

printf '\n== import\n'
out=$(run import); status=$?
check "import succeeds" "$status" 0
check "the draft is the importer's output" "$(md5sum < "$HOME_DIR/migrate/aster.yaml")" "$(md5sum < "$SNAPSHOT")"
check "the draft is 0600 (it holds the SIP secrets)" "$(stat -c '%a' "$HOME_DIR/migrate/aster.yaml")" 600
check "migrate/ is 0700" "$(stat -c '%a' "$HOME_DIR/migrate")" 700
has "the report is kept" "$(cat "$HOME_DIR/migrate/import-report.txt")" 'wrote a registry with 2 modem(s)'
has "the importer read the old home read-only at its own path" "$(cat "$FAKE/log")" "-v $OLD:$OLD:ro"
check "the registry in use is not touched by an import" "$(md5sum < "$HOME_DIR/config/aster.yaml")" "$starter_hash"
printf '# edited by the operator\n' >> "$HOME_DIR/migrate/aster.yaml"
edited=$(md5sum < "$HOME_DIR/migrate/aster.yaml")
out=$(run import); status=$?
check "a second import without --force is refused" "$status" 1
check "and the edited draft survives it" "$(md5sum < "$HOME_DIR/migrate/aster.yaml")" "$edited"
out=$(run import --force); status=$?
check "--force replaces the draft" "$(md5sum < "$HOME_DIR/migrate/aster.yaml")" "$(md5sum < "$SNAPSHOT")"

# ---- cutover refusals -------------------------------------------------------------------------------------------

printf '\n== cutover refusals\n'
cp "$HOME_DIR/migrate/aster.yaml" "$WORK/draft.keep"
printf '# BROKEN\n' >> "$HOME_DIR/migrate/aster.yaml"
out=$(run cutover --yes); status=$?
check "a draft the controller refuses stops the cutover" "$status" 1
has "with the controller's reason" "$out" 'modems[0].imei: must be 15 digits'
check "before the old appliance is stopped" "$(state_of asterisk)" running
check "and before the rename is moved" "$(exists "$ROOT/etc/udev/rules.d/90-quectel-audio.rules")" yes
check "and no state is written" "$(phase)" ''
cp "$WORK/draft.keep" "$HOME_DIR/migrate/aster.yaml"

out=$(printf 'n\n' | run cutover); status=$?
check "answering no does nothing" "$status" 0
has "and says so" "$out" 'nothing was done'
check "the old Asterisk still runs" "$(state_of asterisk)" running

# ---- cutover ----------------------------------------------------------------------------------------------------

printf '\n== cutover\n'
out=$(run cutover --yes); status=$?
check "the cutover succeeds" "$status" 0
[ "$status" -eq 0 ] || printf '%s\n' "$out" >&2
for f in /etc/udev/rules.d/90-quectel-audio.rules /etc/systemd/system/quectel-audio@.service /usr/local/sbin/quectel-audio.py; do
  check "$f is gone from the host" "$(exists "$ROOT$f")" no
  check "$f is kept in migrate/host-files" "$(exists "$HOME_DIR/migrate/host-files$f")" yes
done
for c in asterisk asterisk-webui smtp-py-telegram; do check "$c is stopped" "$(state_of "$c")" exited; done
before "the web UI stops before the Asterisk it can restart" 'docker stop asterisk-webui$' 'docker stop asterisk$'
before "the backup is taken before anything is stopped" 'backup.sh' 'docker stop'
before "udev forgets the rename before the old stack stops" 'udevadm control --reload' 'docker stop'
before "the SMS history is copied before the stop" 'docker cp asterisk:/var/lib/asterisk/sms_GSM.txt' 'docker stop'
check "the SMS history is in state/old" "$(cat "$HOME_DIR/state/old/sms_GSM.txt")" '01-09-2026 10:00:00 - hello'
check "the SMS history is 0600" "$(stat -c '%a' "$HOME_DIR/state/old/sms_GSM.txt")" 600
check "the draft is the registry now" "$(md5sum < "$HOME_DIR/config/aster.yaml")" "$(md5sum < "$SNAPSHOT")"
check "the previous registry is kept" "$(md5sum < "$HOME_DIR/migrate/aster.yaml.before-cutover")" "$starter_hash"
before "aster.d is regenerated before the restart" 'generate.js' 'restart'
before "the sound cards are re-read so a Quectel gets its q_<port> name" 'udevadm trigger --subsystem-match=sound' 'restart'
has "SIP is checked after the restart" "$out" 'SIP transport up on 5060'
has "and the endpoints are counted" "$out" 'pjsip endpoints: 15'
check "the phase is cutover" "$(phase)" cutover

out=$(run check); status=$?
check "check after the cutover finds no conflict" "$status" 0
has "and points at Scan and Assign" "$out" 'Scan, then Assign each modem'
out=$(run cutover --yes); status=$?
check "a second cutover is a no-op" "$(grep -c 'docker stop' "$FAKE/log")" 0
has "that says so" "$out" 'the cutover was done already'

# ---- rollback ---------------------------------------------------------------------------------------------------

printf '\n== rollback\n'
out=$(run rollback --yes); status=$?
check "the rollback succeeds" "$status" 0
[ "$status" -eq 0 ] || printf '%s\n' "$out" >&2
check "Aster is stopped" "$(state_of aster-asterisk)" exited
check "the previous registry is back" "$(md5sum < "$HOME_DIR/config/aster.yaml")" "$starter_hash"
check "the migrated one is kept" "$(md5sum < "$HOME_DIR/migrate/aster.yaml.at-rollback")" "$(md5sum < "$SNAPSHOT")"
for c in asterisk asterisk-webui smtp-py-telegram; do check "$c runs again" "$(state_of "$c")" running; done
before "Asterisk starts before the web UI" 'docker start asterisk$' 'docker start asterisk-webui$'
check "the rename files are back, byte for byte" \
  "$(cat "$ROOT/etc/udev/rules.d/90-quectel-audio.rules" "$ROOT/etc/systemd/system/quectel-audio@.service" "$ROOT/usr/local/sbin/quectel-audio.py" | md5sum)" "$rename_hash"
before "the old stack is up before its rename service can run" 'docker start smtp-py-telegram' 'udevadm trigger --subsystem-match=sound'
check "the phase is rolled-back" "$(phase)" rolled-back
has "on another port Aster simply restarts beside the old appliance" "$out" '`aster restart` starts it beside the old one'

for c in asterisk asterisk-webui smtp-py-telegram; do echo exited > "$FAKE/containers/$c"; done
out=$(run cleanup --yes); status=$?
check "cleanup is refused right after a rollback, even with the old stack stopped" "$status" 1
has "because it would remove what the host went back to" "$out" 'the last step was a rollback'
check "and removes nothing" "$(state_of asterisk)" exited
for c in asterisk asterisk-webui smtp-py-telegram; do echo running > "$FAKE/containers/$c"; done

# ---- a cutover whose port stays taken, then a rollback from there -----------------------------------------------

printf '\n== a port that stays taken\n'
touch "$FAKE/port-taken"
out=$(run cutover --yes); status=$?
check "the cutover fails when SIP does not come up" "$status" 1
has "and says what to do" "$out" 'aster migrate rollback'
check "it leaves a state rollback can work from" "$(phase)" cutover
rm -f "$FAKE/port-taken"
env_keep=$(cat "$CHECKOUT/.env")
printf 'ASTER_HTTP_PORT=80\nASTER_IMAGE_NS=aster\nASTER_VERSION=dev\n' > "$CHECKOUT/.env"
out=$(run rollback --yes); status=$?
check "the rollback after it succeeds" "$status" 0
check "the old Asterisk runs again" "$(state_of asterisk)" running
has "with Aster on port 80 it says to stop the old web UI before Aster starts again" "$out" '`docker stop asterisk-webui`, then `aster restart`'
printf '%s\n' "$env_keep" > "$CHECKOUT/.env"

# ---- cutover keeping the registry -------------------------------------------------------------------------------

printf '\n== cutover --keep-registry\n'
rm -f "$HOME_DIR/migrate/aster.yaml"
out=$(run cutover --yes --keep-registry); status=$?
check "a cutover that keeps the registry needs no draft" "$status" 0
check "the registry stays as it was" "$(md5sum < "$HOME_DIR/config/aster.yaml")" "$starter_hash"
check "and nothing is regenerated" "$(grep -c 'generate.js' "$FAKE/log")" 0
has "the SMS history already copied is not copied twice" "$out" 'is already in'

# ---- cleanup ----------------------------------------------------------------------------------------------------

printf '\n== cleanup\n'
echo exited > "$FAKE/containers/aster-asterisk"
out=$(run cleanup --yes); status=$?
check "cleanup is refused while Aster's Asterisk is down" "$status" 1
echo running > "$FAKE/containers/aster-asterisk"

add_tty ttyUSB9 1-3 0403
out=$(run cleanup --yes); status=$?
check "cleanup succeeds" "$status" 0
[ "$status" -eq 0 ] || printf '%s\n' "$out" >&2
for c in asterisk asterisk-webui smtp-py-telegram; do check "container $c is removed" "$(state_of "$c")" absent; done
check "every old image is removed" "$(find "$FAKE/images" -type f | wc -l)" 0
check "99-asterisk-sound.rules is removed" "$(exists "$ROOT/etc/udev/rules.d/99-asterisk-sound.rules")" no
check "99-mm-ignore.rules is kept while another USB serial device is here" "$(exists "$ROOT/etc/udev/rules.d/99-mm-ignore.rules")" yes
has "and cleanup says why" "$out" 'another USB serial device is here ( ttyUSB9 )'
check "Aster's own rule stays" "$(exists "$ROOT/etc/udev/rules.d/90-aster.rules")" yes
check "the user is removed" "$(grep -c 'userdel asterisk' "$FAKE/log")" 1
check "the group is removed" "$(grep -c 'groupdel asterisk' "$FAKE/log")" 1
check "the old home is kept" "$(exists "$OLD/asterisk/sip.conf")" yes
check "the phase is cleaned" "$(phase)" cleaned
out=$(run check); status=$?
has "check says the migration is finished" "$out" 'the migration is finished'
has "and sees the removed containers as gone" "$out" 'ok        container asterisk is gone'
out=$(run rollback --yes); status=$?
check "there is no rollback after a cleanup" "$status" 1

# ---- a cutover done by hand, cleaned up afterwards ------------------------------------------

printf '\n== cleanup after a cutover done by hand\n'
rm -rf "$HOME_DIR/migrate" "$ROOT/sys/class/tty/ttyUSB9"
cp "$REPO/install/udev/90-aster.rules" "$ROOT/etc/udev/rules.d/90-quectel-audio.rules"
touch "$ROOT/etc/udev/rules.d/99-asterisk-sound.rules"
echo running > "$FAKE/containers/asterisk"
out=$(run cleanup --yes); status=$?
check "cleanup is refused while an old container runs" "$status" 1
has "and says to cut over first" "$out" 'the old appliance is running (asterisk )'
check "the rename rule is still there" "$(exists "$ROOT/etc/udev/rules.d/90-quectel-audio.rules")" yes
rm -f "$FAKE/containers/asterisk"
out=$(run cleanup --yes); status=$?
check "cleanup with no migration state succeeds" "$status" 0
check "a rename rule left behind is moved aside" "$(exists "$ROOT/etc/udev/rules.d/90-quectel-audio.rules")" no
check "into migrate/host-files" "$(exists "$HOME_DIR/migrate/host-files/etc/udev/rules.d/90-quectel-audio.rules")" yes
check "99-mm-ignore.rules goes once no other serial device needs it" "$(exists "$ROOT/etc/udev/rules.d/99-mm-ignore.rules")" no

# ---- replace ----------------------------------------------------------------------------------------------------

printf '\n== replace\n'
rm -rf "$HOME_DIR/migrate" "$HOME_DIR/state/old"
cp "$REPO/install/templates/aster.yaml" "$HOME_DIR/config/aster.yaml"
old_appliance_on_host

mkdir -p "$HOME_DIR/migrate"
printf 'phase=cutover\nat=2026-09-21T00:00:00Z\n' > "$HOME_DIR/migrate/state"
out=$(run replace --yes); status=$?
check "replace is refused after a cutover" "$status" 1
has "and points at cleanup instead" "$out" 'aster migrate cleanup'
check "and stops nothing" "$(state_of asterisk)" running
rm -rf "$HOME_DIR/migrate"

out=$(printf 'n\n' | run replace); status=$?
check "answering no to replace does nothing" "$status" 0
has "and says so" "$out" 'nothing was done'
has "the plan says nothing of the old configuration is imported" "$out" 'nothing of the old configuration is imported'
has "and that there is no rollback once the removal starts" "$out" 'There is no rollback once the removal has started'
check "the old Asterisk still runs" "$(state_of asterisk)" running
check "and no state is written" "$(phase)" ''

# The irreversible half waits for the reversible one: with SIP never up, nothing may be gone.
touch "$FAKE/port-taken"
out=$(run replace --yes); status=$?
check "replace fails when SIP does not come up" "$status" 1
has "and says nothing was removed" "$out" 'so nothing was removed'
for c in asterisk asterisk-webui smtp-py-telegram; do check "container $c is only stopped" "$(state_of "$c")" exited; done
check "no image is removed" "$(find "$FAKE/images" -type f | wc -l)" 3
check "the user is kept" "$(grep -c 'userdel' "$FAKE/log")" 0
check "99-asterisk-sound.rules is kept" "$(exists "$ROOT/etc/udev/rules.d/99-asterisk-sound.rules")" yes
check "the phase lets rollback work" "$(phase)" cutover
rm -f "$FAKE/port-taken"
out=$(run rollback --yes); status=$?
check "the rollback after a failed replace succeeds" "$status" 0
check "the old Asterisk runs again" "$(state_of asterisk)" running
check "the rename files are back, byte for byte" \
  "$(cat "$ROOT/etc/udev/rules.d/90-quectel-audio.rules" "$ROOT/etc/systemd/system/quectel-audio@.service" "$ROOT/usr/local/sbin/quectel-audio.py" | md5sum)" "$rename_hash"
check "the registry was never touched" "$(md5sum < "$HOME_DIR/config/aster.yaml")" "$starter_hash"

for c in aster-asterisk aster-controller; do echo running > "$FAKE/containers/$c"; done
printf '# a draft nobody installed\n' > "$HOME_DIR/migrate/aster.yaml"
out=$(run replace --yes); status=$?
check "replace succeeds" "$status" 0
[ "$status" -eq 0 ] || printf '%s\n' "$out" >&2
has "a draft from import is said to be unused" "$out" 'is not used'
check "the registry stays as it was" "$(md5sum < "$HOME_DIR/config/aster.yaml")" "$starter_hash"
check "and nothing is regenerated" "$(grep -c 'generate.js' "$FAKE/log")" 0
for c in asterisk asterisk-webui smtp-py-telegram; do check "container $c is removed" "$(state_of "$c")" absent; done
check "every old image is removed" "$(find "$FAKE/images" -type f | wc -l)" 0
for f in /etc/udev/rules.d/90-quectel-audio.rules /etc/systemd/system/quectel-audio@.service /usr/local/sbin/quectel-audio.py; do
  check "$f is gone from the host" "$(exists "$ROOT$f")" no
  check "$f is kept in migrate/host-files" "$(exists "$HOME_DIR/migrate/host-files$f")" yes
done
check "99-asterisk-sound.rules is removed" "$(exists "$ROOT/etc/udev/rules.d/99-asterisk-sound.rules")" no
check "99-mm-ignore.rules is removed with no other serial device here" "$(exists "$ROOT/etc/udev/rules.d/99-mm-ignore.rules")" no
check "Aster's own rule stays" "$(exists "$ROOT/etc/udev/rules.d/90-aster.rules")" yes
check "the user is removed" "$(grep -c 'userdel asterisk' "$FAKE/log")" 1
check "the group is removed" "$(grep -c 'groupdel asterisk' "$FAKE/log")" 1
check "the old home is kept" "$(exists "$OLD/asterisk/sip.conf")" yes
check "the SMS history is in state/old" "$(cat "$HOME_DIR/state/old/sms_GSM.txt")" '01-09-2026 10:00:00 - hello'
before "the backup is taken before anything is stopped" 'backup.sh' 'docker stop'
before "udev forgets the rename before the old stack stops" 'udevadm control --reload' 'docker stop'
before "the web UI stops before the Asterisk it can restart" 'docker stop asterisk-webui$' 'docker stop asterisk$'
before "the SMS history is copied before the stop" 'docker cp asterisk:/var/lib/asterisk/sms_GSM.txt' 'docker stop'
before "the sound cards are re-read before Aster restarts" 'udevadm trigger --subsystem-match=sound' 'restart'
before "no container is removed before SIP is checked" 'pjsip show transports' 'docker rm'
before "no image is removed before SIP is checked" 'pjsip show transports' 'docker image rm'
has "SIP is checked" "$out" 'SIP transport up on 5060'
has "the phones are pointed out, since the old ones were not imported" "$out" 'a desk phone registers once its number and password match'
check "the phase is cleaned" "$(phase)" cleaned
out=$(run rollback --yes); status=$?
check "there is no rollback after a replace" "$status" 1
out=$(run replace --yes); status=$?
check "a second replace changes nothing" "$status" 0
has "and says why" "$out" 'removed already'
out=$(run check); status=$?
has "check agrees the migration is finished" "$out" 'the migration is finished'

# A host cleaned up earlier (or by hand) has nothing left but the old home, which cleanup keeps.
rm -rf "$HOME_DIR/migrate"
out=$(run replace --yes); status=$?
check "replace on a host with only the old home left succeeds" "$status" 0
has "and says there is nothing to replace" "$out" 'there is nothing to replace'
check "without restarting Aster for nothing" "$(grep -c 'restart' "$FAKE/log")" 0

printf '\n%s/%s passed\n' "$((ran - failed))" "$ran"
[ "$failed" -eq 0 ] || exit 1
