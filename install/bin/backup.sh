#!/usr/bin/env bash
# Aster — backup: one tar.gz of everything that is not re-creatable, written by the controller, which can copy the
# open SQLite database online (the same archive the UI's Download button streams).
#
# Usage: backup.sh [--home DIR] [--keep N]      (--home default: data/ in the checkout this script is in)
# Writes: <home>/backups/aster-<timestamp>.tar.gz (0600 — it contains config/secrets.env), keeping the newest N (10).
# Restore (the appliance must be down): docker compose down, untar over the home, docker compose up -d.
set -euo pipefail

# The checkout is the one this file is in; the home is data/ inside it unless --home names another one.
SELF=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(CDPATH='' cd -- "$SELF/../.." && pwd)
HOME_DIR="$REPO/data"
KEEP=10

while [ $# -gt 0 ]; do
  case $1 in
    --home) HOME_DIR=${2:?--home needs a directory}; shift 2 ;;
    --home=*) HOME_DIR=${1#*=}; shift ;;
    --keep) KEEP=${2:?--keep needs a number}; shift 2 ;;
    -h|--help) sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'backup.sh: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { printf 'backup.sh: docker is not installed\n' >&2; exit 1; }
docker ps --format '{{.Names}}' | grep -qx aster-controller || {
  printf 'backup.sh: the controller container is not running; start it (aster restart) and try again\n' >&2
  exit 1
}

[ -d "$HOME_DIR/backups" ] || {
  printf 'backup.sh: no %s/backups — is %s this appliance'\''s home? (--home names another one)\n' "$HOME_DIR" "$HOME_DIR" >&2
  exit 1
}

# bin/backup.js writes into <ASTER_HOME>/backups inside the container, which is this host's <home>/backups, and
# prunes to --keep itself; it prints the path it wrote — a container path, so the host path is printed here.
docker exec aster-controller node packages/controller/bin/backup.js --keep "$KEEP"

newest=$(ls -1t "$HOME_DIR"/backups/aster-*.tar.gz 2>/dev/null | head -1 || true)
if [ -n "$newest" ]; then
  printf 'backup.sh: %s (%s), keeping the newest %s\n' "$newest" "$(du -h "$newest" | cut -f1)" "$KEEP"
else
  printf 'backup.sh: the controller reported no error, but no archive appeared in %s/backups\n' "$HOME_DIR" >&2
  exit 1
fi
