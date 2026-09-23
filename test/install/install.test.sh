#!/usr/bin/env bash
# Aster — tests for install/install.sh: the tree it creates, ownership, modes, and that a second run changes nothing.
# Runs the real installer on temporary homes with --skip-up and a scratch ASTER_SYSTEM_ROOT; needs Docker for preflight.
#
# Usage: bash test/install/install.test.sh
set -uo pipefail

# Each case sets its own inputs; nothing the caller exported may leak in (and make a refusal case pass wrongly).
unset ASTER_ADMIN_PASSWORD ASTER_ADMIN_PASSWORD_FILE ASTER_ADMIN_PASSWORD_HASH ASTER_TELEGRAM_TOKEN \
      ASTER_TELEGRAM_TOKEN_FILE ASTER_AMI_SECRET ASTER_SESSION_KEY ASTER_HOME ASTER_HTTP_PORT \
      ASTER_IMAGE_NS ASTER_IMAGE_SOURCE ASTER_REPO ASTER_VERSION ASTER_ENV_FILE

# Each case names its own .env with ASTER_ENV_FILE so none writes into this checkout (the default is tested below).

# The build path, so the tests never depend on Docker Hub (--skip-up builds nothing unless a password needs the image).
export ASTER_IMAGE_SOURCE=build

REPO=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
INSTALL="$REPO/install/install.sh"
WORK=$(mktemp -d)
HOME_DIR="$WORK/srv/aster"
SYS="$WORK/system"
PASSWORD='a-long-enough-password'
failed=0
ran=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

