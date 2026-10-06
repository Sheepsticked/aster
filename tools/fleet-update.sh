#!/usr/bin/env bash
# Aster — fleet-update: run `aster update` on several appliances over SSH, from a machine that already has the logins.
#
# Usage: tools/fleet-update.sh [options] [HOST...]
#   HOST             where to log in: user@host, or a name from ~/.ssh/config (keys, ports and jump hosts live there)
#   -f, --file FILE  hosts from a file, one per line; blank lines and #-comments are skipped
#   -j, --jobs N     update N hosts at once (default 1)
#   --pull | --build | --force
#                    handed to `aster update` (default: each appliance keeps the way it was installed)
#   -k, --keep-going update the hosts that pass the check even when some fail it, and go on after a failed update
#   -n, --check      only check that every host answers and has `aster`; updates nothing
#   -y, --yes        do not ask first
#   -l, --logs DIR   keep one log per host in DIR (default: a new directory under $TMPDIR)
#   -o OPTION        an ssh option, as for `ssh -o` (repeatable)
#
# Every host is checked first (ssh works, `aster` is there, root or passwordless sudo); if one fails, nothing is updated.
# Then each host runs `aster update --yes`: back up, fetch or rebuild the images, restart into them, run doctor. Where
# the Asterisk image changes, calls in progress drop. The update runs detached on the host, so a lost connection does
# not stop it; `aster doctor` there says how it ended. Exit 0: every host is ok.
set -o pipefail

command -v ssh >/dev/null 2>&1 || { printf 'fleet-update: ssh is not installed\n' >&2; exit 1; }

die() { printf 'fleet-update: %s\n' "$*" >&2; exit 2; }
usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

hosts=()
pass=()
sshopts=()
jobs=1
keep_going=0
check=0
assume_yes=0
logs=''

while [ $# -gt 0 ]; do
  case $1 in
    -f|--file)
      [ -n "${2:-}" ] || die "$1 needs a file"
      [ -r "$2" ] || die "cannot read $2"
      while IFS= read -r line || [ -n "$line" ]; do
        line=${line%%#*}
        line=${line#"${line%%[![:space:]]*}"}; line=${line%"${line##*[![:space:]]}"}
        [ -z "$line" ] || hosts+=("$line")
      done <"$2"
      shift 2 ;;
    -j|--jobs) [ -n "${2:-}" ] || die "$1 needs a number"; jobs=$2; shift 2 ;;
    --pull|--build|--force) pass+=("$1"); shift ;;
    -k|--keep-going) keep_going=1; shift ;;
    -n|--check) check=1; shift ;;
    -y|--yes) assume_yes=1; shift ;;
    -l|--logs) [ -n "${2:-}" ] || die "$1 needs a directory"; logs=$2; shift 2 ;;
    -o) [ -n "${2:-}" ] || die "-o needs an ssh option"; sshopts+=(-o "$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (--help lists them)" ;;
    *) hosts+=("$1"); shift ;;
  esac
done

case $jobs in ''|*[!0-9]*|0) die "--jobs needs a number of 1 or more" ;; esac
[ "${#hosts[@]}" -gt 0 ] || die "no host given (name them, or use --file; --help)"

# One entry per host, in the order given; a name that starts with "-" would be read by ssh as an option.
unique=()
for host in "${hosts[@]}"; do
  case $host in -*|*[[:space:]]*) die "not a host name: $host" ;; esac
  seen=0
  for known in ${unique[@]+"${unique[@]}"}; do [ "$known" = "$host" ] && seen=1; done
  [ "$seen" -eq 1 ] || unique+=("$host")
done
hosts=("${unique[@]}")

if [ "$check" -eq 0 ] && [ "$assume_yes" -eq 0 ] && [ ! -t 0 ]; then
  die "it asks before it updates, and there is no terminal to ask on; pass --yes"
fi

[ -n "$logs" ] || logs=$(mktemp -d "${TMPDIR:-/tmp}/aster-fleet.XXXXXX") || die "cannot make a log directory"
mkdir -p "$logs" || die "cannot make $logs"

