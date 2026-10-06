#!/usr/bin/env bash
# Aster — tests for tools/fleet-update.sh against a stand-in ssh that runs the remote script locally with a fake `aster`.
# Covers the arguments handed on, the order and failure rules, parallel runs, --check, and how each kind of failure is named.
#
# Usage: bash test/install/fleet-update.test.sh
set -uo pipefail

REPO=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
FLEET="$REPO/tools/fleet-update.sh"
WORK=$(mktemp -d)
failed=0
ran=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

check() {
  ran=$((ran + 1))
  if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s], got [%s]\n' "$1" "$3" "$2" >&2; failed=$((failed + 1)); fi
}
contains() {
  ran=$((ran + 1))
  case $2 in *"$3"*) printf 'ok   %s\n' "$1" ;; *) printf 'FAIL %s: [%s] is not in [%s]\n' "$1" "$3" "$2" >&2; failed=$((failed + 1)) ;; esac
}
lacks() {
  ran=$((ran + 1))
  case $2 in *"$3"*) printf 'FAIL %s: [%s] is in [%s]\n' "$1" "$3" "$2" >&2; failed=$((failed + 1)) ;; *) printf 'ok   %s\n' "$1" ;; esac
}

# ---- the stand-ins -----------------------------------------------------------------------------------

LOCAL="$WORK/local"      # what this machine has: an ssh that "connects" by running the command here
REMOTE="$WORK/remote"    # what a host has: aster, and sudo for a user that is not root
EMPTY="$WORK/empty"      # a PATH with a shell and nothing else
mkdir -p "$LOCAL" "$REMOTE" "$EMPTY"
ln -s /bin/sh "$EMPTY/sh"
export FAKE_CALLS="$WORK/calls"

cat >"$LOCAL/ssh" <<'EOF'
#!/bin/sh
# ssh [-o option]... host command...: records the call, then runs the command as that host (down* refuse the connection,
# drop* lose it once the update has started).
echo "$*" >>"$FAKE_CALLS/ssh"
while [ "$1" = -o ]; do shift 2; done
host=$1; shift
case $host in
  down*) echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255 ;;
esac
export FAKE_HOST=$host
case "$host $*" in
  "drop"*" fleet update"*) echo "update log on this host: /tmp/aster-update.fake"; exit 255 ;;
esac
# A host's PATH never holds the real aster launcher a developer machine may have in /usr/local/bin.
case $host in
  noaster*) PATH=$FAKE_EMPTY exec /bin/sh -c "$*" ;;
  *) PATH="$FAKE_REMOTE:/usr/bin:/bin" exec /bin/sh -c "$*" ;;
esac
EOF
cat >"$REMOTE/sudo" <<'EOF'
#!/bin/sh
# sudo -n CMD, or sudo -S -p '' CMD with the password on the first line of stdin. pw* hosts want the password "secret",
# pwq* hosts one with quotes and a dollar sign in it; nosudo* hosts refuse everything.
echo "$FAKE_HOST $*" >>"$FAKE_CALLS/sudo"
case $FAKE_HOST in
  nosudo*) exit 1 ;;
  pwq*) want='it'\''s a "pass" $HOME' ;;
  pw*) want=secret ;;
  *) want= ;;
esac
if [ "$1" = -S ]; then
  shift 3
  IFS= read -r given
  if [ -n "$want" ] && [ "$given" != "$want" ]; then echo 'Sorry, try again.' >&2; exit 1; fi
elif [ "$1" = -n ]; then
  shift
  if [ -n "$want" ]; then echo 'sudo: a password is required' >&2; exit 1; fi
fi
exec "$@"
EOF
cat >"$REMOTE/aster" <<'EOF'
#!/bin/sh
echo "$FAKE_HOST $*" >>"$FAKE_CALLS/aster"
case $FAKE_HOST in
  bad*) echo 'doctor: something is wrong'; exit 1 ;;
  slow*) echo "$FAKE_HOST start $(date +%s%N)" >>"$FAKE_CALLS/times"; sleep 2; echo "$FAKE_HOST end $(date +%s%N)" >>"$FAKE_CALLS/times" ;;