check() {
  ran=$((ran + 1))
  if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s], got [%s]\n' "$1" "$3" "$2" >&2; failed=$((failed + 1)); fi
}
check_true() {
  ran=$((ran + 1))
  if [ "$2" = 0 ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1" >&2; failed=$((failed + 1)); fi
}
mode_of() { stat -c '%a' "$1"; }
exists() { if [ -e "$1" ]; then printf yes; else printf no; fi; }

run_installer() {
  ASTER_ADMIN_PASSWORD="$PASSWORD" ASTER_SYSTEM_ROOT="$SYS" \
    ASTER_ENV_FILE="$HOME_DIR/.env" "$INSTALL" --home "$HOME_DIR" --http-port 18099 --non-interactive --skip-up --sd-tuning 2>&1
}

command -v docker >/dev/null 2>&1 || { printf 'install.test.sh: docker is needed for preflight; skipping\n' >&2; exit 0; }
mkdir -p "$SYS"

printf '== first run\n'
first=$(run_installer)
first_status=$?
check_true "the first run succeeds" "$first_status"
[ "$first_status" -eq 0 ] || { printf '%s\n' "$first" >&2; exit 1; }

# ---- the tree, with its modes ----------------------------------------------------------------------

for dir in config config/asterisk config/asterisk/aster.d state state/prev state/asterisk spool spool/events spool/quarantine logs/asterisk; do
  ran=$((ran + 1))
  if [ -d "$HOME_DIR/$dir" ]; then printf 'ok   %s exists\n' "$dir"; else printf 'FAIL %s is missing\n' "$dir" >&2; failed=$((failed + 1)); fi
done
check "directories are 0755" "$(mode_of "$HOME_DIR/config")" '755'
check "backups/ is 0700 (it holds an archive with secrets.env)" "$(mode_of "$HOME_DIR/backups")" '700'
check "secrets.env is 0600" "$(mode_of "$HOME_DIR/config/secrets.env")" '600'
check "manager.conf is 0600" "$(mode_of "$HOME_DIR/config/asterisk/manager.conf")" '600'
check "a starter file is 0644" "$(mode_of "$HOME_DIR/config/asterisk/extensions.conf")" '644'
check "no host script is copied into the home (they run from the checkout)" "$(exists "$HOME_DIR/bin")$(exists "$HOME_DIR/docker-compose.yml")" 'nono'

# ---- secrets ----------------------------------------------------------------------------------------------------

for key in ASTER_AMI_SECRET ASTER_SESSION_KEY ASTER_ADMIN_PASSWORD_HASH; do
  ran=$((ran + 1))
  if grep -q "^$key=." "$HOME_DIR/config/secrets.env"; then printf 'ok   %s is set\n' "$key"; else printf 'FAIL %s is missing from secrets.env\n' "$key" >&2; failed=$((failed + 1)); fi
done
check "the hash is the scrypt format the controller stores" \
  "$(sed -n 's/^ASTER_ADMIN_PASSWORD_HASH=//p' "$HOME_DIR/config/secrets.env" | cut -d'$' -f2)" 'scrypt'
ran=$((ran + 1))
if grep -q "^TELEGRAM_BOT_TOKEN=" "$HOME_DIR/config/secrets.env"; then
  printf 'FAIL an empty Telegram token must not be written\n' >&2; failed=$((failed + 1))
else
  printf 'ok   no Telegram token line when none was given\n'
fi

# The AMI secret reaches manager.conf and nothing else.
ami_secret=$(sed -n 's/^ASTER_AMI_SECRET=//p' "$HOME_DIR/config/secrets.env")
ran=$((ran + 1))
if grep -q "^secret = $ami_secret$" "$HOME_DIR/config/asterisk/manager.conf"; then
  printf 'ok   manager.conf carries the generated AMI secret\n'
else
  printf 'FAIL manager.conf does not carry the AMI secret\n' >&2; failed=$((failed + 1))
fi
check "manager.conf binds AMI to loopback" "$(grep -c '^bindaddr = 127.0.0.1$' "$HOME_DIR/config/asterisk/manager.conf")" '1'
check "no placeholder is left in manager.conf" "$(grep -c '@ASTER_AMI_SECRET@' "$HOME_DIR/config/asterisk/manager.conf" || true)" '0'

# ---- the generated half exists before anything starts -----------------------------------------------------------

# Asterisk rejects a whole file whose #include target is missing, so the five generated files must exist before start.
for generated in globals.conf modems.conf phones.conf quectel-devices.conf dongle-devices.conf; do
  ran=$((ran + 1))
  if [ -f "$HOME_DIR/config/asterisk/aster.d/$generated" ]; then printf 'ok   aster.d/%s was generated\n' "$generated"; else printf 'FAIL aster.d/%s is missing\n' "$generated" >&2; failed=$((failed + 1)); fi
done
check "a generated file says who owns it" "$(head -1 "$HOME_DIR/config/asterisk/aster.d/globals.conf" | cut -c1-20)" '; GENERATED by aster'

# ---- host files: --sd-tuning is ignored, only the USB audio option and the containerd drop-in are written -------

# The run above passed --sd-tuning, which must write nothing under ASTER_SYSTEM_ROOT.
check "--sd-tuning writes nothing: the prefix holds only the USB audio option and the containerd drop-in" "$(find "$SYS" -type f | wc -l)" '2'
check "the step says it is not the installer's job" "$(printf '%s' "$first" | grep -c 'not done by the installer')" '1'
check "--sd-tuning is reported as ignored" "$(printf '%s' "$first" | grep -c 'accepted for compatibility and does nothing')" '1'
USB_AUDIO_CONF="$SYS/etc/modprobe.d/aster-snd-usb-audio.conf"
check "step 6b writes the modprobe option for snd_usb_audio" "$(exists "$USB_AUDIO_CONF")" 'yes'
check "the option turns the low-latency mode off" "$(grep -c '^options snd_usb_audio lowlatency=0$' "$USB_AUDIO_CONF" 2>/dev/null)" '1'
check "the modprobe file is 0644" "$(mode_of "$USB_AUDIO_CONF")" '644'
check "the file says why it is there" "$(grep -c 'Aster (install.sh)' "$USB_AUDIO_CONF")" '1'
check "the first run counts the modprobe file as a change" "$(printf '%s' "$first" | grep -c "changed: wrote $USB_AUDIO_CONF")" '1'
CONTAINERD_DROPIN="$SYS/etc/systemd/system/containerd.service.d/aster-tmpdir.conf"
check "step 6c writes containerd's drop-in" "$(exists "$CONTAINERD_DROPIN")" 'yes'
check "the drop-in gives containerd a TMPDIR in /run" "$(grep -c '^Environment=TMPDIR=/run/aster-containerd$' "$CONTAINERD_DROPIN" 2>/dev/null)" '1'
check "systemd creates that directory, and keeps it when containerd restarts" \
  "$(grep -cE '^(RuntimeDirectory=aster-containerd|RuntimeDirectoryPreserve=yes)$' "$CONTAINERD_DROPIN" 2>/dev/null)" '2'
check "the drop-in is 0644" "$(mode_of "$CONTAINERD_DROPIN")" '644'
check "the first run counts the drop-in as a change" "$(printf '%s' "$first" | grep -c "changed: wrote $CONTAINERD_DROPIN")" '1'

# ---- what the operator owns survives a second run ----------------------------------------------------------

printf '\n== the operator edits their configuration\n'
printf '\n[my-context]\nexten => s,1,Hangup()\n' >> "$HOME_DIR/config/asterisk/extensions.conf"
edited_hash=$(md5sum < "$HOME_DIR/config/asterisk/extensions.conf")
python3 - "$HOME_DIR/config/aster.yaml" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read().replace('modems: []', 'modems:\n  - id: gsm1\n    driver: quectel\n    imei: "867435040012345"\n    enabled: true')
open(path, 'w').write(text)
PY
registry_hash=$(md5sum < "$HOME_DIR/config/aster.yaml")
secrets_hash=$(md5sum < "$HOME_DIR/config/secrets.env")
modes_before=$(find "$HOME_DIR" -printf '%m %P\n' | sort | md5sum)

printf '\n== second run\n'
second=$(run_installer)
second_status=$?
check_true "the second run succeeds" "$second_status"
[ "$second_status" -eq 0 ] || { printf '%s\n' "$second" >&2; exit 1; }

# The registry gained a modem, so this run rewrites the generated half, and CHANGED must count it (the Ansible role's
# changed_when).
check "a registry change is counted, not silently applied" "$(printf '%s' "$second" | tail -1)" 'CHANGED=3'
check "the hand-owned extensions.conf keeps the operator's edit" "$(md5sum < "$HOME_DIR/config/asterisk/extensions.conf")" "$edited_hash"
check "the registry is not overwritten" "$(md5sum < "$HOME_DIR/config/aster.yaml")" "$registry_hash"
check "the secrets are not rotated" "$(md5sum < "$HOME_DIR/config/secrets.env")" "$secrets_hash"
check "no mode changed" "$(find "$HOME_DIR" -printf '%m %P\n' | sort | md5sum)" "$modes_before"

# The generated half follows the registry, which now has a modem: that is the controller's file, not the operator's.
ran=$((ran + 1))
if grep -q '^GSM1=Quectel/gsm1$' "$HOME_DIR/config/asterisk/aster.d/globals.conf"; then
  printf 'ok   the generated globals.conf followed the registry\n'
else
  printf 'FAIL aster.d/globals.conf does not carry the modem that was added\n' >&2; failed=$((failed + 1))
fi

# And with nothing edited in between, a run really is a no-op — the promise the whole script is built around.
printf '\n== third run, nothing edited\n'
third=$(run_installer)
third_status=$?
check_true "the third run succeeds" "$third_status"
check "a run that follows no change reports none (CHANGED=0)" "$(printf '%s' "$third" | tail -1)" 'CHANGED=0'
check "and still no mode changed" "$(find "$HOME_DIR" -printf '%m %P\n' | sort | md5sum)" "$modes_before"
check "the modprobe option is left alone once it is there" "$(printf '%s' "$third" | grep -c "unchanged $USB_AUDIO_CONF")" '1'

# ---- a refusal that must happen before anything is touched ------------------------------------------------------

printf '\n== preflight refuses what it cannot do\n'
bad_port=$(ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_ENV_FILE="$HOME_DIR/.env" "$INSTALL" --home "$HOME_DIR" --http-port 99999 --non-interactive --skip-up 2>&1 || true)
ran=$((ran + 1))
if printf '%s' "$bad_port" | grep -q 'between 1 and 65535'; then
  printf 'ok   an impossible port is refused by name\n'
else
  printf 'FAIL an impossible port must be refused: %s\n' "$bad_port" >&2; failed=$((failed + 1))
fi

# The controller runs as root in its container, so a port below 1024 is accepted (tested only when 80 is free here).
if ! (ss -ltn 2>/dev/null || true) | grep -qE '[:.]80[[:space:]]'; then
  low_port=$(ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_ENV_FILE="$WORK/low/.env" "$INSTALL" --home "$WORK/low" --http-port 80 --non-interactive --skip-up 2>&1)
  low_status=$?
  check_true "port 80 is accepted (the controller runs as root)" "$low_status"
  [ "$low_status" -eq 0 ] || printf '%s\n' "$low_port" >&2
  check "and it is the port the installed .env carries" "$(sed -n 's/^ASTER_HTTP_PORT=//p' "$WORK/low/.env" 2>/dev/null)" '80'
fi

# The old web UI (asterisk-webui) on Aster's port is stopped, and started again if something else holds the port.
# A busybox httpd stands in for it, only when this host has no container of that name.
if [ -z "$(docker ps -aq --filter 'name=^asterisk-webui$' 2>/dev/null)" ] && docker image inspect busybox >/dev/null 2>&1; then
  printf '\n== the old web UI on the port\n'
  webui_port=18094 other_port=18093
  stand_in() { docker run -d --init --network host --name "$1" busybox httpd -f -p "127.0.0.1:$2" >/dev/null; }
  port_listens() { (ss -ltn 2>/dev/null || true) | grep -qE "127\.0\.0\.1:$1[[:space:]]"; }
  if stand_in asterisk-webui "$webui_port"; then
    for _ in 1 2 3 4 5; do port_listens "$webui_port" && break; sleep 1; done
    webui_run=$(ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_ENV_FILE="$WORK/webui/.env" "$INSTALL" --home "$WORK/webui" --http-port "$webui_port" --non-interactive --skip-up 2>&1)
    webui_status=$?
    check_true "a port held by the old web UI does not stop the install" "$webui_status"
    [ "$webui_status" -eq 0 ] || printf '%s\n' "$webui_run" >&2
    check "the web UI is stopped" "$(docker container inspect -f '{{.State.Status}}' asterisk-webui 2>/dev/null)" 'exited'
    check "and the installer says so, as a change" "$(printf '%s' "$webui_run" | grep -c "changed: stopped the old web UI (asterisk-webui), which held port $webui_port")" '1'

    docker start asterisk-webui >/dev/null
    if stand_in aster-test-port-holder "$other_port"; then
      for _ in 1 2 3 4 5; do port_listens "$other_port" && break; sleep 1; done
      other_run=$(ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_ENV_FILE="$WORK/webui-other/.env" "$INSTALL" --home "$WORK/webui-other" --http-port "$other_port" --non-interactive --skip-up 2>&1)
      check "a port held by something else is still refused" "$?" '1'
      check "by name" "$(printf '%s' "$other_run" | grep -c 'in use by something other than the old web UI')" '1'
      check "and the web UI is running again" "$(docker container inspect -f '{{.State.Status}}' asterisk-webui 2>/dev/null)" 'running'
      check "nothing was installed" "$(exists "$WORK/webui-other/.env")" 'no'
    fi
  fi
  docker rm -f asterisk-webui aster-test-port-holder >/dev/null 2>&1 || true
fi

# A root-owned secrets.env this user cannot read must stop the run before anything is written, not be overwritten.
# A container chowns it (a mode of 000 on an own file is fixed by the installer); needs a non-root runner.
if [ "$(id -u)" -ne 0 ]; then
  secrets="$HOME_DIR/config/secrets.env"
  secrets_before=$(md5sum < "$secrets")
  if docker run --rm -v "$HOME_DIR/config:/c" busybox chown 0:0 /c/secrets.env >/dev/null 2>&1; then
    unreadable=$(ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_ENV_FILE="$HOME_DIR/.env" "$INSTALL" --home "$HOME_DIR" --http-port 18099 --non-interactive --skip-up 2>&1)
    unreadable_status=$?
    docker run --rm -v "$HOME_DIR/config:/c" busybox chown "$(id -u):$(id -g)" /c/secrets.env >/dev/null 2>&1
    ran=$((ran + 1))
    if [ "$unreadable_status" -ne 0 ] && printf '%s' "$unreadable" | grep -q 'this one cannot read it'; then
      printf 'ok   a root-owned secrets.env this user cannot read is refused, with the reason\n'
    else
      printf 'FAIL a root-owned secrets.env must be refused by name (status %s): %s\n' "$unreadable_status" "$unreadable" >&2; failed=$((failed + 1))
    fi
    check "and the secrets are untouched" "$(md5sum < "$secrets")" "$secrets_before"
  else
    printf 'skip a root-owned secrets.env: no busybox container could chown it\n'
  fi
fi

# An option that is not repeated comes from the installed .env, so a re-run never moves a configured appliance.
printf '\n== a re-run without the original flags leaves the appliance where it is\n'
rerun=$(ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_SYSTEM_ROOT="$SYS" ASTER_ENV_FILE="$HOME_DIR/.env" "$INSTALL" --home "$HOME_DIR" --non-interactive --skip-up 2>&1 || true)
check "the port is still the one it was installed with" "$(sed -n 's/^ASTER_HTTP_PORT=//p' "$HOME_DIR/.env")" '18099'
check "and that run changed nothing either" "$(printf '%s' "$rerun" | tail -1)" 'CHANGED=0'

# Switching a --build appliance (aster/aster-*:dev) to --pull must switch the image names too.
printf '\n== --pull on an appliance that was built locally\n'
switch_home="$WORK/switch"
image_names() { printf '%s:%s' "$(sed -n 's/^ASTER_IMAGE_NS=//p' "$1/.env")" "$(sed -n 's/^ASTER_VERSION=//p' "$1/.env")"; }

ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_SYSTEM_ROOT="$SYS" \
  ASTER_ENV_FILE="$switch_home/.env" "$INSTALL" --home "$switch_home" --http-port 18097 --non-interactive --skip-up --build >/dev/null 2>&1
check "a locally built appliance is on aster/…:dev" "$(image_names "$switch_home")" 'aster:dev'

# Without a usable Node, install.sh pulls the controller image by the resolved name; the locally built image is tagged
# under both names so this never reaches a registry.
aliases=''
if docker image inspect aster/aster-controller:dev >/dev/null 2>&1; then
  aliases='sheepsticked/aster-controller:latest registry.example:5000/aster-controller:v1'
  for alias in $aliases; do docker tag aster/aster-controller:dev "$alias" >/dev/null 2>&1 || true; done
fi

# The flag wins over ASTER_IMAGE_SOURCE in the environment, as --build/--pull always do.
ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_SYSTEM_ROOT="$SYS" ASTER_IMAGE_SOURCE=build \
  ASTER_ENV_FILE="$switch_home/.env" "$INSTALL" --home "$switch_home" --non-interactive --skip-up --pull >/dev/null 2>&1
check "--pull moves it to the published name and tag" "$(image_names "$switch_home")" 'sheepsticked:latest'

ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_SYSTEM_ROOT="$SYS" ASTER_IMAGE_NS=registry.example:5000 ASTER_VERSION=v1 \
  ASTER_ENV_FILE="$switch_home/.env" "$INSTALL" --home "$switch_home" --non-interactive --skip-up --pull >/dev/null 2>&1
check "a namespace and a tag given by hand still win" "$(image_names "$switch_home")" 'registry.example:5000:v1'

# Neither the flag nor the environment: the appliance's own .env decides, and nothing moves.
ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_SYSTEM_ROOT="$SYS" ASTER_IMAGE_SOURCE='' \
  ASTER_ENV_FILE="$switch_home/.env" "$INSTALL" --home "$switch_home" --non-interactive --skip-up >/dev/null 2>&1
check "and a re-run that says nothing keeps them" "$(image_names "$switch_home")" 'registry.example:5000:v1'
for alias in $aliases; do docker image rm "$alias" >/dev/null 2>&1 || true; done

no_password=$(ASTER_SYSTEM_ROOT="$SYS" ASTER_ENV_FILE="$WORK/empty/.env" "$INSTALL" --home "$WORK/empty" --http-port 18099 --non-interactive --skip-up 2>&1 || true)
ran=$((ran + 1))
if printf '%s' "$no_password" | grep -q 'ASTER_ADMIN_PASSWORD'; then
  printf 'ok   a non-interactive run without a password says which variable to set\n'
else
  printf 'FAIL a non-interactive run without a password must name ASTER_ADMIN_PASSWORD: %s\n' "$no_password" >&2; failed=$((failed + 1))
fi

# ---- both secrets can be handed over in a file instead of the environment -----------------------------------
# The Ansible role passes them this way: `ansible-playbook -vvv` prints a task's environment.
printf '\n== the admin password and the Telegram token from a file\n'
FILE_HOME="$WORK/from-file"
pw_file="$WORK/password"
token_file="$WORK/token"
( umask 077; printf '%s\n' "$PASSWORD" > "$pw_file"; printf '%s\n' '123456:a-bot-token' > "$token_file" )
from_file=$(ASTER_ADMIN_PASSWORD_FILE="$pw_file" ASTER_TELEGRAM_TOKEN_FILE="$token_file" ASTER_SYSTEM_ROOT="$SYS" \
  ASTER_ENV_FILE="$FILE_HOME/.env" "$INSTALL" --home "$FILE_HOME" --http-port 18098 --non-interactive --skip-up 2>&1)
from_file_status=$?
check_true "an install whose secrets come from files succeeds" "$from_file_status"
[ "$from_file_status" -eq 0 ] || printf '%s\n' "$from_file" >&2
check "the password in the file became the scrypt hash the controller stores" \
  "$(sed -n 's/^ASTER_ADMIN_PASSWORD_HASH=\(\$scrypt\$\).*/\1/p' "$FILE_HOME/config/secrets.env")" '$scrypt$'
# The newline that ends the line in the file is not part of the secret.
check "the token is stored exactly as the file's first line" \
  "$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$FILE_HOME/config/secrets.env")" '123456:a-bot-token'

