#!/usr/bin/env bash
# Aster — host installer: turns a clean Debian/Ubuntu/Raspberry Pi OS host into a running appliance. A re-run changes
# nothing: hand-owned files, secrets already set and anything under state/, spool/, logs/ or backups/ are kept.
#
# The appliance is this checkout, its data goes into data/. Outside it the installer writes only the udev rule and its
# helper, usb-modeswitch, a snd_usb_audio option, containerd's TMPDIR drop-in and /usr/local/bin/aster.
# The last line printed is CHANGED=<n>, the number of changes made.
#
# Usage: install.sh [options]
#   --build | --pull        build the images from this checkout or pull the published ones (default)
#   --rebuild               build them again even when they are there (recreates both containers: calls drop)
#   --non-interactive       never prompt; the admin password then comes from ASTER_ADMIN_PASSWORD
#   --install-docker        install Docker and the compose plugin when they are missing (apt hosts only)
#   --http-port N           the port the UI and the API listen on (default 80; a re-run keeps the installed one)
#   --home DIR              where the appliance keeps its data (default: data/ in this checkout)
#   --sd-tuning | --no-sd-tuning
#                           accepted and ignored: host tuning (swap, journald, /tmp) is left to the OS
#   --skip-up               do everything but start the containers
#   -h | --help             this text
# Env:
#   ASTER_ADMIN_PASSWORD    the admin password (required with --non-interactive when no hash is set yet)
#   ASTER_TELEGRAM_TOKEN    the Telegram bot token (optional; can be set later in the UI)
#   ASTER_ADMIN_PASSWORD_FILE, ASTER_TELEGRAM_TOKEN_FILE
#                           the same two read from a file instead (first line), which keeps them out of the
#                           environment (the Ansible role uses these)
#   ASTER_ENV_FILE          the appliance's .env (default: .env beside docker-compose.yml, in this checkout)
#   ASTER_IMAGE_SOURCE      build | pull, the same choice as --build/--pull (default pull)
#   ASTER_VERSION           image tag (pull: latest, build: dev), ASTER_IMAGE_NS (pull: sheepsticked,
#                           build: aster), ASTER_REPO (default: this checkout)
set -euo pipefail

# ---- defaults ---------------------------------------------------------------------------------------------------

HOME_DIR=''                 # default: $REPO/data, set once the arguments are read
HOME_GIVEN=0
# Empty means "not given on the command line": an option the operator did not repeat is taken from the installed .env
# before it falls back to the default below, so a re-run cannot move an appliance that is already configured.
HTTP_PORT=''
DEFAULT_HTTP_PORT=80
IMAGE_SOURCE=''
INTERACTIVE=1
INSTALL_DOCKER=0
SKIP_UP=0
REBUILD=0
SD_TUNING=auto
CHANGED=0
MIN_FREE_KB=$((2 * 1024 * 1024))
HEALTH_TIMEOUT=120
ASTERISK_UID=5060           # docker/asterisk/Dockerfile: the user Asterisk drops to, which owns what it writes
NODE_MAJOR=24               # packages/controller/package.json: engines.node >= 24.15

SELF=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=${ASTER_REPO:-$(CDPATH='' cd -- "$SELF/.." && pwd)}