esac
echo 'the appliance is up to date'
EOF
chmod +x "$LOCAL/ssh" "$REMOTE/sudo" "$REMOTE/aster"
export FAKE_REMOTE="$REMOTE" FAKE_EMPTY="$EMPTY"

# Runs the script on the stand-ins with no terminal; sets $out and $status. $WORK/calls starts empty each time.
run() {
  rm -rf "$FAKE_CALLS" "$WORK/logs"; mkdir -p "$FAKE_CALLS"
  out=$(PATH="$LOCAL:$PATH" timeout 120 "$FLEET" -l "$WORK/logs" "$@" </dev/null 2>&1)
  status=$?
}
calls() { cat "$FAKE_CALLS/$1" 2>/dev/null || true; }

# ---- the arguments -----------------------------------------------------------------------------------

printf '== arguments\n'
run
check "no host: refused" "$status" 2
contains "no host: says so" "$out" "no host given"
run ok1
check "no terminal and no --yes: refused" "$status" 2
contains "no terminal: asks for --yes" "$out" "pass --yes"
check "nothing was started without the question" "$(calls ssh)" ""
printf -- '-oProxyCommand=x\n' >"$WORK/option-host"
run -y -f "$WORK/option-host"
check "a host that reads as an ssh option: refused" "$status" 2
contains "and called what it is" "$out" "not a host name"
run -y --nonsense ok1
check "an unknown option: refused" "$status" 2
help=$("$FLEET" --help 2>&1)
check "--help: exit 0" "$?" 0
contains "--help lists the options" "$help" "--keep-going"
contains "--help gives examples" "$help" "Examples:"
contains "--help shows how to run it on hosts" "$help" "tools/fleet-update.sh -f boxes.txt"
check "--help stops at the end of the comment block" "$(printf '%s' "$help" | grep -c 'pipefail')" 0
run -y -j 0 ok1
check "--jobs 0: refused" "$status" 2
run -y ok1 -j
check "--jobs without a number: refused, not stuck" "$status" 2

# ---- a plain update ----------------------------------------------------------------------------------

printf '== update\n'
run -y ok1 ok2
check "two good hosts: exit 0" "$status" 0
check "each host ran aster update --yes, in the order given" "$(calls aster)" "ok1 update --yes
ok2 update --yes"
contains "the summary says updated" "$out" "ok1"
contains "the output of a host is kept in its log" "$(cat "$WORK/logs/001-ok1.update.log" 2>/dev/null || true)" "the appliance is up to date"
contains "and says where the update's own log is on the host" "$(cat "$WORK/logs/001-ok1.update.log" 2>/dev/null || true)" "update log on this host:"
contains "ssh never prompts" "$(calls ssh)" "BatchMode=yes"
if [ "$(id -u)" -ne 0 ]; then contains "a user that is not root goes through sudo" "$(calls sudo)" "ok1"; fi

printf '== what is handed on\n'
run -y --pull --force ok1
check "--pull and --force reach aster update" "$(calls aster)" "ok1 update --yes --pull --force"
run -y -o IdentityFile=/nonexistent ok1
contains "an ssh option reaches ssh, before the defaults" "$(calls ssh)" "-o IdentityFile=/nonexistent -o BatchMode=yes"

printf '== hosts from a file\n'
printf '# the shop\nok1\n\n  ok2   # with a note\nok1\n' >"$WORK/hosts"
run -y -f "$WORK/hosts" ok3
check "comments, blanks and repeats are dropped" "$(calls aster)" "ok1 update --yes
ok2 update --yes
ok3 update --yes"

# ---- the question ------------------------------------------------------------------------------------