empty_file="$WORK/empty-password"
: > "$empty_file"
empty_run=$(ASTER_ADMIN_PASSWORD_FILE="$empty_file" ASTER_SYSTEM_ROOT="$SYS" \
  ASTER_ENV_FILE="$WORK/empty-file-home/.env" "$INSTALL" --home "$WORK/empty-file-home" --http-port 18097 --non-interactive --skip-up 2>&1 || true)
ran=$((ran + 1))
if printf '%s' "$empty_run" | grep -q "is empty"; then
  printf 'ok   an empty password file is refused by name\n'
else
  printf 'FAIL an empty password file must be refused: %s\n' "$empty_run" >&2; failed=$((failed + 1))
fi
check "and no hash was written before it stopped" \
  "$(grep -c '^ASTER_ADMIN_PASSWORD_HASH=' "$WORK/empty-file-home/config/secrets.env" 2>/dev/null || true)" '0'

missing_run=$(ASTER_ADMIN_PASSWORD_FILE="$WORK/no-such-file" ASTER_SYSTEM_ROOT="$SYS" \
  ASTER_ENV_FILE="$WORK/missing-file-home/.env" "$INSTALL" --home "$WORK/missing-file-home" --http-port 18097 --non-interactive --skip-up 2>&1 || true)
ran=$((ran + 1))
if printf '%s' "$missing_run" | grep -q 'cannot read the admin password file'; then
  printf 'ok   a password file that is not there is refused by name\n'
