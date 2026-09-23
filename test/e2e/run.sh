#!/usr/bin/env bash
# Aster — the virtual end-to-end run: the whole stack up on this machine, driven through
# AMI Originate and the browser, proving the paths that need no modem.
#
# What it does, in order:
#   1. builds an appliance home from docker/asterisk/test-config (the hand-owned files), test/e2e/aster.yaml (the
#      test-config registry plus a Telegram recipient), the production manager.conf template with a fresh AMI secret,
#      and secrets.env with the admin password (bin/passwd.js) and a bot token for the fake Bot API;
#   2. builds the two images (unless --no-build), then `compose up -d --wait` with the production compose file under
#      test/e2e/compose.e2e.yaml — its own project name, no restart, the fake Telegram as a third service;
#   3. measures the idle write budget with the stack up and nothing happening: the two
#      containers' own writes (their cgroups) are held to the budget, the host's disk is reported;
#   4. runs the five flows (test/e2e/flows/run.js);
#   5. runs the browser smoke (test/e2e/ui.spec.js) in the phone and desktop projects;
#   6. tears the stack down with its volumes (unless --keep) and keeps the container logs in test/e2e/logs/.
#
# Usage: test/e2e/run.sh [--home DIR] [--no-build] [--keep] [--skip-ui] [--skip-flows] [--skip-budget]
#                        [--ui-in-docker] [--budget-seconds N]
#   --home DIR         the appliance home to create (default $ASTER_E2E_HOME, else ${TMPDIR:-/tmp}/aster-e2e); it is
#                      emptied first, which is why it must not exist yet or be a home this script made
#   --no-build         use the aster/{asterisk,controller}:dev images that are there instead of building them
#   --keep             leave the stack running for a look (stop it with: test/e2e/run.sh --down)
#   --down             stop and remove a stack left with --keep, then exit
#   --skip-ui, --skip-flows, --skip-budget
#                      leave a part out (a quicker turnaround while working on another)
#   --ui-in-docker     run Playwright in mcr.microsoft.com/playwright (for a host without the browser libraries)
#   --budget-seconds N the idle window measured (default 60), after --budget-settle N seconds (default 40: the kernel
#                      writes the pages the start-up dirtied back within 30 s, and they are not idle writes)
# Env: ASTER_HTTP_PORT (80 as root, else 8080), ASTER_E2E_TELEGRAM_PORT (8090; the inspection API is on the next port),
#      ASTER_E2E_PASSWORD (the admin password), ASTER_VERSION/ASTER_IMAGE_NS (the image tag, default dev / aster)
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
E2E=$ROOT/test/e2e
HOME_DIR=${ASTER_E2E_HOME:-${TMPDIR:-/tmp}/aster-e2e}
# The controller runs as the invoking user, and an unprivileged process in a container gets no
# CAP_NET_BIND_SERVICE, so port 80 is only bindable when this runs as root.
if [ "$(id -u)" -eq 0 ]; then DEFAULT_PORT=80; else DEFAULT_PORT=8080; fi
PORT=${ASTER_HTTP_PORT:-$DEFAULT_PORT}
TG_PORT=${ASTER_E2E_TELEGRAM_PORT:-8090}
PASSWORD=${ASTER_E2E_PASSWORD:-a-long-enough-password}
VERSION=${ASTER_VERSION:-dev}
IMAGE_NS=${ASTER_IMAGE_NS:-aster}
PROJECT=aster-e2e
BUILD=1 KEEP=0 DOWN=0 UI=1 FLOWS=1 BUDGET=1 UI_DOCKER=0 BUDGET_SECONDS=60 BUDGET_SETTLE=40

while [ $# -gt 0 ]; do
  case $1 in
    --home) HOME_DIR=${2:?--home needs a directory}; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --keep) KEEP=1; shift ;;
    --down) DOWN=1; shift ;;
    --skip-ui) UI=0; shift ;;
    --skip-flows) FLOWS=0; shift ;;
    --skip-budget) BUDGET=0; shift ;;
    --ui-in-docker) UI_DOCKER=1; shift ;;
    --budget-seconds) BUDGET_SECONDS=${2:?--budget-seconds needs a number}; shift 2 ;;
    --budget-settle) BUDGET_SETTLE=${2:?--budget-settle needs a number}; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run.sh: unknown argument $1 (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() { printf 'run.sh: %s\n' "$*" >&2; exit 1; }
compose() {
  docker compose -p "$PROJECT" --project-directory "$ROOT" --env-file "$HOME_DIR/.env" \
    -f "$ROOT/docker-compose.yml" -f "$E2E/compose.e2e.yaml" "$@"
}
# A listener on 127.0.0.1:<port>? (bash's /dev/tcp; nothing to install)
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&-; return 0; }; return 1; }

