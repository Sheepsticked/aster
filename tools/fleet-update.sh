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
#   -q, --quiet      one line per host and the summary; a host's output stays in its log, and a failed host's last lines are
#                    shown. By default each host's full output is shown as it arrives, every line marked with the host
#   -v, --verbose    also run ssh with -v and show the ssh commands, for connection trouble
#   --no-ask-sudo-pass
#                    do not ask for a sudo password. By default, on a terminal, each host that needs one is asked for it:
#                    typed here, not shown, Enter = the previous one; it goes to the host through the ssh connection,
#                    never on a command line or into a file. (-K, --ask-sudo-pass spell out that default.)
#   -l, --logs DIR   keep one log per host in DIR (default: a new directory under $TMPDIR); run.log there is a timeline
#   -o OPTION        an ssh option, as for `ssh -o` (repeatable)
#
# Examples:
#   tools/fleet-update.sh --check admin@192.0.2.10 admin@192.0.2.11   only check two hosts
#   tools/fleet-update.sh admin@192.0.2.10 admin@192.0.2.11           update them, one after another
#   tools/fleet-update.sh shop-1 shop-2                               names from ~/.ssh/config work too
#   tools/fleet-update.sh -f boxes.txt                                the hosts of a file, one per line
#   tools/fleet-update.sh -f boxes.txt -j 3 --keep-going --yes        three at a time, no question, skip failures
#   tools/fleet-update.sh ssh://admin@192.0.2.10:8222                 a host with its own ssh port
#   tools/fleet-update.sh -q -f boxes.txt                             one line per host and a summary only
#   tools/fleet-update.sh -v --check admin@192.0.2.10                 a check with ssh's own debug output
#   tools/fleet-update.sh --no-ask-sudo-pass -f boxes.txt             never ask for a sudo password (cron, CI)
#   tools/fleet-update.sh -o IdentityFile=~/.ssh/aster_key box-1      a key that is not the default
# A hosts file is plain text: `shop-1`, `admin@192.0.2.30`, one per line, blank lines and #-comments allowed.
#
# Every host is checked first (ssh works, `aster` is there, the login is root or can sudo); if one fails, nothing is updated.
# Then each host runs `aster update --yes`: back up, fetch or rebuild the images, restart into them, run doctor. Where
# the Asterisk image changes, calls in progress drop. The update runs detached on the host, so a lost connection does
# not stop it; `aster doctor` there says how it ended. Exit 0: every host is ok.
set -o pipefail

command -v ssh >/dev/null 2>&1 || { printf 'fleet-update: ssh is not installed\n' >&2; exit 1; }

die() { printf 'fleet-update: %s\n' "$*" >&2; exit 2; }
# The comment block at the top of this file, up to the first line of code.
usage() { sed -n '2,/^[^#]/{/^#/p;}' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

hosts=()
pass=()
sshopts=()
jobs=1
keep_going=0
check=0
assume_yes=0
ask_sudo=1
verbose=1    # 0 quiet, 1 the full output of each host, 2 also ssh's own debug output
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
    -K|--ask-sudo-pass) ask_sudo=1; shift ;;
    --no-ask-sudo-pass) ask_sudo=0; shift ;;
    -q|--quiet) verbose=0; shift ;;
    -v|--verbose) verbose=2; shift ;;
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

# A line of the timeline: always in run.log, and on the screen with --verbose.
note() {
  printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$logs/run.log"
  [ "$verbose" -lt 2 ] || printf '%s\n' "$*"
}
# A host's output as it arrives, every line marked with the host.
prefixed() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do printf '[%s] %s\n' "$1" "$line"; done
}
note "start: ${#hosts[@]} host(s), $jobs at a time; ssh options: ${sshopts[*]-none}; for aster update: ${pass[*]-nothing}"

# What runs on each host, as `sh -c SCRIPT fleet check|update LIVE [options]`; the first line of its input is the sudo
# password (empty: none). The update is detached and writes to a log there; LIVE=1 shows that log as it grows.
read -r -d '' REMOTE <<'EOF'
mode=$1; live=$2; shift 2
IFS= read -r pw
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif [ -n "$pw" ]; then printf '%s\n' "$pw" | sudo -S -p '' "$@"
  else sudo -n "$@"
  fi
}
aster=$(command -v aster) || { echo 'aster is not installed on this host' >&2; exit 127; }
if ! as_root true; then
  if [ -n "$pw" ]; then echo 'sudo refused the password' >&2
  else echo 'this user is not root and has no passwordless sudo' >&2
  fi
  exit 126
fi
if [ "$(id -u)" -eq 0 ]; then echo 'login: root'
elif [ -n "$pw" ]; then echo 'login: sudo, with the typed password'
else echo 'login: sudo without a password (a passwordless rule, or sudo still remembers a recent login)'
fi
if [ "$mode" = check ]; then echo "aster is at $aster"; exit 0; fi
log=$(mktemp "${TMPDIR:-/tmp}/aster-update.XXXXXX") || exit 1
echo "update log on this host: $log"
if [ "$(id -u)" -eq 0 ]; then
  nohup "$aster" update --yes "$@" >"$log" 2>&1 </dev/null &
elif [ -n "$pw" ]; then
  printf '%s\n' "$pw" | sudo -S -p '' nohup "$aster" update --yes "$@" >"$log" 2>&1 &
else
  sudo -n nohup "$aster" update --yes "$@" >"$log" 2>&1 </dev/null &