else
  printf 'FAIL a missing password file must be refused by name: %s\n' "$missing_run" >&2; failed=$((failed + 1))
fi

# ---- the appliance is the folder the checkout is in ----------------------------------------------------------------

# Without --home the data goes into data/ of the installer's own checkout. A scratch checkout stands in: install/ is
# copied (the scripts find their checkout from their own path) and the rest is linked.
printf '\n== without --home, the home is data/ in the checkout\n'
CHECKOUT="$WORK/elsewhere/aster"
mkdir -p "$CHECKOUT"
cp -r "$REPO/install" "$CHECKOUT/install"
for part in packages tools docker node_modules package.json package-lock.json; do
  if [ -e "$REPO/$part" ]; then ln -s "$REPO/$part" "$CHECKOUT/$part"; fi
done

not_installed=$(bash "$CHECKOUT/install/bin/aster" status 2>&1 || true)
ran=$((ran + 1))
if printf '%s' "$not_installed" | grep -qF "no $CHECKOUT/.env"; then
  printf 'ok   before an install, aster looks for the .env of its own checkout\n'
else
  printf 'FAIL aster must look for the .env of its own checkout: %s\n' "$not_installed" >&2; failed=$((failed + 1))
fi

entries_before=$(ls -A "$CHECKOUT" | LC_ALL=C sort | tr '\n' ' ')
default_home=$(ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_SYSTEM_ROOT="$SYS" \
  "$CHECKOUT/install/install.sh" --http-port 18096 --non-interactive --skip-up 2>&1)