# ---- output -----------------------------------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok() { printf '   %s\n' "$*"; }
did() { CHANGED=$((CHANGED + 1)); printf '   changed: %s\n' "$*"; }
warn() { printf '   warning: %s\n' "$*" >&2; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
is_root() { [ "$(id -u)" -eq 0 ]; }
# Whether version $1 is $2 or newer, by its leading dotted number ("2.40.3+ds1" is 2.40.3).
version_at_least() {
  local have_version=${1%%[!0-9.]*}
  [ "$(printf '%s\n%s\n' "$2" "$have_version" | sort -V | head -n 1)" = "$2" ]
}

usage() { sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ---- idempotent primitives --------------------------------------------------------------------------------------

# A directory with its mode, created only when absent.
ensure_dir() {
  local path=$1 mode=$2
  if [ -d "$path" ]; then
    [ "$(stat -c '%a' "$path")" = "$mode" ] || { chmod "$mode" "$path"; did "mode $mode on $path"; }
  else
    mkdir -p "$path"
    chmod "$mode" "$path"
    did "created $path"
  fi
}

# A file copied only when it is not there at all: this is how a hand-owned starter file is installed (install and
# update never write hand-owned paths except to create an absent one).
install_if_absent() {
  local src=$1 dst=$2 mode=$3
  if [ -e "$dst" ]; then
    ok "kept $dst"
    return
  fi
  install -m "$mode" "$src" "$dst"
  did "installed $dst"
}

# A file this installer owns: written when its content differs, left alone when it does not.
write_if_different() {
  local dst=$1 mode=$2 content=$3
  if [ -f "$dst" ] && [ "$(cat -- "$dst")" = "$content" ] && [ "$(stat -c '%a' "$dst")" = "$mode" ]; then
    ok "unchanged $dst"
    return 1
  fi
  local tmp="$dst.tmp.$$"
  # `\n` restores the trailing newline the command substitution stripped; the comparison above strips it too.
  printf '%s\n' "$content" > "$tmp" || die "cannot write $dst (is $(dirname "$dst") there and writable?)"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dst" || die "cannot replace $dst"
  did "wrote $dst"
  return 0
}

copy_if_different() {
  local src=$1 dst=$2 mode=$3 content
  # A missing source would otherwise be installed as an empty file.
  [ -r "$src" ] || die "cannot read $src — this checkout looks incomplete"
  content=$(cat -- "$src")
  write_if_different "$dst" "$mode" "$content"
}

# ---- arguments --------------------------------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case $1 in
    --build) IMAGE_SOURCE=build ;;
    --pull) IMAGE_SOURCE=pull ;;
    --non-interactive) INTERACTIVE=0 ;;
    --install-docker) INSTALL_DOCKER=1 ;;
    --skip-up) SKIP_UP=1 ;;
    --rebuild) REBUILD=1 ;;
    --sd-tuning) SD_TUNING=on ;;
    --no-sd-tuning) SD_TUNING=off ;;
    --http-port) HTTP_PORT=${2:-} ; shift ;;
    --http-port=*) HTTP_PORT=${1#*=} ;;
    --home) HOME_DIR=${2:-} ; HOME_GIVEN=1 ; shift ;;
    --home=*) HOME_DIR=${1#*=} ; HOME_GIVEN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

[ "$HOME_GIVEN" -eq 0 ] || [ -n "$HOME_DIR" ] || die "--home needs a directory"
[ -n "$HOME_DIR" ] || HOME_DIR="$REPO/data"
case $HOME_DIR in /*) ;; *) die "--home must be an absolute path, not $HOME_DIR" ;; esac
# Both paths end up in a compose volume (`<home>/config:/srv/aster/config`), in .env and in the quoted `aster` command
# of step 7: a colon splits the volume, a `$` is interpolated by compose, and a quote or a backslash breaks the command.
for location in "$REPO" "$HOME_DIR"; do
  case $location in
    *[:\$\'\"\\\`]*) die "Aster cannot run from a path with : \$ ' \" \\ or \` in it: $location" ;;
  esac
  [ "$location" = "$(printf '%s' "$location" | tr -d '\n')" ] || die "Aster cannot run from a path with a line break in it"
done

# compose reads the .env beside the compose file by itself, so one checkout is one appliance; ASTER_ENV_FILE puts it
# elsewhere (a second appliance from one checkout, tests).
COMPOSE_FILE="$REPO/docker-compose.yml"
ENV_FILE=${ASTER_ENV_FILE:-$REPO/.env}
# Fallback: .env in the home (older installs); it is moved beside the compose file.
MOVED_ENV=0
if [ ! -f "$ENV_FILE" ] && [ -f "$HOME_DIR/.env" ]; then
  mv "$HOME_DIR/.env" "$ENV_FILE" && MOVED_ENV=1
fi
SECRETS="$HOME_DIR/config/secrets.env"

# Options not given on this run come from the installed .env before any default, so a re-run never moves the appliance.
env_value() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }

[ -n "$HTTP_PORT" ] || HTTP_PORT=$(env_value ASTER_HTTP_PORT)
[ -n "$HTTP_PORT" ] || HTTP_PORT=$DEFAULT_HTTP_PORT
[ -n "$IMAGE_SOURCE" ] || IMAGE_SOURCE=${ASTER_IMAGE_SOURCE:-}
[ -n "$IMAGE_SOURCE" ] || IMAGE_SOURCE=$(env_value ASTER_IMAGE_SOURCE)
# Default pull: a source build of Asterisk is slow on a Pi. An appliance installed with --build keeps building (.env).
[ -n "$IMAGE_SOURCE" ] || IMAGE_SOURCE=pull
# Tag and namespace come from .env too, except across a change of source (build and pull use different names).
if [ "$IMAGE_SOURCE" = "$(env_value ASTER_IMAGE_SOURCE)" ] || [ -z "$(env_value ASTER_IMAGE_SOURCE)" ]; then
  ASTER_VERSION=${ASTER_VERSION:-$(env_value ASTER_VERSION)}
  ASTER_IMAGE_NS=${ASTER_IMAGE_NS:-$(env_value ASTER_IMAGE_NS)}
fi
# Defaults follow the source: pull = sheepsticked/aster-*:latest, build = aster/aster-*:dev (never a pulled name).
if [ "$IMAGE_SOURCE" = pull ]; then
  ASTER_VERSION=${ASTER_VERSION:-latest}
  ASTER_IMAGE_NS=${ASTER_IMAGE_NS:-sheepsticked}
else
  ASTER_VERSION=${ASTER_VERSION:-dev}
  ASTER_IMAGE_NS=${ASTER_IMAGE_NS:-aster}
fi
export ASTER_VERSION ASTER_IMAGE_NS

case $HTTP_PORT in
  ''|*[!0-9]*) die "--http-port must be a port number, not ${HTTP_PORT:-<empty>}" ;;
esac
[ "$HTTP_PORT" -ge 1 ] && [ "$HTTP_PORT" -le 65535 ] || die "--http-port must be between 1 and 65535"
case $IMAGE_SOURCE in build|pull) ;; *) die "the image source must be build or pull, not $IMAGE_SOURCE" ;; esac

# ---- 1. preflight -----------------------------------------------------------------------------------------------

# Before step 7 writes .env, a rendered temporary one stands in (steps 4 and 4b may need compose on a Node-less host).
# ASTER_REPO and ASTER_HOME come from where this run is, so a moved folder does not use stale paths from .env.
compose() {
  if [ -f "$ENV_FILE" ]; then
    ASTER_REPO=$REPO ASTER_HOME=$HOME_DIR docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
    return
  fi
  local tmp_env status=0
  tmp_env=$(mktemp) || die "cannot create a temporary env file"
  env_file_content > "$tmp_env"
  ASTER_REPO=$REPO ASTER_HOME=$HOME_DIR docker compose --env-file "$tmp_env" -f "$COMPOSE_FILE" "$@" || status=$?
  rm -f "$tmp_env"
  return "$status"
}

port_in_use() {
  if have ss; then ss -ltn "( sport = :$1 )" 2>/dev/null | grep -q LISTEN
  elif have netstat; then netstat -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"
  else return 1
  fi
}

our_container_running() { [ -n "$(docker ps -q --filter "name=^aster-controller$" 2>/dev/null || true)" ]; }

# The old appliance's web UI (asterisk-webui, port 80) is stopped when it holds Aster's port; the migration does not
# need it, but it is what starts the old modems.
OLD_WEBUI=asterisk-webui
old_webui_running() { have docker && [ "$(docker container inspect -f '{{.State.Running}}' "$OLD_WEBUI" 2>/dev/null)" = true ]; }

# Stops the old web UI and waits for the port; when something else still holds it, the web UI is started again.
free_port_from_old_webui() {
  docker stop "$OLD_WEBUI" >/dev/null || die "port $HTTP_PORT is held by the old web UI ($OLD_WEBUI), and it could not be stopped"
  local waited=0
  while port_in_use "$HTTP_PORT" && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if port_in_use "$HTTP_PORT"; then
    docker start "$OLD_WEBUI" >/dev/null || warn "could not start $OLD_WEBUI again"
    die "port $HTTP_PORT is in use by something other than the old web UI ($OLD_WEBUI, started again); free it or pass --http-port"
  fi
  did "stopped the old web UI ($OLD_WEBUI), which held port $HTTP_PORT — the migration does not need it. The old Asterisk keeps running, but only the web UI starts its modems: if the old Asterisk restarts before the cutover they stay stopped"
}

install_docker() {
  have apt-get || die "Docker is missing and --install-docker only knows apt hosts; install Docker and the compose plugin, then run this again"
  say "   installing Docker from get.docker.com …"
  # A private temporary file, removed even when the run fails: a predictable name in the shared /tmp is something
  # another user on the host can put there first, and this is fetched from the network and run as root.
  local script
  script=$(mktemp) || die "cannot create a temporary file for the Docker installer"
  chmod 600 "$script"
  if have curl; then curl -fsSL https://get.docker.com -o "$script" || { rm -f "$script"; die "could not download the Docker installer"; }
  elif have wget; then wget -qO "$script" https://get.docker.com || { rm -f "$script"; die "could not download the Docker installer"; }
  else rm -f "$script"; die "neither curl nor wget is available to fetch the Docker installer"
  fi
  sh "$script" || { rm -f "$script"; die "the Docker installer from get.docker.com failed"; }
  rm -f "$script"
  did "installed Docker"
}

preflight() {
  step "1/8 preflight"
  [ "$(uname -s)" = Linux ] || die "Aster runs on Linux; this is $(uname -s)"
  case $(uname -m) in
    x86_64|amd64|aarch64|arm64) ok "architecture $(uname -m)" ;;
    *) warn "architecture $(uname -m) is untested; the images are built for amd64 and arm64" ;;
  esac

  if is_root; then
    ok "running as root"
  else
    warn "not running as root: the udev rule, usb-modeswitch and /usr/local/bin/aster are skipped"
  fi

  # Checks that cost nothing come before anything that changes the host.

  # Free space on the filesystem that will carry the appliance: the two images are ~600 MB together.
  local probe=$HOME_DIR free
  while [ ! -d "$probe" ] && [ "$probe" != / ]; do probe=$(dirname "$probe"); done
  free=$(df -Pk "$probe" | awk 'NR==2 {print $4}')
  [ "$free" -ge "$MIN_FREE_KB" ] || die "less than 2 GB free on $probe ($((free / 1024)) MB); Aster needs room for two images and its state"
  ok "$((free / 1024)) MB free on $probe"

  if [ -e "$HOME_DIR" ]; then
    [ -d "$HOME_DIR" ] || die "$HOME_DIR exists and is not a directory"
    [ -w "$HOME_DIR" ] || is_root || die "$HOME_DIR is not writable by this user; run as root"
  else
    # The first ancestor that exists is the one that has to be writable: `mkdir -p` creates the rest.
    [ -w "$probe" ] || is_root || die "$probe is not writable by this user; run as root"
  fi
  # A root-owned secrets.env this user cannot read would look empty and be overwritten (own files get their mode fixed).
  if [ -e "$SECRETS" ] && [ ! -r "$SECRETS" ] && [ ! -O "$SECRETS" ]; then
    die "$SECRETS belongs to another user and this one cannot read it (the controller rewrites it as root); run the installer as root"
  fi

  if port_in_use "$HTTP_PORT"; then
    if our_container_running && [ "$(env_value ASTER_HTTP_PORT)" = "$HTTP_PORT" ]; then
      ok "port $HTTP_PORT is held by the running appliance (this is a second run)"
    elif old_webui_running; then
      free_port_from_old_webui
    else
      die "port $HTTP_PORT is already in use by something that is not this appliance; free it or pass --http-port"
    fi
  else
    ok "port $HTTP_PORT is free"
  fi

  if ! have docker; then
    [ "$INSTALL_DOCKER" -eq 1 ] || die "Docker is not installed (install it, or run again with --install-docker)"
    is_root || die "installing Docker needs root"
    install_docker
  fi
  docker info >/dev/null 2>&1 || die "the Docker daemon does not answer (is it running, and may this user talk to it?)"
  # docker-compose.yml needs Docker Engine 25 and compose 2.20.2 (healthcheck start_interval); engine first.
  local compose_version engine_version
  engine_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [ -z "${engine_version%%[!0-9]*}" ]; then
    warn "cannot tell which Docker Engine this is ('$engine_version'); Aster needs 25 or newer"
  elif ! version_at_least "$engine_version" 25; then
    if dpkg-query -W -f='${Status}' docker.io 2>/dev/null | grep -q '^install ok installed$'; then
      die "Docker Engine $engine_version is too old: Aster needs 25 or newer. Replace the distribution's docker.io with Docker's own packages: \`apt-get remove docker.io docker-compose containerd runc\`, then run this again with --install-docker"
    fi
    die "Docker Engine $engine_version is too old: Aster needs 25 or newer (upgrade Docker)"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    if [ "$INSTALL_DOCKER" -eq 1 ] && have apt-get && is_root; then
      # The package name depends on the Docker source; docker-compose 1.x is the old standalone tool.
      apt-get update -qq || warn "apt-get update failed; trying with the package lists as they are"
      local package='' candidate
      for candidate in docker-compose-plugin docker-compose-v2 docker-compose; do
        if apt-cache show "$candidate" 2>/dev/null | grep -qE '^Version: ([0-9]+:)?[2-9]'; then package=$candidate; break; fi
      done
      [ -n "$package" ] || die "apt knows no docker compose plugin package here; install the plugin by hand"
      apt-get install -y -qq "$package" || die "apt-get install $package failed"
      did "installed the docker compose plugin ($package)"
    fi
    docker compose version >/dev/null 2>&1 || die "the Docker compose plugin is missing (install it, or run again with --install-docker)"
  fi
  compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)
  if [ -z "${compose_version%%[!0-9]*}" ]; then
    warn "cannot tell which docker compose this is ('$compose_version'); Aster needs 2.20.2 or newer"
  elif ! version_at_least "$compose_version" 2.20.2; then
    die "docker compose $compose_version is too old: Aster needs 2.20.2 or newer"
  fi
  ok "docker ${engine_version:-?} with compose ${compose_version:-?}"

  if have systemctl && systemctl is-active --quiet ModemManager 2>/dev/null; then
    warn "ModemManager is active: it opens modem serial ports and fights the Asterisk drivers. Disable it (systemctl disable --now ModemManager); the udev rule below also tells it to keep away."
  fi
  if [ -d /srv/asterisk ] || docker ps --format '{{.Names}}' 2>/dev/null | grep -qx asterisk; then
    warn "the old /srv/asterisk appliance looks present: the two stacks cannot own the same modems, and while its Asterisk holds SIP port 5060 this one starts with no transport at all — so no phone registers until the cutover (\`aster migrate check\` lists what else conflicts, the migration notes)"
  fi
}

# ---- 2. the tree ------------------------------------------------------------------------------------------------

make_tree() {
  step "2/8 the appliance tree in $HOME_DIR"
  ensure_dir "$HOME_DIR" 755
  ensure_dir "$HOME_DIR/config" 755
  ensure_dir "$HOME_DIR/config/asterisk" 755
  ensure_dir "$HOME_DIR/config/asterisk/aster.d" 755
  ensure_dir "$HOME_DIR/state" 755
  ensure_dir "$HOME_DIR/state/prev" 755
  ensure_dir "$HOME_DIR/state/asterisk" 755
  ensure_dir "$HOME_DIR/spool" 755
  ensure_dir "$HOME_DIR/spool/events" 755
  ensure_dir "$HOME_DIR/spool/quarantine" 755
  ensure_dir "$HOME_DIR/logs" 755
  ensure_dir "$HOME_DIR/logs/asterisk" 755
  # The backup archive holds config/secrets.env, so the directory it lands in is the operator's alone.
  ensure_dir "$HOME_DIR/backups" 700

  # The home is root's, which is what the controller and the host scripts run as; the controller mounts only these five
  # directories. The three Asterisk writes, and manager.conf's group, belong to Asterisk's user (the image sets them).
  if is_root; then
    local rest=( "$HOME_DIR/config" "$HOME_DIR/state" "$HOME_DIR/spool" "$HOME_DIR/logs" "$HOME_DIR/backups"
                 -path "$HOME_DIR/state/asterisk" -prune -o -path "$HOME_DIR/logs/asterisk" -prune -o
                 -path "$HOME_DIR/spool/events" -prune -o -path "$HOME_DIR/config/asterisk/manager.conf" -prune -o
                 \( ! -uid 0 -o ! -gid 0 \) )
    if [ -n "$(find "${rest[@]}" -print -quit)" ]; then
      find "${rest[@]}" -exec chown 0:0 {} +
      did "gave the rest of $HOME_DIR to root"
    fi
    ok "the home is root's except what Asterisk writes; the controller sees config/, state/, spool/, logs/, backups/"
  fi
}

# ---- 3. starter files -------------------------------------------------------------------------------------------

install_templates() {
  step "3/8 starter configuration (only what is absent)"
  local src
  for src in "$SELF"/templates/asterisk/*.conf; do
    [ -e "$src" ] || continue
    install_if_absent "$src" "$HOME_DIR/config/asterisk/$(basename "$src")" 644
  done
  install_if_absent "$SELF/templates/aster.yaml" "$HOME_DIR/config/aster.yaml" 644
}

# aster.d, written by the controller's own generator before anything starts: Asterisk rejects a whole file whose
# #include target is missing. Runs after the secrets exist; later changes go through registry-apply.
generate_config() {
  step "4b/8 generated configuration (aster.d)"
  local output
  if local_node_usable; then
    output=$(ASTER_HOME="$HOME_DIR" node "$REPO/packages/controller/bin/generate.js")
  else
    ensure_controller_image
    # config/ only, as in the controller's own service: the generator reads secrets.env and aster.yaml and writes aster.d.
    output=$(docker run --rm -e ASTER_HOME=/srv/aster -v "$HOME_DIR/config:/srv/aster/config" \
      "$ASTER_IMAGE_NS/aster-controller:$ASTER_VERSION" node packages/controller/bin/generate.js)
  fi
  printf '%s\n' "$output" | sed 's/^/   /'
  # Count the files the generator wrote ("<n> of 5 file(s) written") in CHANGED.
  local written
  written=$(printf '%s' "$output" | sed -n 's/^generate\.js: \([0-9]\{1,\}\) of [0-9]\{1,\} file(s) written.*$/\1/p' | tail -1)
  case $written in
    '') warn "could not tell how many generated files were written, so CHANGED does not count them: ${output:-<no output>}" ;;
    0) : ;;
    *) CHANGED=$((CHANGED + written)); ok "counted $written generated file(s) as changes" ;;
  esac
}

# ---- 4. secrets -------------------------------------------------------------------------------------------------

secret_value() { [ -f "$SECRETS" ] && sed -n "s/^$1=//p" "$SECRETS" | tail -1 || true; }

secret_set() {
  local key=$1 value=$2 tmp="$SECRETS.tmp.$$"
  # umask first, in a subshell so it does not leak: the secret is never readable by others, not even briefly.
  (
    umask 077
    # Each step exits by hand: `set -e` does not act inside a subshell whose status `||` tests.
    if [ -f "$SECRETS" ] && grep -q "^$key=" "$SECRETS"; then
      awk -v k="$key" -v v="$value" 'BEGIN { FS="="; OFS="=" } $1 == k { print k "=" v; next } { print }' "$SECRETS" > "$tmp" || exit 1
    else
      { if [ -f "$SECRETS" ]; then cat "$SECRETS" || exit 1; fi; printf '%s=%s\n' "$key" "$value"; } > "$tmp" || exit 1
    fi
    chmod 600 "$tmp" || exit 1
    mv -f "$tmp" "$SECRETS" || exit 1
  ) || { rm -f "$tmp"; die "could not write $SECRETS"; }
}

random_secret() {
  if have openssl; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# A secret from a file (the environment shows in `ansible-playbook -vvv` and /proc/<pid>/environ): the first line,
# without its newline.
secret_from_file() {
  local path=$1 what=$2 value=''
  [ -r "$path" ] || die "cannot read the $what file $path"
  IFS= read -r value < "$path" || true
  [ -n "$value" ] || die "the $what file $path is empty"
  printf '%s' "$value"
}

# The scrypt hash the controller stores (packages/controller/src/http/auth.js). It is produced by the controller's own
# bin/passwd.js so that the format can never drift: with a local Node if there is one, otherwise inside the image.
hash_password() {
  local password=$1
  if local_node_usable; then
    ASTER_ADMIN_PASSWORD="$password" node "$REPO/packages/controller/bin/passwd.js" --hash
  else
    ensure_controller_image >&2
    printf '%s' "$password" | docker run --rm -i -e ASTER_ADMIN_PASSWORD \
      "$ASTER_IMAGE_NS/aster-controller:$ASTER_VERSION" node packages/controller/bin/passwd.js --hash
  fi
}

make_secrets() {
  step "4/8 secrets"
  if [ ! -f "$SECRETS" ]; then
    ( umask 077; : > "$SECRETS" ) || die "cannot create $SECRETS"
    chmod 600 "$SECRETS"
    did "created $SECRETS"
  else
    [ "$(stat -c '%a' "$SECRETS")" = 600 ] || { chmod 600 "$SECRETS"; did "mode 600 on $SECRETS"; }
  fi

  if [ -z "$(secret_value ASTER_AMI_SECRET)" ]; then
    secret_set ASTER_AMI_SECRET "$(random_secret)"
    did "generated ASTER_AMI_SECRET"
  else
    ok "ASTER_AMI_SECRET is set"
  fi

  if [ -z "$(secret_value ASTER_SESSION_KEY)" ]; then
    secret_set ASTER_SESSION_KEY "$(random_secret)"
    did "generated ASTER_SESSION_KEY"
  else
    ok "ASTER_SESSION_KEY is set"
  fi

  if [ -z "$(secret_value ASTER_ADMIN_PASSWORD_HASH)" ]; then
    local password=${ASTER_ADMIN_PASSWORD:-}
    if [ -z "$password" ] && [ -n "${ASTER_ADMIN_PASSWORD_FILE:-}" ]; then
      password=$(secret_from_file "$ASTER_ADMIN_PASSWORD_FILE" "admin password") ||
        die "no admin password: $ASTER_ADMIN_PASSWORD_FILE could not be read"
    fi
    if [ -z "$password" ]; then
      [ "$INTERACTIVE" -eq 1 ] || die "no admin password: set ASTER_ADMIN_PASSWORD or ASTER_ADMIN_PASSWORD_FILE (or run without --non-interactive to be asked)"
      local again
      printf '   admin password: ' >&2; read -rs password; printf '\n' >&2
      printf '   again: ' >&2; read -rs again; printf '\n' >&2
      [ "$password" = "$again" ] || die "the two passwords are not the same"
    fi
    [ -n "$password" ] || die "the admin password must not be empty"
    # Hashed into a variable and checked: a failure inside a nested command substitution would go unnoticed.
    local hash
    hash=$(hash_password "$password") || die "could not compute the password hash; nothing was written"
    case $hash in
      '$scrypt$'*) ;;
      '') die "the password hash came back empty; nothing was written" ;;
      *) die "the password hash came back in a shape the controller does not store; nothing was written" ;;
    esac
    secret_set ASTER_ADMIN_PASSWORD_HASH "$hash"
    did "set the admin password"
  else
    ok "the admin password is set (aster passwd changes it)"
  fi

  local token=${ASTER_TELEGRAM_TOKEN:-}
  if [ -z "$token" ] && [ -n "${ASTER_TELEGRAM_TOKEN_FILE:-}" ]; then
    token=$(secret_from_file "$ASTER_TELEGRAM_TOKEN_FILE" "Telegram bot token") ||
      die "$ASTER_TELEGRAM_TOKEN_FILE could not be read"
  fi
  if [ -n "$token" ] && [ "$token" != "$(secret_value TELEGRAM_BOT_TOKEN)" ]; then
    secret_set TELEGRAM_BOT_TOKEN "$token"
    did "set the Telegram bot token"
  elif [ -n "$(secret_value TELEGRAM_BOT_TOKEN)" ]; then
    ok "the Telegram bot token is set"
  else
    ok "no Telegram bot token yet (Settings → Telegram bot sets one)"
  fi
}

# ---- 5. manager.conf --------------------------------------------------------------------------------------------

render_manager_conf() {
  step "5/8 manager.conf (AMI, 0640)"
  local secret content path
  path="$HOME_DIR/config/asterisk/manager.conf"
  secret=$(secret_value ASTER_AMI_SECRET)
  [ -n "$secret" ] || die "no ASTER_AMI_SECRET in $SECRETS"
  content=$(sed "s|@ASTER_AMI_SECRET@|$secret|" "$SELF/templates/asterisk/manager.conf.tmpl")
  # write_if_different returns 1 when it left the file alone; that is not an error here.
  write_if_different "$path" 640 "$content" || true
  # Asterisk reads the AMI secret as its own user, and nobody else on the host can.
  if is_root && [ "$(stat -c '%u:%g' "$path")" != "0:$ASTERISK_UID" ]; then
    chown "0:$ASTERISK_UID" "$path"
    did "gave $path to Asterisk's group"
  fi
}

# ---- 6. udev ----------------------------------------------------------------------------------------------------

install_udev() {
  step "6/8 udev rule and the ALSA naming helper"
  if ! is_root; then
    ok "skipped (needs root)"
    return
  fi
  ensure_dir /usr/local/lib/aster 755
  local changed=0
  copy_if_different "$SELF/udev/alsa-name" /usr/local/lib/aster/alsa-name 755 && changed=1
  copy_if_different "$SELF/udev/90-aster.rules" /etc/udev/rules.d/90-aster.rules 644 && changed=1
  if [ "$changed" -eq 1 ] && have udevadm; then
    # Guarded: a host with no running udev (a container, WSL) fails here; the rule is in place anyway.
    if udevadm control --reload 2>/dev/null; then
      # Re-read what is already plugged in: `sound` names the Quectel cards, the modems' USB devices and ttys get the
      # ModemManager flags (only these two vendors' USB devices, not every device on the host).
      udevadm trigger --subsystem-match=sound --action=add 2>/dev/null || warn "udevadm trigger failed for the sound cards; they keep their current names until the next plug"
      { udevadm trigger --subsystem-match=usb --attr-match=idVendor=2c7c --action=add \
          && udevadm trigger --subsystem-match=usb --attr-match=idVendor=12d1 --action=add \
          && udevadm trigger --subsystem-match=tty --action=add; } 2>/dev/null \
        || warn "udevadm trigger failed for the modems; ModemManager keeps away only from modems plugged in after this"
      ok "udev reloaded and the devices already plugged in were re-read"
    else
      warn "udevadm control --reload failed (is udev running on this host?); the rule is in place and applies at the next boot"
    fi
  elif [ "$changed" -eq 1 ]; then
    warn "udevadm is not installed: the rule is in place but udev was not reloaded"
  fi

  # usb-modeswitch flips a Huawei dongle out of its CD-ROM mode; without it the modem never appears as a serial port.
  if have apt-get; then
    if dpkg-query -W -f='${Status}' usb-modeswitch 2>/dev/null | grep -q '^install ok installed$'; then
      ok "usb-modeswitch is installed"
    else
      # A freshly flashed image has no package lists yet.
      apt-get update -qq || warn "apt-get update failed; installing usb-modeswitch may not work"
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq usb-modeswitch usb-modeswitch-data \
        && did "installed usb-modeswitch" \
        || warn "could not install usb-modeswitch (a Huawei dongle may stay in CD-ROM mode)"
    fi
  else
    warn "no apt-get: install usb-modeswitch yourself if a Huawei dongle is used"
  fi
}

# ---- 6b. the kernel's USB audio driver -------------------------------------------------------------------------

# snd_usb_audio's low-latency mode can stall a Quectel UAC playback stream (silent calls); lowlatency=0 avoids it.
# A loaded module is reloaded only while no sound card is open, otherwise the option applies at the next boot.
# ASTER_SYSTEM_ROOT lets tests write host files into a scratch tree; modules are only touched on the real /.
SYSTEM_ROOT=${ASTER_SYSTEM_ROOT:-/}
sysfile() { printf '%s' "${SYSTEM_ROOT%/}/${1#/}"; }
real_system() { [ "$SYSTEM_ROOT" = / ]; }

USB_AUDIO_CONF=/etc/modprobe.d/aster-snd-usb-audio.conf
usb_audio_conf_content() {
  cat <<'CONF'
# Aster (install.sh): snd_usb_audio's low-latency mode can stall a Quectel UAC modem's playback stream (silent calls).
# Read when snd_usb_audio loads; after a change, reboot or reload the module while no sound card is open.
options snd_usb_audio lowlatency=0
CONF
}

install_usb_audio_mode() {
  step "6b/8 the kernel's USB audio driver (a Quectel modem in UAC mode is a USB sound card)"
  if real_system && ! is_root; then
    ok "skipped (needs root)"
    return
  fi
  ensure_dir "$(sysfile /etc/modprobe.d)" 755
  write_if_different "$(sysfile "$USB_AUDIO_CONF")" 644 "$(usb_audio_conf_content)" || true
  real_system || return 0
  local param=/sys/module/snd_usb_audio/parameters/lowlatency
  if [ ! -f "$param" ]; then
    ok "snd_usb_audio is not loaded; the option applies when it loads (the first USB sound card plugged in)"
    return
  fi
  case $(cat "$param" 2>/dev/null) in
    N) ok "snd_usb_audio runs in the classic mode (lowlatency=N)" ;;
    *)
      # In use = a sound card is open (a running modem): a reload would fail or cut a call, so a reboot applies it.
      local users
      users=$(awk '$1 == "snd_usb_audio" {print $3}' /proc/modules 2>/dev/null)
      if [ "${users:-0}" = 0 ] && have modprobe && modprobe -r snd_usb_audio 2>/dev/null && modprobe snd_usb_audio 2>/dev/null; then
        did "reloaded snd_usb_audio with lowlatency=0"
      else
        warn "snd_usb_audio is loaded in its low-latency mode and in use: calls through a UAC modem have no audio until the host is rebooted (or the modems are stopped and the module reloaded); aster doctor keeps saying so"
      fi
      ;;
  esac
}

# ---- 6c. containerd's temporary files --------------------------------------------------------------------------

# Healthchecks make containerd write temporary files in its TMPDIR (/tmp by default). This drop-in moves them to /run
# (RAM); containers keep running through the containerd restart and use it from their next start.
CONTAINERD_DROPIN=/etc/systemd/system/containerd.service.d/aster-tmpdir.conf
CONTAINERD_TMPDIR=/run/aster-containerd
containerd_dropin_content() {
  cat <<CONF
# Aster (install.sh): containerd's temporary files in RAM instead of /tmp.
[Service]
Environment=TMPDIR=$CONTAINERD_TMPDIR
RuntimeDirectory=${CONTAINERD_TMPDIR#/run/}
RuntimeDirectoryPreserve=yes
CONF
}

install_containerd_tmpdir() {
  step "6c/8 containerd's temporary files in RAM"
  if real_system && ! is_root; then
    ok "skipped (needs root)"
    return
  fi
  if real_system && ! { have systemctl && systemctl cat containerd.service >/dev/null 2>&1; }; then
    ok "skipped: containerd is not a systemd service on this host"
    return
  fi
  ensure_dir "$(sysfile "$(dirname "$CONTAINERD_DROPIN")")" 755
  write_if_different "$(sysfile "$CONTAINERD_DROPIN")" 644 "$(containerd_dropin_content)" || true
  real_system || return 0
  local pid
  pid=$(systemctl show -p MainPID --value containerd 2>/dev/null || echo 0)
  if [ "${pid:-0}" != 0 ] && tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "TMPDIR=$CONTAINERD_TMPDIR"; then
    ok "containerd runs with TMPDIR=$CONTAINERD_TMPDIR"
    return
  fi
  if systemctl daemon-reload && systemctl restart containerd; then
    # Step 8 needs dockerd reconnected first.
    local waited=0
    until docker info >/dev/null 2>&1 || [ "$waited" -ge 30 ]; do sleep 1; waited=$((waited + 1)); done
    did "restarted containerd with TMPDIR=$CONTAINERD_TMPDIR (containers use it from their next start)"
  else
    warn "could not restart containerd; the drop-in applies after a reboot"
  fi
}

# ---- 7. compose, host scripts, wrapper --------------------------------------------------------------------------

# .env is install/env.example with this host's values filled in, so new keys and their comments reach it on a re-run.
env_file_content() {
  ASTER_VERSION=${ASTER_VERSION:-latest} \
  ASTER_HTTP_PORT=$HTTP_PORT \
  ASTER_IMAGE_SOURCE=$IMAGE_SOURCE \
  ASTER_IMAGE_NS=${ASTER_IMAGE_NS:-sheepsticked} \
  ASTER_REPO=$REPO \
  ASTER_HOME=$HOME_DIR \
  awk '
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      key = substr($0, 1, index($0, "=") - 1)
      if (key in ENVIRON) { print key "=" ENVIRON[key]; next }
    }
    { print }
  ' "$SELF/env.example"
}

# `aster` on the PATH is a launcher for install/bin/aster in this checkout, with this home; the paths are single-quoted
# (paths that would break the quoting are refused up front).
aster_wrapper_content() {
  cat <<EOF
#!/bin/sh
# Aster — the aster command of the appliance in $REPO (home $HOME_DIR), written by install.sh.
# It runs install/bin/aster from that checkout. After moving the folder, run install/install.sh again from its new place.
[ -x '$REPO/install/bin/aster' ] || { echo "aster: there is no $REPO/install/bin/aster — was Aster moved? Run install/install.sh again from its new place" >&2; exit 1; }
ASTER_HOME=\${ASTER_HOME:-'$HOME_DIR'} exec '$REPO/install/bin/aster' "\$@"
EOF
}

install_runtime() {
  step "7/8 .env and the aster command"
  [ "$MOVED_ENV" -eq 0 ] || did "moved .env out of $HOME_DIR, beside the compose file it belongs to"
  write_if_different "$ENV_FILE" 644 "$(env_file_content)" || true

  if is_root; then
    # Rendered first: a `die` inside a command substitution argument would go unnoticed.
    local wrapper
    wrapper=$(aster_wrapper_content)
    write_if_different /usr/local/bin/aster 755 "$wrapper" || true
  else
    ok "skipped /usr/local/bin/aster (needs root); run $REPO/install/bin/aster with ASTER_HOME=$HOME_DIR instead"
  fi

  # The controller sees none of these: its service mounts only the five directories of make_tree.
}

# ---- 7b. SD-card write tuning: not done by the installer --------------------------------------------------------

# Host tuning (swap, journald, tmpfs) is left to the OS; --sd-tuning/--no-sd-tuning are accepted and ignored.
sd_tuning() {
  step "7b/8 SD-card write tuning"
  ok "not done by the installer: swap, journald and /tmp belong to the OS image (README: SD-card wear)"
  [ "$SD_TUNING" != on ] || warn "--sd-tuning is accepted for compatibility and does nothing"
}

# ---- 8. images and start ----------------------------------------------------------------------------------------

# `compose build` always makes a new image id and `up -d` then recreates both containers (calls drop), so a build
# happens only when an image is missing or --rebuild is given.
image_exists() { docker image inspect "$1" >/dev/null 2>&1; }
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
container_id() { docker container inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

# Container ids before and after `up -d` tell whether it replaced a container, which CHANGED has to count.
report_container() {
  local name=$1 before=$2 after
  after=$(container_id "$name")
  if [ "$after" = "$before" ]; then ok "$name is the container that was already there"
  elif [ -z "$before" ]; then did "started $name"
  else did "recreated $name — its image or its configuration changed, so calls through it dropped"
  fi
}

# Steps 4 and 4b run the controller's own tools: with the host's Node when it is new enough and the checkout has its
# dependencies installed (a fresh clone has none), otherwise inside the image.
local_node_usable() {
  have node || return 1
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  case $major in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge "$NODE_MAJOR" ] || return 1
  # Ask Node itself whether it can resolve what the tools import.
  node --input-type=module -e "import('$REPO/packages/controller/src/config/registry.js')" >/dev/null 2>&1
}

# Only the controller image, and only when missing: steps 4 and 4b need a Node; the Asterisk image is not needed.
ensure_controller_image() {
  image_exists "$ASTER_IMAGE_NS/aster-controller:$ASTER_VERSION" && return 0
  if [ "$IMAGE_SOURCE" = pull ]; then
    compose pull controller
  else
    say "   this host's Node cannot run the checkout's tools (missing, too old, or no dependencies installed):"
    say "   building the controller image to run them instead …"
    compose build controller
  fi
  image_exists "$ASTER_IMAGE_NS/aster-controller:$ASTER_VERSION" ||
    die "the controller image $ASTER_IMAGE_NS/aster-controller:$ASTER_VERSION is still not there after a $IMAGE_SOURCE"
  case $IMAGE_SOURCE in
    pull) did "pulled the controller image" ;;
    *) did "built the controller image" ;;
  esac
}

ensure_images() {
  local ns=$ASTER_IMAGE_NS version=$ASTER_VERSION
  if [ "$IMAGE_SOURCE" = pull ]; then
    # An unchanged digest keeps the image id, so the ids around the pull tell whether it changed anything.
    local before_asterisk before_controller
    before_asterisk=$(image_id "$ns/aster-asterisk:$version")
    before_controller=$(image_id "$ns/aster-controller:$version")
    compose pull
    [ "$(image_id "$ns/aster-asterisk:$version")" = "$before_asterisk" ] || did "pulled $ns/aster-asterisk:$version"
    [ "$(image_id "$ns/aster-controller:$version")" = "$before_controller" ] || did "pulled $ns/aster-controller:$version"
    return
  fi
  if [ "$REBUILD" -eq 1 ] || ! image_exists "$ns/aster-asterisk:$version" || ! image_exists "$ns/aster-controller:$version"; then
    compose build
    did "built the images"
  else
    ok "the images are built already (--rebuild builds them again; \`aster update\` rebuilds and restarts into them)"
  fi
}

wait_for_health() {
  local url="http://127.0.0.1:$HTTP_PORT/api/health" waited=0 body=''
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if have curl; then body=$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)
    elif have wget; then body=$(wget -qO- --timeout=5 "$url" 2>/dev/null || true)
    else body=$(docker exec aster-controller node -e "fetch('http://127.0.0.1:$HTTP_PORT/api/health').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))" 2>/dev/null || true)
    fi
    case $body in
      *'"status":"ok"'*) ok "the controller answers: status ok"; return 0 ;;
      *'"status":"degraded"'*) ok "the controller answers: status degraded (doctor.sh says why)"; return 0 ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

bring_up() {
  step "8/8 images and containers"
  if [ "$SKIP_UP" -eq 1 ]; then
    ok "skipped (--skip-up)"
    return
  fi
  ensure_images
  local before_asterisk before_controller
  before_asterisk=$(container_id aster-asterisk)
  before_controller=$(container_id aster-controller)
  compose up -d
  report_container aster-asterisk "$before_asterisk"
  report_container aster-controller "$before_controller"
  ok "waiting for the API on port $HTTP_PORT …"
  if wait_for_health; then
    local address
    address=$(hostname -I 2>/dev/null | awk '{print $1}')
    say ""
    say "   Aster is up: http://${address:-127.0.0.1}$([ "$HTTP_PORT" = 80 ] || printf ':%s' "$HTTP_PORT")"
    say "   log in with the admin password; \`aster doctor\` checks the appliance, \`aster help\` lists the rest."
  else
    compose ps || true
    die "the API did not answer within ${HEALTH_TIMEOUT}s; \`docker logs aster-controller\` says why"
  fi
}

# ---- main -------------------------------------------------------------------------------------------------------

say "Aster installer — home $HOME_DIR, port $HTTP_PORT, images: $IMAGE_SOURCE"
preflight
make_tree
install_templates
make_secrets
generate_config
render_manager_conf
install_udev
install_usb_audio_mode
install_containerd_tmpdir
install_runtime
sd_tuning
bring_up

if [ "$SKIP_UP" -eq 0 ]; then
  step "doctor"
  # No write-rate sample here: `aster doctor` measures it when asked.
  "$SELF/bin/doctor.sh" --home "$HOME_DIR" --write-seconds 0 || warn "doctor.sh reported problems"
fi

say ""
say "CHANGED=$CHANGED"