# What runs on each host, as `sh -s -- check|update [options]`. The update is detached and writes to a log there.
read -r -d '' REMOTE <<'EOF'
mode=$1; shift
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
aster=$(command -v aster) || { echo 'aster is not installed on this host' >&2; exit 127; }
as_root true || { echo 'this user is not root and has no passwordless sudo' >&2; exit 126; }
if [ "$mode" = check ]; then echo "aster is at $aster"; exit 0; fi
log=$(mktemp "${TMPDIR:-/tmp}/aster-update.XXXXXX") || exit 1
echo "update log on this host: $log"
as_root nohup "$aster" update --yes "$@" >"$log" 2>&1 </dev/null &
wait $!
rc=$?
cat "$log"
rm -f "$log"
exit $rc
EOF

# Stems name the files of a host ("001-name"); hosts and stems share an index.
stems=()
index=0
for host in "${hosts[@]}"; do
  index=$((index + 1))
  stems+=("$(printf '%03d-%s' "$index" "$(printf '%s' "$host" | tr -c 'A-Za-z0-9._@-' '_')")")
done

# One line saying what a host's exit status means. $1 status, $2 seconds, $3 check|update, $4 its log file.
describe() {
  local rc=$1 took=$2 phase=$3 log=$4 shown remote
  shown=$(printf '%dm%02ds' "$((took / 60))" "$((took % 60))")
  case $rc in
    0) if [ "$phase" = check ]; then printf 'ok'; else printf 'updated in %s' "$shown"; fi ;;
    126) printf 'FAILED: no root and no passwordless sudo' ;;
    127) printf 'FAILED: aster is not installed' ;;
    255)
      remote=$(sed -n 's/^update log on this host: //p' "$log" 2>/dev/null | head -n 1)
      if [ -n "$remote" ]; then
        printf 'CONNECTION LOST after %s; the update goes on there, `aster doctor` says how it ended (log: %s)' "$shown" "$remote"
      else
        printf 'UNREACHABLE: %s' "$(tail -n 1 "$log" 2>/dev/null)"
      fi ;;
    *) printf 'FAILED (exit %s after %s)' "$rc" "$shown" ;;
  esac
}

# Runs one host; leaves "<exit status> <seconds>" in its .status file and its output in its .log file.
run_host() {
  local host=$1 stem=$2 phase=$3 start=$SECONDS rc took log="$logs/$2.$3.log"
  [ "$phase" = check ] || printf '[%s] updating\n' "$host"
  ssh ${sshopts[@]+"${sshopts[@]}"} -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    "$host" sh -s -- "$phase" ${pass[@]+"${pass[@]}"} <<<"$REMOTE" >"$log" 2>&1
  rc=$?
  took=$((SECONDS - start))
  printf '%s %s\n' "$rc" "$took" >"$logs/$stem.$phase.status"
  printf '[%s] %s\n' "$host" "$(describe "$rc" "$took" "$phase" "$log")"
}