default_home_status=$?
check_true "an install without --home succeeds" "$default_home_status"
[ "$default_home_status" -eq 0 ] || printf '%s\n' "$default_home" >&2
check "the secrets are in data/ of that checkout" "$(exists "$CHECKOUT/data/config/secrets.env")" 'yes'
check "the .env is beside the compose file, where compose reads it by itself" "$(exists "$CHECKOUT/.env")" 'yes'
check "and data/ and that .env are all that is added to the checkout" \
  "$(ls -A "$CHECKOUT" | LC_ALL=C sort | tr '\n' ' ')" ".env data $entries_before"
check ".env names that checkout" "$(sed -n 's/^ASTER_REPO=//p' "$CHECKOUT/.env")" "$CHECKOUT"
check ".env names that home" "$(sed -n 's/^ASTER_HOME=//p' "$CHECKOUT/.env")" "$CHECKOUT/data"

# An appliance installed when the .env still lived in the home keeps its settings: the next run moves the file.
mkdir -p "$WORK/old-layout/data"
cp -r "$REPO/install" "$WORK/old-layout/install"
for part in packages tools docker node_modules package.json package-lock.json docker-compose.yml; do
  if [ -e "$REPO/$part" ]; then ln -s "$REPO/$part" "$WORK/old-layout/$part"; fi