# The question is only asked on a terminal, so these run on a pseudo-terminal fed with the answer.
if command -v script >/dev/null 2>&1; then
  printf '== the question\n'
  ask() {
    rm -rf "$FAKE_CALLS" "$WORK/logs"; mkdir -p "$FAKE_CALLS"
    out=$(printf '%s\n' "$1" | PATH="$LOCAL:$PATH" timeout 120 script -qec "$FLEET -l $WORK/logs ok1 ok2" /dev/null 2>&1)
    status=$?
  }
  ask n
  check "answering no: exit 0" "$status" 0
  check "answering no updates nothing" "$(calls aster)" ""
  contains "answering no says so" "$out" "nothing was done"
  ask y
  check "answering yes: exit 0" "$status" 0
  check "answering yes updates the hosts" "$(calls aster)" "ok1 update --yes
ok2 update --yes"
  contains "the question names the hosts" "$out" "Update 2 host(s) with"

  # A sudo password is typed on the terminal: $1 is what is typed, the rest are the arguments. It is sent after a pause,
  # as a person types: input that is already waiting is echoed before the prompt turns the echo off. Not for root.
  typed() {
    local input=$1
    shift
    rm -rf "$FAKE_CALLS" "$WORK/logs"; mkdir -p "$FAKE_CALLS"
    out=$({ sleep 3; printf '%s' "$input"; } | PATH="$LOCAL:$PATH" timeout 120 script -qec "$FLEET -l $WORK/logs $*" /dev/null 2>&1)
    status=$?
  }
  if [ "$(id -u)" -ne 0 ]; then
    printf '== the sudo password\n'
    typed $'secret\n\n' -y -K pw1 pw2 ok1
    check "-K: exit 0" "$status" 0
    check "-K: the hosts that needed a password and the one that did not are all updated" "$(calls aster)" "pw1 update --yes
pw2 update --yes
ok1 update --yes"
    contains "-K asks for the first host's password" "$out" "sudo password for pw1: "
    contains "-K offers the previous password for the next host" "$out" "sudo password for pw2 (Enter: the same as before): "
    lacks "-K asks nothing of a host that needs none" "$out" "sudo password for ok1"
    lacks "the password is not shown on the terminal" "$out" "secret"
    lacks "the password is on no ssh command line" "$(calls ssh)" "secret"
    lacks "the password is in no log" "$(cat "$WORK"/logs/* 2>/dev/null)" "secret"
    contains "the host got it through sudo -S" "$(calls sudo)" "pw1 -S"

    typed $'wrong\n' -y -K pw1 ok1
    check "a refused password: exit 1" "$status" 1
    contains "a refused password is named" "$out" "sudo refused the password"
    check "and nothing is updated" "$(calls aster)" ""

    typed $'it\'s a "pass" $HOME\n' -y -K pwq1
    check "a password with quotes and a dollar sign gets through as typed" "$status" 0
    check "and the host is updated" "$(calls aster)" "pwq1 update --yes"

    typed '' -y -K ok1 ok2
    check "-K with no host that needs a password asks for nothing: exit 0" "$status" 0
    lacks "-K asks for nothing" "$out" "sudo password for"
  fi
fi

if [ "$(id -u)" -ne 0 ]; then
  run -y -K pw1
  check "-K without a terminal: refused" "$status" 2
  contains "-K without a terminal says why" "$out" "needs a terminal"
  run -y pw1 ok1
  check "a host that needs a password, without -K: exit 1" "$status" 1
  contains "it says how to be asked for one" "$out" "--ask-sudo-pass asks for a password"
  check "and nothing is updated" "$(calls aster)" ""
fi

# ---- failures ----------------------------------------------------------------------------------------

printf '== failures\n'
run -y bad1 ok1
check "a failed update: exit 1" "$status" 1
check "the host after a failed update is not started" "$(calls aster)" "bad1 update --yes"
contains "and is reported as not started" "$out" "ok1                      not started"
contains "the failure shows the end of its log" "$out" "doctor: something is wrong"
contains "the summary counts them" "$out" "0 ok, 1 failed, 1 not started"

