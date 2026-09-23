#!/usr/bin/env bash
# Aster — update: take a backup, get the new images, restart into them, then check.
#
# Usage: update.sh [--home DIR] [--build|--pull] [--yes] [--force]
#   --home    the appliance's data (default: data/ in the checkout this script is in)
#   --build   rebuild the images from the checkout this script is in (git pull first when it is a git working tree)
#   --pull    pull the images named in the appliance's .env
#             (default: ASTER_IMAGE_SOURCE in .env, which install.sh writes; build when .env does not say)
#   --yes     do not ask; the Asterisk image changing means its container is recreated and **active calls drop**
#   --force   update without the backup, which only a running controller can write
#
# It never touches config/, state/ or the registry. The backup is the way back: an older controller refuses a database
# a newer one has migrated.
set -euo pipefail

# The checkout is the one this file is in; the home is data/ inside it unless --home names another one.
SELF=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(CDPATH='' cd -- "$SELF/../.." && pwd)
HOME_DIR="$REPO/data"
MODE=''
ASSUME_YES=0
FORCE=0

while [ $# -gt 0 ]; do
  case $1 in
    --home) HOME_DIR=${2:?--home needs a directory}; shift 2 ;;
    --home=*) HOME_DIR=${1#*=}; shift ;;
    --build) MODE=build; shift ;;
    --pull) MODE=pull; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'update.sh: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

ENV_FILE=${ASTER_ENV_FILE:-$REPO/.env}
# Fallback: .env in the home (older installs).
[ -f "$ENV_FILE" ] || [ ! -f "$HOME_DIR/.env" ] || ENV_FILE="$HOME_DIR/.env"
COMPOSE_FILE="$REPO/docker-compose.yml"
[ -f "$ENV_FILE" ] || { printf 'update.sh: no %s — is this an Aster host? (--home names another home)\n' "$ENV_FILE" >&2; exit 1; }

compose() { ASTER_REPO=$REPO ASTER_HOME=$HOME_DIR docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

[ -n "$MODE" ] || MODE=$(value ASTER_IMAGE_SOURCE)
[ -n "$MODE" ] || MODE=build

if [ "$ASSUME_YES" -eq 0 ]; then
  printf 'An update recreates the containers whose image changed. If that is the Asterisk one, calls in progress drop.\n'
  printf 'Asterisk is also restarted when the new controller generates aster.d differently than the files on disk.\n'
  printf 'Continue? [y/N] '
  read -r answer
  case $answer in y|Y|yes|YES) ;; *) printf 'update.sh: nothing was done\n'; exit 0 ;; esac
fi

if [ "$FORCE" -eq 1 ]; then
  printf '\n== backup skipped (--force)\n'
else
  printf '\n== backup first\n'
  "$SELF/backup.sh" --home "$HOME_DIR" || {
    printf 'update.sh: nothing was updated; aster update --force updates without a backup\n' >&2
    exit 1
  }
fi

printf '\n== images (%s)\n' "$MODE"
if [ "$MODE" = pull ]; then
  compose pull
else
  # `git pull` replaces files rather than rewriting them, so this running script keeps its own version.
  if [ -d "$REPO/.git" ] && command -v git >/dev/null 2>&1; then
    printf '   git pull in %s\n' "$REPO"
    # git has already said why it failed (no fast-forward, no network, dubious ownership).
    git -C "$REPO" pull --ff-only || printf 'update.sh: git pull failed (git says why above); the images are built from the checkout as it is\n' >&2
  fi
  compose build
fi

# Regenerate aster.d with the new image (as install.sh step 4b does), so generator changes apply without an edit;
# an Asterisk container that `up -d` keeps is restarted to load them.
printf '\n== generated configuration (aster.d)\n'
NS=$(value ASTER_IMAGE_NS); NS=${NS:-sheepsticked}
VERSION=$(value ASTER_VERSION); VERSION=${VERSION:-latest}
written=''
if generated=$(docker run --rm -e ASTER_HOME=/srv/aster -v "$HOME_DIR/config:/srv/aster/config" \
    "$NS/aster-controller:$VERSION" node packages/controller/bin/generate.js 2>&1); then
  printf '%s\n' "$generated" | sed 's/^/   /'
  written=$(printf '%s' "$generated" | sed -n 's/^generate\.js: \([0-9]\{1,\}\) of [0-9]\{1,\} file(s) written.*$/\1/p' | tail -1)
else
  printf '%s\n' "$generated" | sed 's/^/   /' >&2
  printf 'update.sh: aster.d was not regenerated (the generator says why above); the files on disk are kept\n' >&2
fi
asterisk_before=$(docker inspect -f '{{.Id}}' aster-asterisk 2>/dev/null || true)

printf '\n== restart into the new images\n'
compose up -d --remove-orphans
case $written in
  ''|0) ;;
  *)
    if [ -n "$asterisk_before" ] && [ "$(docker inspect -f '{{.Id}}' aster-asterisk 2>/dev/null || true)" = "$asterisk_before" ]; then
      printf '   %s generated file(s) changed and the Asterisk container was kept: restarting it to load them\n' "$written"
      compose restart asterisk
    fi
    ;;
esac

# `up -d` returns before the controller serves: wait for the API (as install.sh does), then let doctor report.
printf '\n== wait for the controller\n'
HTTP_PORT=$(value ASTER_HTTP_PORT)
HTTP_PORT=${HTTP_PORT:-80}   # the controller's own default (src/env.js)
waited=0
while [ "$waited" -lt 120 ]; do
  body=''
  if command -v curl >/dev/null 2>&1; then body=$(curl -fsS --max-time 5 "http://127.0.0.1:$HTTP_PORT/api/health" 2>/dev/null || true)
  elif command -v wget >/dev/null 2>&1; then body=$(wget -qO- --timeout=5 "http://127.0.0.1:$HTTP_PORT/api/health" 2>/dev/null || true)
  else body=$(docker exec aster-controller node -e "fetch('http://127.0.0.1:$HTTP_PORT/api/health').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))" 2>/dev/null || true)
  fi
  case $body in
    *'"status":"'*) printf '   the controller answers after %ss\n' "$waited"; break ;;
  esac
  sleep 2
  waited=$((waited + 2))
done
[ "$waited" -lt 120 ] || printf '   the controller still does not answer after %ss; doctor says what is wrong\n' "$waited"

printf '\n== doctor\n'
# No write-rate sample here: `aster doctor` measures it when asked.
"$SELF/doctor.sh" --home "$HOME_DIR" --write-seconds 0
