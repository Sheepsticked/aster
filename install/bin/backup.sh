#!/usr/bin/env bash
# Aster — backup: one tar.gz of everything that is not re-creatable, written by the controller, which can copy the
# open SQLite database online (the same archive the UI's Download button streams).
#
# Usage: backup.sh [--home DIR] [--keep N]      (--home default: data/ in the checkout this script is in)
# Writes: <home>/backups/aster-<timestamp>.tar.gz (0600 — it contains config/secrets.env), keeping the newest N (10).
# Restore (the appliance must be down): docker compose down, untar over the home, docker compose up -d.
#
# Examples (`aster backup` runs this script):
#   backup.sh                          write a backup of this appliance now
#   backup.sh --keep 30                keep the newest 30 archives instead of ten
#   backup.sh --home /srv/aster-data   an appliance whose data is not in data/ of this checkout
set -euo pipefail

# The checkout is the one this file is in; the home is data/ inside it unless --home names another one.
SELF=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(CDPATH='' cd -- "$SELF/../.." && pwd)
MSG_NAME=backup.sh
# shellcheck source=install/lib/messages.sh
. "$SELF/../lib/messages.sh"
HOME_DIR="$REPO/data"
KEEP=10

while [ $# -gt 0 ]; do
  case $1 in
    --home) HOME_DIR=${2:?--home needs a directory}; shift 2 ;;
    --home=*) HOME_DIR=${1#*=}; shift ;;
    --keep) KEEP=${2:?--keep needs a number}; shift 2 ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/p;}' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) DIE_STATUS=2 die "unknown option: $1 (--help lists them)" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker ps --format '{{.Names}}' | grep -qx aster-controller ||
  die "the controller container is not running; start it (aster restart) and try again"

[ -d "$HOME_DIR/backups" ] || die "no $HOME_DIR/backups — is $HOME_DIR this appliance's home? (--home names another one)"

# bin/backup.js writes into <ASTER_HOME>/backups inside the container, which is this host's <home>/backups, and
# prunes to --keep itself; it prints the path it wrote — a container path, so the host path is printed here.
docker exec aster-controller node packages/controller/bin/backup.js --keep "$KEEP"

newest=$(ls -1t "$HOME_DIR"/backups/aster-*.tar.gz 2>/dev/null | head -1 || true)
if [ -n "$newest" ]; then
  printf 'backup.sh: %s (%s), keeping the newest %s\n' "$newest" "$(du -h "$newest" | cut -f1)" "$KEEP"
else
  die "the controller reported no error, but no archive appeared in $HOME_DIR/backups"
fi