# True when some host has finished its update with a status other than 0.
update_failed() {
  local file rc
  for file in "$logs"/*.update.status; do
    [ -e "$file" ] || continue
    read -r rc _ <"$file"
    [ "$rc" = 0 ] || return 0
  done
  return 1
}

# Runs a phase over the hosts at the given indexes, $2 at a time. An update stops starting hosts after a failure.
run_phase() {
  local phase=$1 width=$2 i
  shift 2
  for i in "$@"; do
    while [ "$(jobs -rp | wc -l)" -ge "$width" ]; do sleep 0.2; done
    if [ "$phase" = update ] && [ "$keep_going" -eq 0 ] && update_failed; then continue; fi
    run_host "${hosts[$i]}" "${stems[$i]}" "$phase" &
  done
  wait
}

# Ctrl-C stops what this machine started; an update that is already running on a host goes on there.
trap 'kill $(jobs -p) 2>/dev/null; printf "\nfleet-update: interrupted; an update already running on a host goes on there (aster doctor)\n" >&2; exit 130' INT TERM

all=()
for i in "${!hosts[@]}"; do all+=("$i"); done

printf 'checking %d host(s); logs in %s\n' "${#hosts[@]}" "$logs"
# A check changes nothing, so it can run wide: the slow part is a host that does not answer.
width=$jobs; [ "$width" -ge 8 ] || width=8
run_phase check "$width" "${all[@]}"

ready=()
refused=()
for i in "${all[@]}"; do
  read -r rc _ <"$logs/${stems[$i]}.check.status"
  if [ "$rc" = 0 ]; then ready+=("$i"); else refused+=("$i"); fi
done

# The result per host, one line each; $1 is "check" to show the check only. Fails unless every host is ok.
summary() {
  local i rc took stem ok=0 bad=0 idle=0
  printf '\n== summary\n'
  for i in "${all[@]}"; do
    stem=${stems[$i]}
    read -r rc took <"$logs/$stem.check.status"
    if [ "$rc" != 0 ]; then
      printf '%-24s %s\n' "${hosts[$i]}" "$(describe "$rc" "$took" check "$logs/$stem.check.log")"
      bad=$((bad + 1))
    elif [ "$1" = check ]; then
      printf '%-24s ok\n' "${hosts[$i]}"
      ok=$((ok + 1))
    elif [ ! -e "$logs/$stem.update.status" ]; then
      printf '%-24s not started (an earlier update failed; --keep-going goes on)\n' "${hosts[$i]}"
      idle=$((idle + 1))
    else
      read -r rc took <"$logs/$stem.update.status"
      printf '%-24s %s\n' "${hosts[$i]}" "$(describe "$rc" "$took" update "$logs/$stem.update.log")"
      if [ "$rc" = 0 ]; then ok=$((ok + 1)); else bad=$((bad + 1)); fi
    fi
  done
  printf '%d ok, %d failed, %d not started\n' "$ok" "$bad" "$idle"
  [ "$bad" -eq 0 ] && [ "$idle" -eq 0 ]
}

if [ "$check" -eq 1 ]; then
  summary check
  status=$?
  printf '\nlogs: %s\n' "$logs"
  exit "$status"
fi

if [ "${#refused[@]}" -gt 0 ] && [ "$keep_going" -eq 0 ]; then
  summary check
  printf '\nfleet-update: nothing was updated; %d host(s) failed the check.\n' "${#refused[@]}" >&2
  printf 'Fix them, or use --keep-going to update the others. Logs: %s\n' "$logs" >&2
  exit 1
fi
if [ "${#ready[@]}" -eq 0 ]; then
  printf '\nfleet-update: no host passed the check; nothing was updated\n' >&2
  exit 1
fi

if [ "$assume_yes" -eq 0 ]; then
  names=''
  for i in "${ready[@]}"; do names="$names ${hosts[$i]}"; done
  printf '\nUpdate %d host(s) with `aster update --yes`:%s\n' "${#ready[@]}" "$names"
  printf 'Where the Asterisk image changes, calls in progress drop. Continue? [y/N] '
  read -r answer
  case $answer in y|Y|yes|YES) ;; *) printf 'fleet-update: nothing was done\n'; exit 0 ;; esac
fi

printf '\nupdating %d host(s), %d at a time\n' "${#ready[@]}" "$jobs"
run_phase update "$jobs" "${ready[@]}"

summary update
status=$?
for i in "${ready[@]}"; do
  [ -e "$logs/${stems[$i]}.update.status" ] || continue
  read -r rc _ <"$logs/${stems[$i]}.update.status"
  [ "$rc" != 0 ] || continue
  printf '\n== %s: the last lines of %s\n' "${hosts[$i]}" "$logs/${stems[$i]}.update.log"
  tail -n 12 "$logs/${stems[$i]}.update.log"
done
printf '\nlogs: %s\n' "$logs"
exit "$status"