done
printf 'ASTER_HTTP_PORT=18094\nASTER_IMAGE_SOURCE=build\nASTER_IMAGE_NS=aster\nASTER_VERSION=dev\n' \
  > "$WORK/old-layout/data/.env"
ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_SYSTEM_ROOT="$SYS" \
  "$WORK/old-layout/install/install.sh" --non-interactive --skip-up >/dev/null 2>&1
check "an .env left in the home moves beside the compose file" \
  "$(exists "$WORK/old-layout/.env")$(exists "$WORK/old-layout/data/.env")" 'yesno'
check "and the port it was installed with comes with it" \
  "$(sed -n 's/^ASTER_HTTP_PORT=//p' "$WORK/old-layout/.env")" '18094'
check "the checkout's .gitignore keeps data/ out of git" "$(grep -cx '/data/' "$REPO/.gitignore")" '1'

# A colon splits a compose volume and a quote breaks the aster command, so such a path is refused before anything is
# written rather than installed half-working.
colon_run=$(ASTER_ADMIN_PASSWORD=$PASSWORD ASTER_ENV_FILE="$WORK/a:b/.env" "$INSTALL" --home "$WORK/a:b" --http-port 18095 --non-interactive --skip-up 2>&1 || true)
ran=$((ran + 1))
if printf '%s' "$colon_run" | grep -q 'cannot run from a path' && [ ! -e "$WORK/a:b" ]; then
  printf 'ok   a home with a colon in its path is refused before anything is written\n'
else
  printf 'FAIL a home with a colon must be refused up front: %s\n' "$colon_run" >&2; failed=$((failed + 1))
fi

# ---- the host scripts as an operator meets them -----------------------------------------------------------------

# Preflight needs Docker Engine 25 and compose 2.20.2; versions compare by parts (2.9 < 2.20), suffixes ignored.
printf '\n== the version comparison of preflight\n'
version_check() {
  bash -c "$(sed -n '/^version_at_least()/,/^}/p' "$INSTALL")"'
    if version_at_least "$1" "$2"; then echo yes; else echo no; fi' _ "$1" "$2"
}
check "Engine 29.1.3 is 25 or newer" "$(version_check 29.1.3 25)" 'yes'
check "Engine 25.0.0 is 25 or newer" "$(version_check 25.0.0 25)" 'yes'
check "Engine 24.0.9 is not" "$(version_check 24.0.9 25)" 'no'
check "Engine 20.10.24+dfsg1 is not" "$(version_check 20.10.24+dfsg1 25)" 'no'
check "compose 2.40.3+ds1-0ubuntu1~24.04.1 is 2.20.2 or newer" "$(version_check 2.40.3+ds1-0ubuntu1~24.04.1 2.20.2)" 'yes'
check "compose 2.20.2 itself is" "$(version_check 2.20.2 2.20.2)" 'yes'
check "compose 2.20.1 is not" "$(version_check 2.20.1 2.20.2)" 'no'
check "compose 2.9.0 is not (by parts, not as text)" "$(version_check 2.9.0 2.20.2)" 'no'
check "compose 5.0.0 is" "$(version_check 5.0.0 2.20.2)" 'yes'

# An old engine stops the install before anything is written; for the distribution's docker.io the message says how
# to replace it. Fake docker and dpkg-query stand in.
printf '\n== an engine older than 25 is refused, with the way out\n'
mkdir -p "$WORK/old-docker/bin"
printf '#!/bin/sh\ncase $1 in info) exit 0 ;; version) echo 20.10.24+dfsg1 ;; *) exit 1 ;; esac\n' > "$WORK/old-docker/bin/docker"
printf '#!/bin/sh\n[ "$FAKE_DOCKER_IO" = 1 ] && printf "install ok installed"\nexit 0\n' > "$WORK/old-docker/bin/dpkg-query"
chmod +x "$WORK/old-docker/bin/docker" "$WORK/old-docker/bin/dpkg-query"
old_engine() {
  FAKE_DOCKER_IO=$1 PATH="$WORK/old-docker/bin:$PATH" ASTER_ENV_FILE="$WORK/old-docker/.env" \
    "$INSTALL" --home "$WORK/old-docker/home" --http-port 18097 --non-interactive --skip-up 2>&1
}
debian_run=$(old_engine 1); debian_status=$?
check "the distribution's docker.io 20.10 stops the install" "$debian_status" '1'
check "and the message says how to replace it" \
  "$(printf '%s' "$debian_run" | grep -c "Replace the distribution's docker.io.*apt-get remove docker.io docker-compose containerd runc.*--install-docker")" '1'