if [ "$DOWN" -eq 1 ]; then
  [ -f "$HOME_DIR/.env" ] || die "no $HOME_DIR/.env — nothing of this script's is there to take down"
  compose down -v --remove-orphans
  exit 0
fi

command -v node >/dev/null 2>&1 || die "node is needed on this machine (bin/passwd.js, the flows)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is needed"
for port in 5038 5060 "$PORT" "$TG_PORT" $((TG_PORT + 1)); do
  if listening "$port"; then die "something already listens on 127.0.0.1:$port (an appliance on this machine? both stacks share the host network); stop it first"; fi
done

# ---- 1. the home --------------------------------------------------------------------------------------------------
say "the appliance home: $HOME_DIR"
if [ -e "$HOME_DIR" ] && [ ! -f "$HOME_DIR/.aster-e2e" ]; then
  die "$HOME_DIR exists and was not made by this script; refusing to empty it"
fi
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR"/{config/asterisk,state/asterisk,state/prev,spool/events,logs/asterisk,backups}
# Asterisk writes these as its own user, and the controller, which runs as the invoking user here, deletes in them.
chmod 777 "$HOME_DIR"/{state/asterisk,spool/events,logs/asterisk}
: > "$HOME_DIR/.aster-e2e"
cp -r "$ROOT/docker/asterisk/test-config/." "$HOME_DIR/config/asterisk/"
cp "$E2E/aster.yaml" "$HOME_DIR/config/aster.yaml"
ami_secret=$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')
sed "s|@ASTER_AMI_SECRET@|$ami_secret|" "$ROOT/install/templates/asterisk/manager.conf.tmpl" > "$HOME_DIR/config/asterisk/manager.conf"
# Asterisk reads it as its own user; the secret is made for this run only.
chmod 644 "$HOME_DIR/config/asterisk/manager.conf"
( umask 077; printf 'ASTER_AMI_SECRET=%s\nTELEGRAM_BOT_TOKEN=1234567890:e2e-fake-token_of-the-bot-api-stand-in\n' "$ami_secret" > "$HOME_DIR/config/secrets.env" )
ASTER_HOME=$HOME_DIR ASTER_ADMIN_PASSWORD=$PASSWORD node "$ROOT/packages/controller/bin/passwd.js" >/dev/null
grep -q '^ASTER_ADMIN_PASSWORD_HASH=\$scrypt\$' "$HOME_DIR/config/secrets.env" || die "bin/passwd.js wrote no password hash"
cat > "$HOME_DIR/.env" <<EOF
ASTER_VERSION=$VERSION
ASTER_IMAGE_NS=$IMAGE_NS
ASTER_IMAGE_SOURCE=build
ASTER_HTTP_PORT=$PORT
ASTER_REPO=$ROOT
ASTER_HOME=$HOME_DIR
ASTER_E2E_USER=$(id -u):$(id -g)
ASTER_E2E_TELEGRAM_PORT=$TG_PORT
EOF
echo "   config from docker/asterisk/test-config + test/e2e/aster.yaml; the controller runs as $(id -u):$(id -g)"

# ---- 2. the stack -------------------------------------------------------------------------------------------------
mkdir -p "$E2E/logs"
status=0
finish() {
  local code=$?
  say "container logs → test/e2e/logs/"
  for name in aster-e2e-asterisk aster-e2e-controller aster-e2e-telegram; do
    docker logs "$name" > "$E2E/logs/$name.log" 2>&1 || true
  done
  cp "$HOME_DIR/logs/asterisk/full" "$E2E/logs/asterisk-full.log" 2>/dev/null || true
  if [ "$KEEP" -eq 1 ]; then
    echo "   the stack is left running (--keep): http://127.0.0.1:$PORT — take it down with: test/e2e/run.sh --down"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap finish EXIT

if [ "$BUILD" -eq 1 ]; then
  say "building $IMAGE_NS/aster-asterisk:$VERSION and $IMAGE_NS/aster-controller:$VERSION"
  compose build
else
  for image in aster-asterisk aster-controller; do
    docker image inspect "$IMAGE_NS/$image:$VERSION" >/dev/null 2>&1 || die "--no-build, but there is no $IMAGE_NS/$image:$VERSION image"
  done
fi

say "compose up --wait (project $PROJECT)"
compose up -d --wait --wait-timeout 240
docker ps --filter "name=aster-e2e-" --format '   {{.Names}}: {{.Status}}'
for attempt in $(seq 60); do
  health=$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  case $health in
    *'"status":"ok"'*'"state":"up"'*) break ;;
  esac
  [ "$attempt" -lt 60 ] || { echo "$health"; die "the controller did not report ok with the AMI up within 60 s"; }
  sleep 1