fi
pid=$!
if [ "$live" = 1 ]; then tail -n +1 -f "$log" & tailpid=$!; fi
wait $pid
rc=$?
if [ "$live" = 1 ]; then sleep 2; kill $tailpid 2>/dev/null; else cat "$log"; fi
rm -f "$log"
exit $rc
EOF
# The script as one single-quoted word of the remote command line.
REMOTE_WORD="'$(printf '%s' "$REMOTE" | sed "s/'/'\\\\''/g")'"

sudo_pass=()   # by host index: the password typed for it, if any

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
    126|127) printf 'FAILED: %s' "$(tail -n 1 "$log" 2>/dev/null)" ;;
    255)
      remote=$(sed -n 's/^update log on this host: //p' "$log" 2>/dev/null | head -n 1)
      if [ -n "$remote" ]; then
        printf 'CONNECTION LOST after %s; the update goes on there, `aster doctor` says how it ended (log: %s)' "$shown" "$remote"
      else
        printf 'UNREACHABLE: %s' "$(grep -v '^debug[0-9]*:' "$log" 2>/dev/null | tail -n 1)"
      fi ;;
    *) printf 'FAILED (exit %s after %s)' "$rc" "$shown" ;;
  esac
}

# Runs the host at index $1; leaves "<exit status> <seconds>" in its .status file and its output in its .log file,
# and shows the output as it arrives unless --quiet. The sudo password, if any, is the first line of the ssh input:
# a builtin writes it, so no process shows it.
run_host() {
  local i=$1 phase=$2 host stem start=$SECONDS rc took log live=0 given=none
  host=${hosts[$i]}
  stem=${stems[$i]}
  log="$logs/$stem.$phase.log"
  [ "$verbose" -eq 0 ] || live=1
  [ -z "${sudo_pass[$i]-}" ] || given=sent
  local -a ssh_cmd=(ssh ${sshopts[@]+"${sshopts[@]}"} -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
  [ "$verbose" -lt 2 ] || ssh_cmd+=(-v)
  [ "$phase" = check ] || printf '[%s] updating\n' "$host"
  note "[$host] $phase: ${ssh_cmd[*]} $host sh -c <script> fleet $phase $live ${pass[*]-} (sudo password: $given)"
  if [ "$live" -eq 1 ]; then
    printf '%s\n' "${sudo_pass[$i]-}" |
      "${ssh_cmd[@]}" "$host" "sh -c $REMOTE_WORD fleet $phase $live ${pass[*]-}" 2>&1 | tee "$log" | prefixed "$host"
    rc=${PIPESTATUS[1]}
  else
    printf '%s\n' "${sudo_pass[$i]-}" |
      "${ssh_cmd[@]}" "$host" "sh -c $REMOTE_WORD fleet $phase $live ${pass[*]-}" >"$log" 2>&1
    rc=${PIPESTATUS[1]}
  fi
  took=$((SECONDS - start))
  printf '%s %s\n' "$rc" "$took" >"$logs/$stem.$phase.status"
  note "[$host] $phase finished: exit $rc after ${took}s"
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
    if [ "$phase" = update ] && [ "$keep_going" -eq 0 ] && update_failed; then
      note "[${hosts[$i]}] not started: an earlier update failed"
      continue
    fi
    run_host "$i" "$phase" &
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

# A host whose sudo wants a password (exit 126) is asked for one, on a terminal, and checked again.
needing=()
for i in "${all[@]}"; do
  read -r rc _ <"$logs/${stems[$i]}.check.status"
  [ "$rc" != 126 ] || needing+=("$i")
done
if [ "${#needing[@]}" -gt 0 ]; then
  if [ "$ask_sudo" -eq 1 ] && [ -t 0 ]; then
    previous=''
    for i in "${needing[@]}"; do
      hint=''
      [ -z "$previous" ] || hint=' (Enter: the same as before)'
      printf 'sudo password for %s%s: ' "${hosts[$i]}" "$hint" >&2
      IFS= read -r -s typed
      printf '\n' >&2
      if [ -n "$typed" ]; then note "[${hosts[$i]}] sudo password typed"; else note "[${hosts[$i]}] sudo password: the same as before"; fi
      [ -n "$typed" ] || typed=$previous
      sudo_pass[i]=$typed
      previous=$typed
    done
    unset typed previous
    printf 'checking %d host(s) again with the password\n' "${#needing[@]}"
    run_phase check "$width" "${needing[@]}"
  else
    note "${#needing[@]} host(s) cannot use sudo without a password and none was asked for"
    printf 'fleet-update: %d host(s) cannot use sudo without a password; one is asked for only on a terminal, and not with --no-ask-sudo-pass\n' \
      "${#needing[@]}" >&2
  fi
fi

ready=()
refused=()
for i in "${all[@]}"; do
  read -r rc _ <"$logs/${stems[$i]}.check.status"
  if [ "$rc" = 0 ]; then ready+=("$i"); else refused+=("$i"); fi
done
note "check: ${#ready[@]} host(s) ready, ${#refused[@]} not"

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
  printf '\nlogs: %s (run.log is the timeline)\n' "$logs"
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
note "update: ${#ready[@]} host(s), $jobs at a time"
run_phase update "$jobs" "${ready[@]}"

summary update
status=$?
# The output of a failed host was already shown unless --quiet: then its last lines are.
for i in "${ready[@]}"; do
  [ "$verbose" -eq 0 ] || break
  [ -e "$logs/${stems[$i]}.update.status" ] || continue
  read -r rc _ <"$logs/${stems[$i]}.update.status"
  [ "$rc" != 0 ] || continue
  printf '\n== %s: the last lines of %s\n' "${hosts[$i]}" "$logs/${stems[$i]}.update.log"
  tail -n 12 "$logs/${stems[$i]}.update.log"
done
printf '\nlogs: %s (run.log is the timeline)\n' "$logs"
exit "$status"