run -y -k bad1 ok1
check "--keep-going: exit 1" "$status" 1
check "--keep-going goes on to the next host" "$(calls aster)" "bad1 update --yes
ok1 update --yes"

run -y -k drop1 ok1
check "a lost connection: exit 1" "$status" 1
contains "a lost connection is named, with the log on the host" "$out" "CONNECTION LOST after 0m00s; the update goes on there, \`aster doctor\` says how it ended (log: /tmp/aster-update.fake)"
contains "the next host is updated" "$(calls aster)" "ok1 update --yes"

# ---- the check before anything is updated -------------------------------------------------------------

printf '== the check first\n'
run -y ok1 down1
check "an unreachable host: exit 1" "$status" 1
check "nothing is updated, not even the host before it" "$(calls aster)" ""
contains "the host is named with ssh's own message" "$out" "UNREACHABLE: ssh: connect to host down1 port 22: Connection refused"
contains "and it says nothing was updated" "$out" "nothing was updated; 1 host(s) failed the check"

run -y ok1 noaster1
check "a host without aster: exit 1" "$status" 1
check "nothing is updated for it either" "$(calls aster)" ""
contains "a host without aster is named" "$out" "FAILED: aster is not installed"
if [ "$(id -u)" -ne 0 ]; then
  run -y nosudo1 ok1
  check "a user without sudo: exit 1" "$status" 1
  contains "a user without sudo is named, with the way out" "$out" "FAILED: this user is not root and has no passwordless sudo (--ask-sudo-pass asks for a password)"
  check "and nothing was updated" "$(calls aster)" ""
fi

run -y -k down1 ok1
check "--keep-going with a host that fails the check: exit 1" "$status" 1
check "--keep-going updates the hosts that pass it" "$(calls aster)" "ok1 update --yes"
contains "and still reports the one that failed" "$out" "down1"
run -y -k down1 noaster1
check "no host passes the check: exit 1" "$status" 1
check "nothing was updated" "$(calls aster)" ""

printf '== check only\n'
run -n ok1 ok2
check "--check of good hosts: exit 0, with no question asked" "$status" 0
check "--check updates nothing" "$(calls aster)" ""
contains "--check says how many are ok" "$out" "2 ok, 0 failed, 0 not started"
run -n ok1 down1 noaster1
check "--check with bad hosts: exit 1" "$status" 1
contains "--check names an unreachable host" "$out" "UNREACHABLE: ssh: connect to host down1"
contains "--check names a host without aster" "$out" "FAILED: aster is not installed"
contains "--check still reports the good host" "$out" "ok1                      ok"

# ---- parallel ----------------------------------------------------------------------------------------

printf '== parallel\n'
run -y -j 2 slow1 slow2
check "two hosts at once: exit 0" "$status" 0
start2=$(sed -n 's/^slow2 start //p' "$FAKE_CALLS/times" 2>/dev/null)
end1=$(sed -n 's/^slow1 end //p' "$FAKE_CALLS/times" 2>/dev/null)
check "the second host starts before the first one ends" "$([ -n "$start2" ] && [ -n "$end1" ] && [ "$start2" -lt "$end1" ] && echo overlap || echo apart)" overlap
run -y slow1 slow2
start2=$(sed -n 's/^slow2 start //p' "$FAKE_CALLS/times" 2>/dev/null)
end1=$(sed -n 's/^slow1 end //p' "$FAKE_CALLS/times" 2>/dev/null)
check "one at a time by default" "$([ -n "$start2" ] && [ -n "$end1" ] && [ "$start2" -ge "$end1" ] && echo apart || echo overlap)" apart

printf '\n%d checks, %d failed\n' "$ran" "$failed"
[ "$failed" -eq 0 ]