done
echo "   /api/health: ok, AMI up"

# ---- 3. the idle write budget  --------------------------------------------------------------------------------
if [ "$BUDGET" -eq 1 ]; then
  say "idle write budget: $BUDGET_SECONDS s with the stack up and nothing happening (after $BUDGET_SETTLE s to let the start-up writeback finish)"
  sleep "$BUDGET_SETTLE"
  # The three windows run at once (they only read counters): each container on its own, to attribute what is written,
  # and the two together, which is the number held to the budget. The host's disk is the same tool's ordinary mode.
  "$ROOT/tools/write-budget.sh" --seconds "$BUDGET_SECONDS" --container aster-e2e-asterisk --json > "$E2E/logs/budget-asterisk.json" 2>&1 &
  "$ROOT/tools/write-budget.sh" --seconds "$BUDGET_SECONDS" --container aster-e2e-controller --json > "$E2E/logs/budget-controller.json" 2>&1 &
  "$ROOT/tools/write-budget.sh" --seconds "$BUDGET_SECONDS" --home "$HOME_DIR" --json > "$E2E/logs/budget-host.json" 2>&1 &
  if "$ROOT/tools/write-budget.sh" --seconds "$BUDGET_SECONDS" --container aster-e2e-asterisk,aster-e2e-controller --json > "$E2E/logs/budget-containers.json" 2>&1; then
    echo "   both containers: $(cat "$E2E/logs/budget-containers.json")"
  else
    # 1 is a measured overrun; 2 is a host that cannot attribute a container's writes at all, and write-budget.sh
    # says which. Calling the second an overrun would be untrue, and counting it a pass is the bug this guards.
    rc=$?
    echo "   both containers: $(cat "$E2E/logs/budget-containers.json")"
    if [ "$rc" -eq 2 ]; then
      echo "::error::the idle write budget could not be measured on this host, so nothing was checked"
    else
      echo "::error::the two containers wrote more than the budget allows while idle"
    fi
    status=1
  fi
  wait
  echo "   asterisk alone:  $(cat "$E2E/logs/budget-asterisk.json")"
  echo "   controller alone: $(cat "$E2E/logs/budget-controller.json")"
  echo "   the host's disk (for information; this machine is not an idle appliance): $(cat "$E2E/logs/budget-host.json")"
fi

# ---- 4. the flows -------------------------------------------------------------------------------------------------
if [ "$FLOWS" -eq 1 ]; then
  say "the flows"
  ASTER_E2E_HOME=$HOME_DIR ASTER_E2E_URL="http://127.0.0.1:$PORT" ASTER_E2E_PASSWORD=$PASSWORD \
    ASTER_E2E_TELEGRAM="http://127.0.0.1:$((TG_PORT + 1))" ASTER_E2E_CONTROLLER=aster-e2e-controller \
    node "$E2E/flows/run.js" || status=1
fi

# ---- 5. the browser -----------------------------------------------------------------------------------------------
if [ "$UI" -eq 1 ]; then
  say "the browser smoke (phone + desktop)"
  if [ "$UI_DOCKER" -eq 1 ]; then
    docker run --rm --ipc=host --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI=1 \
      -e ASTER_UI_BASE_URL="http://127.0.0.1:$PORT" -e ASTER_E2E_PASSWORD="$PASSWORD" \
      -v "$ROOT:/work" -w /work mcr.microsoft.com/playwright:v1.63.0-noble \
      npx playwright test -c test/e2e/playwright.config.js || status=1
  else
    ( cd "$ROOT" && ASTER_UI_BASE_URL="http://127.0.0.1:$PORT" ASTER_E2E_PASSWORD=$PASSWORD \
        npx playwright test -c test/e2e/playwright.config.js ) || status=1
  fi
fi

say "result: $([ "$status" -eq 0 ] && echo 'everything passed' || echo 'FAILED — see above')"
exit "$status"