check "nothing was written before it" "$(exists "$WORK/old-docker/home")$(exists "$WORK/old-docker/.env")" 'nono'
other_run=$(old_engine 0)
check "another old engine is told to upgrade" "$(printf '%s' "$other_run" | grep -c 'Docker Engine 20.10.24+dfsg1 is too old: Aster needs 25 or newer (upgrade Docker)')" '1'

# Each usage() prints its header comment by line range; a range one line too long would print code.
printf '\n== the help of every script is help and nothing else\n'
for script_help in "$REPO/install/install.sh -h" "$REPO/install/bin/aster help" "$REPO/install/bin/backup.sh --help" \
  "$REPO/install/bin/update.sh --help" "$REPO/install/bin/doctor.sh --help" "$REPO/install/bin/migrate.sh --help"; do
  # shellcheck disable=SC2086  # the command and its flag are meant to split
  help_text=$(bash $script_help 2>&1 || true)
  name=$(basename "${script_help%% *}")
  ran=$((ran + 1))
  if printf '%s' "$help_text" | grep -qE '^(set -euo pipefail|[A-Z_]+=|[a-z_]+\(\))'; then
    printf 'FAIL %s prints shell code below its usage text: %s\n' "$name" \
      "$(printf '%s' "$help_text" | grep -nE '^(set -euo pipefail|[A-Z_]+=|[a-z_]+\(\))' | head -2)" >&2
    failed=$((failed + 1))
  else
    printf 'ok   %s --help stops at the end of its comment block\n' "$name"
  fi
done

# The host's Node runs the controller's tools only when the checkout's dependencies are installed (a bare clone cannot
# import `yaml`); tested against a complete checkout and a bare one.
if command -v node >/dev/null 2>&1; then
  printf '\n== the host Node is used only when it can really run the checkout tools\n'
  node_usable() {
    REPO=$1 NODE_MAJOR=24 bash -c '
      have() { command -v "$1" >/dev/null 2>&1; }
      '"$(sed -n '/^local_node_usable()/,/^}/p' "$INSTALL")"'
      local_node_usable'
  }
  if [ -d "$REPO/node_modules" ]; then
    ran=$((ran + 1))
    if node_usable "$REPO"; then
      printf 'ok   a checkout with its dependencies installed is used directly\n'
    else
      printf 'FAIL this checkout has node_modules and a new enough Node, so it should be usable\n' >&2; failed=$((failed + 1))
    fi
  else
    printf 'skip a checkout with its dependencies installed (this one has no node_modules)\n'
  fi
  mkdir -p "$WORK/bare-checkout/packages/controller/src/config"
  cp "$REPO/packages/controller/src/config/registry.js" "$WORK/bare-checkout/packages/controller/src/config/registry.js"
  ran=$((ran + 1))
  if node_usable "$WORK/bare-checkout"; then
    printf 'FAIL a checkout with no node_modules must not be used: its tools cannot import yaml\n' >&2; failed=$((failed + 1))
  else
    printf 'ok   a checkout with no dependencies falls back to the image\n'
  fi
fi

# The /usr/local/bin/aster launcher (root only, so rendered here from install.sh for a scratch checkout whose aster
# only echoes): it runs that checkout's install/bin/aster with the installed home, and says so when the folder is gone.
printf '\n== the aster command install.sh writes\n'
launcher_checkout="$WORK/launcher checkout"
mkdir -p "$launcher_checkout/install/bin"
printf '#!/bin/sh\nprintf "home=%%s args=%%s\\n" "$ASTER_HOME" "$*"\n' > "$launcher_checkout/install/bin/aster"
chmod +x "$launcher_checkout/install/bin/aster"
REPO="$launcher_checkout" HOME_DIR="$WORK/launcher home" bash -c \
  "$(sed -n '/^aster_wrapper_content()/,/^}/p' "$INSTALL")"'
  aster_wrapper_content' > "$WORK/aster-launcher"
chmod +x "$WORK/aster-launcher"
check "it runs install/bin/aster of its checkout with the installed home" \
  "$("$WORK/aster-launcher" doctor --write-seconds 0 2>&1)" "home=$WORK/launcher home args=doctor --write-seconds 0"
check "ASTER_HOME still points it at another home" "$(ASTER_HOME=/elsewhere "$WORK/aster-launcher" status 2>&1)" 'home=/elsewhere args=status'
rm -rf "$launcher_checkout"
moved=$("$WORK/aster-launcher" status 2>&1)
moved_status=$?
ran=$((ran + 1))
if [ "$moved_status" -ne 0 ] && printf '%s' "$moved" | grep -q 'was Aster moved'; then
  printf 'ok   a checkout that is gone is named, with what to do\n'
else
  printf 'FAIL a launcher whose checkout is gone must say so (status %s): %s\n' "$moved_status" "$moved" >&2; failed=$((failed + 1))
fi

