#!/usr/bin/env bash
# Aster — the stack on a hardware test host, in Docker only: the production compose file plus the end-to-end overlay
# (test/e2e/compose.e2e.yaml), with a home built from install/templates and a given registry.
# Nothing is installed on the host: no ModemManager udev rule, no Quectel UAC card naming, no `aster` wrapper.
#
# Usage (on the host, from an unpacked checkout):
#   test/hardware/stack.sh up   --home DIR --registry FILE [--images TAG] [--port 80] [--password PW]
#   test/hardware/stack.sh down --home DIR
#   test/hardware/stack.sh logs --home DIR
# The controller runs as the user who runs this script (it owns the home); bin/passwd.js and bin/generate.js run inside
# the controller image, so nothing of the project runs on the host itself.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cmd=${1:-}
shift || true
# The controller runs as the invoking user, and an unprivileged process in a container gets no
# CAP_NET_BIND_SERVICE, so port 80 is only bindable when this runs as root.
if [ "$(id -u)" -eq 0 ]; then DEFAULT_PORT=80; else DEFAULT_PORT=8080; fi
HOME_DIR="" REGISTRY="" TAG=${ASTER_VERSION:-dev} PORT=${ASTER_HTTP_PORT:-$DEFAULT_PORT} PASSWORD=${ASTER_E2E_PASSWORD:-a-long-enough-password}
TG_PORT=${ASTER_E2E_TELEGRAM_PORT:-8090} PROJECT=aster-hw IMAGE_NS=${ASTER_IMAGE_NS:-aster}
while [ $# -gt 0 ]; do
  case $1 in
    --home) HOME_DIR=${2:?}; shift 2 ;;
    --registry) REGISTRY=${2:?}; shift 2 ;;
    --images) TAG=${2:?}; shift 2 ;;
    --port) PORT=${2:?}; shift 2 ;;
    --password) PASSWORD=${2:?}; shift 2 ;;
    *) echo "stack.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$HOME_DIR" ] || { echo "stack.sh: --home DIR is required" >&2; exit 2; }
die() { printf 'stack.sh: %s\n' "$*" >&2; exit 1; }
compose() {
  docker compose -p "$PROJECT" --project-directory "$ROOT" --env-file "$HOME_DIR/.env" \
    -f "$ROOT/docker-compose.yml" -f "$ROOT/test/e2e/compose.e2e.yaml" "$@"
}
in_controller() {  # a controller tool, in the image, as the home's owner
  docker run --rm -u "$(id -u):$(id -g)" -e ASTER_HOME=/srv/aster "$@"
}

case $cmd in
  down)
    [ -f "$HOME_DIR/.env" ] || die "no $HOME_DIR/.env"
    compose down -v --remove-orphans
    ;;
  logs)
    compose logs --tail 100
    ;;
  up)
    [ -n "$REGISTRY" ] && [ -f "$REGISTRY" ] || die "--registry FILE is required (the aster.yaml to start from)"
    docker image inspect "$IMAGE_NS/aster-asterisk:$TAG" "$IMAGE_NS/aster-controller:$TAG" >/dev/null 2>&1 || die "no $IMAGE_NS/aster-{asterisk,controller}:$TAG images"
    if [ -e "$HOME_DIR" ] && [ ! -f "$HOME_DIR/.aster-hw" ]; then die "$HOME_DIR exists and was not made by this script"; fi
    rm -rf "$HOME_DIR"
    mkdir -p "$HOME_DIR"/{config/asterisk/aster.d,state/asterisk,state/prev,spool/events,logs/asterisk,backups}
    : > "$HOME_DIR/.aster-hw"
    # The production starter files (install/templates), not the test-config: this is the real thing on real modems.
    for src in "$ROOT"/install/templates/asterisk/*.conf; do cp "$src" "$HOME_DIR/config/asterisk/"; done
    ami_secret=$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')
    sed "s|@ASTER_AMI_SECRET@|$ami_secret|" "$ROOT/install/templates/asterisk/manager.conf.tmpl" > "$HOME_DIR/config/asterisk/manager.conf"
    chmod 600 "$HOME_DIR/config/asterisk/manager.conf"
    cp "$REGISTRY" "$HOME_DIR/config/aster.yaml"
    ( umask 077; printf 'ASTER_AMI_SECRET=%s\nTELEGRAM_BOT_TOKEN=1234567890:hw-fake-token_of-the-bot-api-stand-in\n' "$ami_secret" > "$HOME_DIR/config/secrets.env" )
    in_controller -e ASTER_ADMIN_PASSWORD="$PASSWORD" -v "$HOME_DIR:/srv/aster" "$IMAGE_NS/aster-controller:$TAG" node packages/controller/bin/passwd.js >/dev/null
    grep -q '^ASTER_ADMIN_PASSWORD_HASH=\$scrypt\$' "$HOME_DIR/config/secrets.env" || die "no password hash was written"
    # The generated half has to exist before Asterisk starts (a missing include rejects the whole file).
    in_controller -v "$HOME_DIR:/srv/aster" "$IMAGE_NS/aster-controller:$TAG" node packages/controller/bin/generate.js
    cat > "$HOME_DIR/.env" <<EOF
ASTER_VERSION=$TAG
ASTER_IMAGE_NS=$IMAGE_NS
ASTER_IMAGE_SOURCE=build
ASTER_HTTP_PORT=$PORT
ASTER_REPO=$ROOT
ASTER_HOME=$HOME_DIR
ASTER_E2E_USER=$(id -u):$(id -g)
ASTER_E2E_TELEGRAM_PORT=$TG_PORT
EOF
    compose up -d --wait --wait-timeout 240
    docker ps --filter "name=aster-e2e-" --format '{{.Names}}: {{.Status}}'
    for attempt in $(seq 60); do
      health=$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
      case $health in *'"status":"ok"'*'"state":"up"'*) break ;; esac
      [ "$attempt" -lt 60 ] || { echo "$health"; die "no ok health with the AMI up within 60 s"; }
      sleep 1
    done
    echo "up: http://127.0.0.1:$PORT (AMI 127.0.0.1:5038, fake Bot API 127.0.0.1:$TG_PORT, inspection $((TG_PORT + 1)))"
    ;;
  *)
    sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