# A home that is not there must name ASTER_HOME: exec'ing a missing path would only say "No such file or directory".
for sub in doctor backup update migrate; do
  ran=$((ran + 1))
  wrong_home=$(ASTER_HOME="$WORK/not-an-aster-home" bash "$REPO/install/bin/aster" "$sub" 2>&1 || true)
  if printf '%s' "$wrong_home" | grep -q 'ASTER_HOME names another home'; then
    printf 'ok   aster %s on a home that is not there names ASTER_HOME\n' "$sub"
  else
    printf 'FAIL aster %s must say which home it looked in: %s\n' "$sub" "$wrong_home" >&2; failed=$((failed + 1))
  fi
done

# A backup that cannot be taken (no controller) stops the update before any image; --force skips it. A fake docker
# stands in and fails at the pull.
printf '\n== aster update without a backup\n'
mkdir -p "$WORK/update/bin" "$WORK/update/home"
printf 'ASTER_IMAGE_SOURCE=pull\n' > "$WORK/update/.env"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n[ "$1" = ps ] && exit 0\nexit 1\n' "$WORK/update/docker.log" \
  > "$WORK/update/bin/docker"
chmod +x "$WORK/update/bin/docker"
update_run() {
  PATH="$WORK/update/bin:$PATH" ASTER_ENV_FILE="$WORK/update/.env" \
    bash "$REPO/install/bin/update.sh" --home "$WORK/update/home" --yes "$@" 2>&1
}
no_backup=$(update_run); no_backup_status=$?
check "a backup that cannot be taken stops the update" "$no_backup_status" '1'
check "and says that --force updates without one" "$(printf '%s' "$no_backup" | grep -c 'aster update --force updates without a backup')" '1'
check "and no image is touched" "$(grep -c 'compose' "$WORK/update/docker.log")" '0'
forced=$(update_run --force)
check "--force skips the backup" "$(printf '%s' "$forced" | grep -c '^== backup skipped (--force)$')" '1'
check "and goes on to the images" "$(grep -c 'compose.* pull$' "$WORK/update/docker.log")" '1'

# Install and update run doctor without its write-rate sample; `aster doctor` alone takes it.
for script in "$INSTALL" "$REPO/install/bin/update.sh"; do
  calls=$(grep -c '/doctor.sh" --home' "$script" || true)
  quiet=$(grep -c '/doctor.sh" --home "$HOME_DIR" --write-seconds 0' "$script" || true)
  check "$(basename "$script") runs doctor without the write-rate sample" "$calls/$quiet" '1/1'
done

# ---- the Ansible role is a wrapper, so it must not drift away from what it wraps ----------------------------
# Every option and variable the role passes must exist in install.sh, and the line it parses must be the one printed.
printf '\n== the Ansible role and the installer still fit together\n'
ROLE="$REPO/install/ansible/roles/aster/tasks/main.yml"
for flag in --non-interactive --home --http-port --build --pull --install-docker --rebuild --skip-up --sd-tuning --no-sd-tuning; do
  ran=$((ran + 1))
  if grep -qE "^[[:space:]]*${flag}[)=|]" "$INSTALL"; then
    printf 'ok   install.sh still takes %s\n' "$flag"
  else
    printf 'FAIL the role can pass %s, which install.sh no longer takes\n' "$flag" >&2; failed=$((failed + 1))
  fi
done
for var in ASTER_VERSION ASTER_IMAGE_NS ASTER_ADMIN_PASSWORD_FILE ASTER_TELEGRAM_TOKEN_FILE; do
  ran=$((ran + 1))
  if grep -q "$var" "$ROLE" && grep -q "$var" "$INSTALL"; then
    printf 'ok   %s is set by the role and read by the installer\n' "$var"
  else
    printf 'FAIL %s is not in both install/install.sh and the role\n' "$var" >&2; failed=$((failed + 1))
  fi
done
ran=$((ran + 1))
if grep -q "CHANGED=\[0-9\]" "$ROLE" && [ "$(tail -1 "$INSTALL")" = 'say "CHANGED=$CHANGED"' ]; then
  printf 'ok   the last line of install.sh is the CHANGED line the role matches on\n'
else
  printf 'FAIL install.sh must end in the CHANGED line the role parses (role: %s)\n' \
    "$(grep -n 'CHANGED=' "$ROLE" | head -1)" >&2; failed=$((failed + 1))
fi
# install.sh owns the appliance tree: the role may only write to the source checkout and its temporary secret files,
# and never use `synchronize` (a mirroring task with delete can wipe configuration).
ran=$((ran + 1))
bad_dest=$(grep -nE '^[[:space:]]*dest:' "$ROLE" | grep -v 'aster_repo_dest' | grep -v '_file\.path' || true)
# The module, not the word: the comment above the tasks says the role does not use it, and must not match itself.
if [ -z "$bad_dest" ] && ! grep -qE '^[[:space:]]*-?[[:space:]]*([a-z_.]+\.)?synchronize:' "$ROLE"; then
  printf 'ok   the role writes only to the source checkout and its own temporary files\n'
else
  printf 'FAIL the role writes where install.sh is the only writer: %s\n' \
    "${bad_dest:-it uses synchronize}" >&2; failed=$((failed + 1))
fi

printf '\n%s/%s passed\n' "$((ran - failed))" "$ran"
[ "$failed" -eq 0 ] || exit 1
