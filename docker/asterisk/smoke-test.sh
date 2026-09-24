#!/bin/sh
# Aster — container smoke test for the Asterisk image.
#
# Boots <image> with docker/asterisk/test-config mounted read-only and empty tmpfs for state, spool and logs (like the
# empty bind mounts of a fresh install), then checks: the pinned version, the user Asterisk runs as, the modules, AMI
# login, the configuration the controller generated into test-config/aster.d from docker/asterisk/test-registry.yaml
# (dialplan contexts, PJSIP endpoints, the device sections of both drivers with their UAC, unmapped
# and ports variants), music on hold, aster-emit's validation and atomic write, the dialplan -> aster-emit path for all
# three event kinds, where a hostile CALLERID and a hostile SMS sender must reach the spool only as base64, and every
# reload action of the controller's reload map. The DongleAtCommand/QuectelAtCommand actions of the driver patches
# are checked through their documentation and every error path a stopped device can answer; a real AT exchange
# needs hardware.
#
# Usage: docker/asterisk/smoke-test.sh <image>
# Environment:
#   SMOKE_BOOT_TIMEOUT  seconds to wait until Asterisk is fully booted (default 300; arm64 under QEMU is slow)
#   SMOKE_SPOOL_OUT     directory that receives the .evt files written by the dialplan cases (input for tests)
#   SMOKE_KEEP=1        leave the container running afterwards
# Exit status: 0 all checks passed, 1 a check failed, 2 usage or environment error.
# shellcheck disable=SC2016  # single quotes are intended: hostile strings and `sh -c` scripts must not expand here
set -eu

[ $# -eq 1 ] && [ -n "$1" ] || { echo "usage: $0 <image>" >&2; exit 2; }
image=$1
cfg=$(cd "$(dirname "$0")" && pwd)/test-config
[ -f "$cfg/extensions.conf" ] || { echo "smoke-test: $cfg not found" >&2; exit 2; }
platform=$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$image" 2>/dev/null) ||
  { echo "smoke-test: image '$image' not found" >&2; exit 2; }
version=$(docker image inspect -f '{{index .Config.Labels "aster.asterisk.version"}}' "$image")
boot_timeout=${SMOKE_BOOT_TIMEOUT:-300}
c=aster-smoke-$$
spool=/var/spool/aster/events
tab=$(printf '\t')
nl='
'
passed=0
failed=0

# ---- reporting ----
pass() { passed=$((passed + 1)); printf 'ok    %s\n' "$1"; }
fail() {
  failed=$((failed + 1))
  printf 'FAIL  %s\n' "$1"
  [ $# -lt 2 ] || printf '%s\n' "$2" | sed 's/^/      | /'
}
info() { printf 'info  %s\n' "$1"; }
die() { fail "$1"; exit 1; }
# check_match <description> <text> <ERE>...: every ERE matches at least one line of <text>
check_match() {
  desc=$1 text=$2
  shift 2
  for re in "$@"; do
    printf '%s\n' "$text" | grep -Eq -- "$re" || { fail "$desc: nothing matches /$re/" "$text"; return 0; }
  done
  pass "$desc"
}
# check_eq <description> <got> <want>
check_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "got:  $2${nl}want: $3"; fi
}

# ---- container ----
x() { docker exec "$c" "$@"; }
cli() { docker exec "$c" asterisk -rx "$1"; }
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ] || [ "$failed" -ne 0 ]; then
    echo "---- container log (last 150 lines) ----"
    docker logs --tail 150 "$c" 2>&1 || true
  fi
  if [ "${SMOKE_KEEP:-0}" = 1 ]; then
    echo "smoke-test: container $c kept"
  else
    docker rm -fv "$c" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

echo "smoke-test: $image ($platform, Asterisk ${version:-unknown})"
docker run -d --name "$c" --platform "$platform" \
  --mount "type=bind,source=$cfg,target=/etc/asterisk,readonly" \
  --mount type=tmpfs,target=/var/lib/asterisk \
  --mount type=tmpfs,target=/var/spool/aster,tmpfs-mode=0755 \
  --mount type=tmpfs,target=/var/log/asterisk \
  "$image" >/dev/null || die "docker run failed"
start=$(date +%s)
until x asterisk -rx 'core waitfullybooted' >/dev/null 2>&1; do
  [ "$(docker inspect -f '{{.State.Running}}' "$c")" = true ] || die "container exited during boot"
  [ $(($(date +%s) - start)) -lt "$boot_timeout" ] || die "not fully booted within ${boot_timeout}s"
  sleep 2
done
pass "fully booted after $(($(date +%s) - start))s"

# ---- image, modules, AMI ----
check_match "Asterisk version is the pinned one ($version)" "$(cli 'core show version')" \
  "^Asterisk $(printf '%s' "$version" | sed 's/\./\\./g') "
check_match "healthcheck command answers" "$(cli 'core show uptime')" '^System uptime: '
# The entrypoint execs Asterisk, which drops to its own user for good and keeps dialout and audio for the modems.
check_match "Asterisk runs as the asterisk user, in dialout and audio" "$(x cat /proc/1/status)" \
  '^Uid:[[:space:]]+5060[[:space:]]+5060[[:space:]]+5060[[:space:]]+5060$' \
  '^Groups:(.*[[:space:]])?20([[:space:]]|$)' '^Groups:(.*[[:space:]])?29([[:space:]]|$)'
modules=$(cli 'module show')
check_match "channel drivers Running: chan_pjsip, chan_quectel, chan_dongle" "$modules" \
  '^chan_pjsip\.so .* Running ' '^chan_quectel\.so .* Running ' '^chan_dongle\.so .* Running '
check_match "modules used by the generated dialplan Running" "$modules" \
  '^pbx_config\.so .* Running ' '^app_dial\.so .* Running ' '^app_system\.so .* Running ' \
  '^app_stack\.so .* Running ' '^app_exec\.so .* Running ' '^app_verbose\.so .* Running ' \
  '^func_base64\.so .* Running ' '^func_callerid\.so .* Running ' '^func_cdr\.so .* Running ' \
  '^func_channel\.so .* Running ' '^res_musiconhold\.so .* Running ' '^res_clioriginate\.so .* Running ' \
  '^func_jitterbuffer\.so .* Running '
check_match "app_record for the call audio check Running" "$modules" '^app_record\.so .* Running '
check_match "MWI handler for phones' voicemail subscriptions Running" "$modules" \
  '^res_pjsip_mwi\.so .* Running ' '^res_pjsip_mwi_body_generator\.so .* Running '
if printf '%s\n' "$modules" | grep -q '^res_pjsip_endpoint_identifier_anonymous\.so '; then
  fail "the anonymous PJSIP endpoint identifier is loaded"
else
  pass "no anonymous PJSIP endpoint identifier"
fi
check_match "driver AMI actions registered" "$(cli 'manager show commands')" \
  '(^|[[:space:]])DongleSendSMS([[:space:]]|$)' '(^|[[:space:]])QuectelSendSMS([[:space:]]|$)' \
  '(^|[[:space:]])DongleShowDevices([[:space:]]|$)' '(^|[[:space:]])QuectelShowDevices([[:space:]]|$)'

# ami <username> <secret>: Login + Logoff over TCP from inside the container; prints the transcript without CRs
ami() {
  x bash -c 'exec 3<>/dev/tcp/127.0.0.1/5038 || exit 1
    printf "Action: Login\r\nActionID: smoke-1\r\nUsername: %s\r\nSecret: %s\r\n\r\nAction: Logoff\r\nActionID: smoke-2\r\n\r\n" "$1" "$2" >&3
    timeout 20 cat <&3' ami "$1" "$2" | tr -d '\r'
}
check_match "AMI: aster/test logs in and receives FullyBooted" "$(ami aster test)" \
  '^Asterisk Call Manager/' '^Response: Success' '^Message: Authentication accepted' \
  '^Event: FullyBooted' '^Status: Fully Booted' '^Response: Goodbye'
check_match "AMI: a wrong secret is refused" "$(ami aster wrong)" '^Response: Error' '^Message: Authentication failed'
# ami_actions <actions>: Login as aster/test, send <actions> (header lines, one empty line between actions), Logoff;
# prints the whole session without CRs. ami_block <session> <ActionID>: the response or event block with that ActionID.
ami_actions() {
  x bash -c 'exec 3<>/dev/tcp/127.0.0.1/5038 || exit 1
    printf "Action: Login\r\nActionID: smoke-login\r\nUsername: aster\r\nSecret: test\r\n\r\n" >&3
    printf "%s\n\n" "$1" | sed "s/\$/\r/" >&3
    printf "Action: Logoff\r\nActionID: smoke-logoff\r\n\r\n" >&3
    timeout 20 cat <&3' ami "$1" | tr -d '\r'
}
ami_block() { printf '%s\n' "$1" | awk -v id="ActionID: $2" 'BEGIN { RS = "" } index("\n" $0 "\n", "\n" id "\n") { print; exit }'; }

# ---- configuration from test-config: hand-owned starter files + aster.d generated from test-registry.yaml ----
check_match "globals: one per modem from aster.d/globals.conf" "$(cli 'dialplan show globals')" \
  '^ *GSM_TEST=Quectel/gsm_test$' '^ *GSM_DONGLE=Dongle/gsm_dongle$' '^ *GSM_UAC=Quectel/gsm_uac$' \
  '^ *GSM_UNMAPPED=Quectel/gsm_unmapped$' '^ *GSM_PORTS=Dongle/gsm_ports$'
check_match "aster-in-gsm_test: s, DID pattern, sms, report, ussd" "$(cli 'dialplan show aster-in-gsm_test')" \
  "^\[ Context 'aster-in-gsm_test' created by 'pbx_config' \]" "'s' =>" "'_\[\+0-9\]\.' =>" "'sms' =>" \
  "'report' =>" "'ussd' =>" 'CHANNEL\(hangup_handler_push\)=aster-hangup,s,1' 'Goto\(aster-ring-gsm_test,s,1\)'
check_match "aster-ring-gsm_test rings PJSIP/599 and runs aster-jitterbuffer on it" "$(cli 'dialplan show aster-ring-gsm_test')" \
  'Dial\(PJSIP/599,120,mb\(aster-jitterbuffer\^s\^1\)\)'
check_match "aster-out-gsm_test: + and * patterns via GSM_TEST, the caller's jitter buffer first" "$(cli 'dialplan show aster-out-gsm_test')" \
  "'_\+X\.' =>" "'_\*X\.' =>" 'Dial\(\$\{GSM_TEST\}/\$\{EXTEN\},120\)' 'Set\(JITTERBUFFER\(\$\{PHONE_JITTERBUFFER\}\)=default\)'
check_match "aster-jitterbuffer: the b() handler sets the buffer and returns; its kind is the hand-owned global" \
  "$(cli 'dialplan show aster-jitterbuffer'; cli 'dialplan show globals')" \
  'Set\(JITTERBUFFER\(\$\{PHONE_JITTERBUFFER\}\)=default\)' 'Return\(\)' 'PHONE_JITTERBUFFER=adaptive'
check_match "aster-phones-gsm_test includes internal and aster-out-gsm_test" \
  "$(cli 'dialplan show aster-phones-gsm_test')" "Include => +'internal'" "Include => +'aster-out-gsm_test'"
check_match "aster-phones-internal includes internal" "$(cli 'dialplan show aster-phones-internal')" \
  "Include => +'internal'"
check_match "aster-hangup emits call-end and returns" "$(cli 'dialplan show aster-hangup')" \
  'System\(/usr/local/bin/aster-emit call-end ' 'Return\(\)'
check_eq "aster-in-gsm_uac: s and the DID pattern enter its incoming_context smoke-in" \
  "$(cli 'dialplan show aster-in-gsm_uac' | grep -c 'Goto(smoke-in,s,1)')" 2
check_match "a modem with incoming_context gets no ring group (aster-ring-gsm_uac)" \
  "$(cli 'dialplan show aster-ring-gsm_uac' || true)" "^There is no existence of 'aster-ring-gsm_uac' context"
check_match "aster-ring-gsm_unmapped (ring: []) hangs up at once" "$(cli 'dialplan show aster-ring-gsm_unmapped')" \
  "'s' => +1\. Hangup\(\)" '^-= 1 extension \(1 priority\) in 1 context\. =-$'
check_match "music on hold: class default plays files from moh" "$(cli 'moh show classes')" \
  '^Class: default' 'Mode: files' 'Directory: moh'
check_match "music on hold: files found" "$(cli 'moh show files')" 'File: .*/moh/'
check_match "chan_quectel: the disabled gsm_test and gsm_uac are started with their radio off (no modem here: Not connected), the enabled but unmapped gsm_unmapped is Stopped" \
  "$(cli 'quectel show devices')" '^gsm_test +1 +Not connec ' '^gsm_uac +0 +Not connec ' '^gsm_unmapped +0 +Stopped '
check_match "chan_dongle: the disabled gsm_dongle and gsm_ports are started with their radio off (no modem here: Not connected)" \
  "$(cli 'dongle show devices')" '^gsm_dongle +1 +Not connec ' '^gsm_ports +0 +Not connec '
check_match "chan_quectel reads qrxgain from [defaults] (patch 0006)" "$(cli 'quectel show device settings gsm_test')" '^ *QRXGAIN +: 8192$'
check_match "chan_quectel receives delivery reports as +CDS by default (patch 0008)" \
  "$(cli 'quectel show device settings gsm_test')" '^ +SMS status reports +: cds$'
check_match "chan_quectel reads quec_uac and alsadev of gsm_uac (uac, usb_port 1-1.3)" \
  "$(cli 'quectel show device settings gsm_uac')" '^ +Audio UAC +: plughw:CARD=q_1_1_3$' \
  '^ +IMEI +: 000000000000002$' '^ +Context +: aster-in-gsm_uac$' '^ +Initial device state +: start$' '^ +Radio +: off$'
check_match "chan_quectel: gsm_unmapped (enabled, uac without usb_port) is stopped and has no UAC audio" \
  "$(cli 'quectel show device settings gsm_unmapped')" '^ +Audio +: $' '^ +IMEI +: 000000000000003$' \
  '^ +Initial device state +: stop$' '^ +Radio +: on$'
check_match "chan_dongle reads data and audio of gsm_ports (ports) instead of an IMEI" \
  "$(cli 'dongle show device settings gsm_ports')" '^ +Audio +: /dev/ttyUSB8$' '^ +Data +: /dev/ttyUSB9$' '^ +IMEI +: $' '^ +Radio +: off$'
check_match "PJSIP endpoint 599 from aster.d/phones.conf carries the template settings" \
  "$(cli 'pjsip show endpoint 599')" 'Endpoint: +599' '^ *context +: aster-phones-gsm_test$' \
  '^ *dtmf_mode +: rfc4733$' '^ *language +: ru$' '^ *direct_media +: false$' '^ *allow +: \(ulaw\|alaw\)$'
check_match "PJSIP endpoint 598: outbound null -> aster-phones-internal, direct_media yes" \
  "$(cli 'pjsip show endpoint 598')" 'Endpoint: +598' '^ *context +: aster-phones-internal$' '^ *direct_media +: true$'
check_match "PJSIP auth 598: a secret starting with > is read whole (written as password= >598)" \
  "$(cli 'pjsip show auth 598')" '^ *username +: 598$' '^ *password +: >598$'
check_match "PJSIP endpoint 597: context override smoke-in" "$(cli 'pjsip show endpoint 597')" \
  'Endpoint: +597' '^ *context +: smoke-in$'

# check_log <description> [allowed ERE]: no WARNING/ERROR line in the container log except the allowed ones.
# (The upstream stasis line "Could not find option 'minimum_size' ..." is printed before the logger exists and carries
# no level tag, so it never matches.) grep -a: a log is never "binary", or grep would print a notice instead of lines.
check_log() {
  unexpected=$(docker logs "$c" 2>&1 | grep -aE '(WARNING|ERROR)\[' || true)
  [ $# -lt 2 ] || unexpected=$(printf '%s\n' "$unexpected" | grep -aEv "$2" || true)
  if [ -z "$unexpected" ]; then pass "$1"; else fail "$1" "$unexpected"; fi
}
# (the disabled gsm_ports is started with its radio off on a data=/dev/ttyUSB9 a container does not have: the radio patches
# wait for a missing tty of such a device without a log line, so it adds nothing here)
check_log "boot log: no ERROR, no WARNING"
check_match "logger writes the production full log on /var/log/asterisk" \
  "$(x sh -c 'wc -l </var/log/asterisk/full')" '^[1-9][0-9]*$'

# ---- aster-emit: validation and atomic write, one scratch spool per case (ASTER_SPOOL) ----
# emit_ok <case> <want: kind modem uniqueid field..., space-separated> <aster-emit arguments...>
emit_ok() {
  name=$1 want=$2
  shift 2
  dir=/tmp/emit-$name
  if docker exec -e "ASTER_SPOOL=$dir" "$c" /usr/local/bin/aster-emit "$@"; then rc=0; else rc=$?; fi
  files=$(x sh -c 'cd "$1/events" 2>/dev/null && ls -A' sh "$dir" || true)
  if [ "$rc" -ne 0 ] || [ -z "$files" ] || [ "$files" != "${files%%"$nl"*}" ] || [ "${files%.evt}" = "$files" ]; then
    fail "aster-emit $name: exit $rc, files: $(printf '%s' "$files" | tr '\n' ' ')"
    return 0
  fi
  lines=$(x sh -c 'wc -l <"$1"' sh "$dir/events/$files")
  result=$(x cat "$dir/events/$files" | awk -F "$tab" -v id="${files%.evt}" -v now="$(x date +%s)" -v lines="$lines" '
    NR == 1 {
      split(id, p, "-")
      if ($1 != "1") bad = bad " version"
      if ($3 != id) bad = bad " event_id"
      if (p[1] !~ /^[0-9]+$/ || length(p[1]) < 10 || p[2] !~ /^[0-9]+$/ || id != p[1] "-" p[2] "-" $6) bad = bad " id_format"
      if ($5 != substr(p[1], 1, length(p[1]) - 9) || $5 - now > 300 || now - $5 > 300) bad = bad " emitted"
      rest = $2
      for (i = 4; i <= NF; i++) if (i != 5) rest = rest " " $i
    }
    END {
      if (NR != 1 || lines != 1) bad = bad " not_one_line"
      print (bad == "" ? "ok" : "bad:" bad) "|" rest
    }')
  case $result in
    ok\|*) check_eq "aster-emit $name: one well-formed line" "${result#ok|}" "$want" ;;
    *) fail "aster-emit $name: ${result%%|*}" "$(x cat "$dir/events/$files")" ;;
  esac
}
# emit_bad <case> <aster-emit arguments...>: exit 1 and no file left behind
emit_bad() {
  name=$1
  shift
  dir=/tmp/emit-$name
  if docker exec -e "ASTER_SPOOL=$dir" "$c" /usr/local/bin/aster-emit "$@" 2>/dev/null; then rc=0; else rc=$?; fi
  left=$(x sh -c 'find "$1" -type f 2>/dev/null' sh "$dir" || true)
  if [ "$rc" -eq 1 ] && [ -z "$left" ]; then
    pass "aster-emit rejects $name (exit 1, no file)"
  else
    fail "aster-emit $name: exit $rc (want 1), files: ${left:-none}"
  fi
}
emit_ok sms "sms gsm1 1757000000.1 eA== 0J/QoNC40LLQtdGC eDI2LzA5LzEw" \
  sms gsm1 1757000000.1 eA== 0J/QoNC40LLQtdGC eDI2LzA5LzEw
emit_ok call-end-empty-fields "call-end gsm_test - eDEyMw== - - - eDA= - -" \
  call-end gsm_test '' eDEyMw== '' '' '' eDA= '' ''
emit_ok sms-report "sms-report gsm_test 1757000000.22 eDQyOjE= e 1 - - -" \
  sms-report gsm_test 1757000000.22 eDQyOjE= e 1 '' '' ''
emit_ok no-fields "call-end m1 1.2" call-end m1 1.2
emit_bad unknown-kind call gsm1 1.1
emit_bad uppercase-kind SMS gsm1 1.1
emit_bad empty-modem sms '' 1.1
emit_bad uppercase-modem sms GSM1 1.1
emit_bad path-in-modem sms ../x 1.1
emit_bad path-in-uniqueid sms gsm1 ../../etc/x
emit_bad newline-in-uniqueid sms gsm1 "1.1${nl}2"
emit_bad space-in-field sms gsm1 1.1 'eA== eA=='
emit_bad command-substitution-field sms gsm1 1.1 '$(id)'
emit_bad backtick-field sms gsm1 1.1 '`id`'
emit_bad quote-in-field sms gsm1 1.1 'eA=="'
emit_bad semicolon-in-field sms gsm1 1.1 'eA==;id'
emit_bad tab-in-field sms gsm1 1.1 "eA==${tab}eA=="
emit_bad newline-in-field sms gsm1 1.1 "eA==${nl}eA=="
emit_bad dash-field sms gsm1 1.1 -
emit_bad utf8-field sms gsm1 1.1 'привет'
emit_bad invalid-after-valid-field sms gsm1 1.1 eA== 'x y'
emit_bad too-few-arguments sms gsm1
if docker exec -e ASTER_SPOOL=/proc/aster-emit "$c" /usr/local/bin/aster-emit sms gsm1 1.1 eA== 2>/dev/null; then
  rc=0
else
  rc=$?
fi
check_eq "aster-emit exits 1 when events/ cannot be created" "$rc" 1
x sh -c 'mkdir -p /tmp/emit-unwritable && ln -s /proc/self /tmp/emit-unwritable/events'
if docker exec -e ASTER_SPOOL=/tmp/emit-unwritable "$c" /usr/local/bin/aster-emit sms gsm1 1.1 eA== 2>/dev/null; then
  rc=0
else
  rc=$?
fi
check_eq "aster-emit exits 1 when the event file cannot be written" "$rc" 1

# ---- dialplan -> aster-emit end to end (helper extensions in [smoke], test-config/extensions.conf) ----
count_evt() { x sh -c 'ls -A "$1" 2>/dev/null | grep -c "\.evt$"' sh "$spool" || true; }
# originate <helper extension>: run it, wait for one more .evt; sets $line to the newest event line
originate() {
  before=$(count_evt)
  cli "channel originate Local/$1@smoke application Hangup" >/dev/null
  deadline=$(($(date +%s) + 60))
  while [ "$(count_evt)" -le "$before" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || { fail "$1: no new event file within 60s"; return 1; }
    sleep 1
  done
  line=$(x sh -c 'cat "$1/$(ls -A "$1" | grep "\.evt$" | sort | tail -n 1)"' sh "$spool")
}
field() { printf '%s\n' "$line" | cut -f "$1"; }
nfields() { printf '%s\n' "$line" | awk -F "$tab" '{ print NF }'; }
b64x() { printf 'x%s' "$1" | base64 | tr -d '\n'; }      # expected value, encoded on the host
unb64() { x sh -c 'printf %s "$1" | base64 -d' sh "$1"; } # decoded inside the container

check_eq "the entrypoint made events/ in the empty spool: the asterisk user's, mode 755, empty" \
  "$(x stat -c '%U:%G %a' "$spool") $(x sh -c 'ls -A "$1" | wc -l' sh "$spool")" 'asterisk:asterisk 755 0'

hostile='`id`;$(id)'
if originate call; then
  check_eq "call-end: 14 TAB-separated fields, an incoming call's direction empty" "$(nfields) $(field 14)" "14 -"
  check_eq "call-end: kind and modem" "$(field 2) $(field 4)" "call-end gsm_test"
  check_match "call-end: uniqueid is the channel's UNIQUEID" "$(field 6)" '^[0-9]+\.[0-9]+$'
  check_eq "call-end: hostile CALLERID reaches the spool only as base64(x + value)" "$(field 7)" "$(b64x "$hostile")"
  check_eq "call-end: DID is empty on the s extension" "$(field 8)" "$(b64x '')"
  check_eq "call-end: DIALSTATUS of the unregistered ring member" "$(unb64 "$(field 9)")" xCHANUNAVAIL
  sentinel=ok
  for i in 7 8 9 10 11 12 13; do
    case $(unb64 "$(field "$i")") in x*) ;; *) sentinel="field $i has no x sentinel" ;; esac
  done
  check_eq "call-end: every field is base64 with the x sentinel" "$sentinel" ok
  info "call-end: ANSWEREDTIME=$(unb64 "$(field 10)") disposition=$(unb64 "$(field 11)") HANGUPCAUSE=$(unb64 "$(field 12)") DIALEDTIME=$(unb64 "$(field 13)") (x = sentinel)"
fi
if originate did; then
  check_eq "call-end (DID): caller" "$(unb64 "$(field 7)")" x+375290000001
  check_eq "call-end (DID): DID taken from the _[+0-9]. extension" "$(unb64 "$(field 8)")" x+1234567890
fi
if originate out; then
  check_eq "call-end (outgoing): the direction last" "$(nfields) $(field 14)" "14 out"
  check_eq "call-end (outgoing): modem, caller (the phone) and the number dialed" \
    "$(field 4) $(unb64 "$(field 7)") $(unb64 "$(field 8)")" "gsm_test x599 x+1234567890"
  info "call-end (outgoing): DIALSTATUS=$(unb64 "$(field 9)") HANGUPCAUSE=$(unb64 "$(field 12)") (x = sentinel)"
fi
if originate in-out; then
  check_eq "an incoming call sent on through aster-out keeps its own record: no direction, no number dialed" \
    "$(field 14) $(unb64 "$(field 8)")" "- x"
  sleep 2
  check_eq "... and gets no second record" "$(count_evt)" "$((before + 1))"
fi
sender='";touch /tmp/aster-smoke-pwned;"'
if originate sms; then
  check_eq "sms: 9 TAB-separated fields" "$(nfields)" 9
  check_eq "sms: kind and modem" "$(field 2) $(field 4)" "sms gsm_test"
  check_eq "sms: hostile sender reaches the spool only as base64(x + value)" "$(field 7)" "$(b64x "$sender")"
  check_eq "sms: text is the driver's SMS_BASE64 (UTF-8)" "$(unb64 "$(field 8)")" "Привет из smoke-теста"
  check_eq "sms: SMS_TS" "$(unb64 "$(field 9)")" "x2026-09-10 09:30:00 +0300"
fi
if originate report; then
  check_eq "sms-report: 12 TAB-separated fields" "$(nfields)" 12
  check_eq "sms-report: kind, modem, type, success" "$(field 2) $(field 4) $(field 8) $(field 9)" "sms-report gsm_test e 1"
  check_eq "sms-report: payload" "$(unb64 "$(field 7)")" x42:1
  check_eq "sms-report: SCTS, DT, report" "$(unb64 "$(field 10)")|$(unb64 "$(field 11)")|$(unb64 "$(field 12)")" \
    "x2026-09-10 09:30:05 +0300|x2026-09-10 09:30:07 +0300|x+CDS: 6"
fi
if x test -e /tmp/aster-smoke-pwned; then
  fail "a shell command from the SMS sender was executed"
else
  pass "no shell command from caller id or sender text was executed"
fi
check_eq "spool: six event files" "$(count_evt)" 6
check_eq "spool: no .tmp or other file left" "$(x sh -c 'ls -A "$1" | grep -vc "\.evt$"' sh "$spool" || true)" 0
check_eq "spool: event files are mode 644" "$(x sh -c 'stat -c %a "$1"/*.evt | sort -u' sh "$spool")" 644
# The ring groups' b() handler on a real channel: JITTERBUFFER() is registered (func_jitterbuffer) and takes the global's kind;
# an unknown function or kind would be an ERROR line, which the log check below refuses.
cli 'channel originate Local/jb@smoke application Hangup' >/dev/null
deadline=$(($(date +%s) + 30))
until docker logs "$c" 2>&1 | grep -aq 'smoke jb: the handler set JITTERBUFFER(adaptive) and returned'; do
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 1
done
check_match "aster-jitterbuffer runs on a channel: JITTERBUFFER(adaptive) set, handler returned" "$(docker logs "$c" 2>&1)" \
  'NOTICE\[.*smoke jb: the handler set JITTERBUFFER\(adaptive\) and returned'
# Dialing the ring member 599, which never registers in a container, logs these two ERROR lines per call; an outgoing call
# on gsm_test, which has no modem, logs the WARNING line.
ring_errors="Endpoint '599': Could not create dialog to invalid URI '599'|Failed to create outgoing session to endpoint '599'|\[gsm_test\] Request to call on device which can not make call at this moment"
check_log "log after the dialplan cases: no ERROR/WARNING except the unregistered ring member" "$ring_errors"
if [ -n "${SMOKE_SPOOL_OUT:-}" ]; then
  mkdir -p "$SMOKE_SPOOL_OUT"
  x tar -C "$spool" -cf - . | tar -xf - -C "$SMOKE_SPOOL_OUT"
  info "copied $(find "$SMOKE_SPOOL_OUT" -name '*.evt' | wc -l) event files to $SMOKE_SPOOL_OUT"
fi

# ---- failure path: invalid SMS_BASE64 -> aster-emit exits 1 -> SYSTEMSTATUS=APPERROR -> ERROR line, no file ----
before=$(count_evt)
cli 'channel originate Local/sms-bad@smoke application Hangup' >/dev/null
deadline=$(($(date +%s) + 60))
until docker logs "$c" 2>&1 | grep -aEq 'ERROR\[.*aster-emit sms gsm_test failed: APPERROR'; do
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 1
done
check_match "invalid SMS_BASE64: exit 1 -> SYSTEMSTATUS=APPERROR -> ERROR in the log" \
  "$(docker logs "$c" 2>&1 | grep -a 'aster-emit')" \
  'ERROR\[.*aster-emit sms gsm_test failed: APPERROR' '^aster-emit: invalid field 2 '
check_eq "invalid SMS_BASE64: no event file written" "$(count_evt)" "$before"

# ---- <Driver>AtCommand (driver patches): documentation and every error path a stopped
# device can answer. at_command_checks <Driver> <cli name> <stopped device>: 22 checks per driver, the same 15 requests
# in one AMI session.
at_command_checks() {
  drv=$1 cli_name=$2 dev=$3
  check_match "${drv}AtCommand is a registered AMI action" "$(cli 'manager show commands')" \
    "(^|[[:space:]])${drv}AtCommand([[:space:]]|\$)"
  check_match "manager show command ${drv}AtCommand documents Device, Command, ActionID, Timeout and the events" \
    "$(cli "manager show command ${drv}AtCommand")" "^Action: ${drv}AtCommand\$" '^Privilege: system' \
    '\*ActionID: <id>.*1-63 characters \[A-Za-z0-9\._-\]' '\*Device: +<device>' '\*Command: +<AT line>.*1-256 characters' \
    'Timeout: +<seconds>.*1-60, default 15' "${drv}AtResponse" "${drv}AtDone" 'Result: OK \| ERROR \| *TIMEOUT'
  cmd256=$(head -c 256 /dev/zero | tr '\0' A)
  id63=$(head -c 63 /dev/zero | tr '\0' a)
  session=$(ami_actions "Action: ${drv}AtCommand
ActionID: at-nodev
Device: nosuch
Command: AT

Action: ${drv}AtCommand
ActionID: at-stopped
Device: $dev
Command: AT+CCFC=0,2
Timeout: 60

Action: ${drv}AtCommand
ActionID: at-nodevice
Command: AT

Action: ${drv}AtCommand
ActionID: at-nocmd
Device: $dev

Action: ${drv}AtCommand
ActionID: at-longcmd
Device: $dev
Command: ${cmd256}A

Action: ${drv}AtCommand
ActionID: at-cmd256
Device: $dev
Command: $cmd256

Action: ${drv}AtCommand
ActionID: at-timeout0
Device: $dev
Command: AT
Timeout: 0

Action: ${drv}AtCommand
ActionID: at-timeout61
Device: $dev
Command: AT
Timeout: 61

Action: ${drv}AtCommand
ActionID: at-timeoutx
Device: $dev
Command: AT
Timeout: 1x

Action: ${drv}AtCommand
ActionID: at-timeout1
Device: $dev
Command: AT
Timeout: 1

Action: ${drv}AtCommand
ActionID: at-order
Device: nosuch
Command: AT
Timeout: 0

Action: ${drv}AtCommand
ActionID: at bad
Device: $dev
Command: AT

Action: ${drv}AtCommand
ActionID: ${id63}a
Device: $dev
Command: AT

Action: ${drv}AtCommand
ActionID: $id63
Device: $dev
Command: AT

Action: ${drv}AtCommand
Device: $dev
Command: AT")
  check_match "AMI session for the ${drv}AtCommand cases logged in and out" "$session" \
    '^Message: Authentication accepted' '^Response: Goodbye'
  at_case() { check_match "${drv}AtCommand $1 -> $3" "$(ami_block "$session" "$2")" '^Response: Error$' "^Message: $3\$"; }
  at_case "unknown device" at-nodev "Device not found"
  at_case "no Device" at-nodevice "Device not found"
  at_case "stopped [$dev] (valid request, Timeout 60)" at-stopped "Device not connected"
  at_case "no Command" at-nocmd "Invalid Command"
  at_case "257-character Command" at-longcmd "Invalid Command"
  at_case "256-character Command is accepted, device stopped" at-cmd256 "Device not connected"
  at_case "Timeout 0" at-timeout0 "Invalid Timeout"
  at_case "Timeout 61" at-timeout61 "Invalid Timeout"
  at_case "Timeout 1x" at-timeoutx "Invalid Timeout"
  at_case "Timeout 1 is accepted, device stopped" at-timeout1 "Device not connected"
  at_case "request fields are validated before the device lookup" at-order "Invalid Timeout"
  at_case "ActionID with a space" "at bad" "Invalid ActionID"
  at_case "64-character ActionID" "${id63}a" "Invalid ActionID"
  at_case "63-character ActionID is accepted, device stopped" "$id63" "Device not connected"
  check_eq "${drv}AtCommand without ActionID -> Invalid ActionID (3 such errors in the session)" \
    "$(printf '%s\n' "$session" | grep -c '^Message: Invalid ActionID$')" 3
  check_eq "${drv}AtCommand: 15 requests, 15 Error responses, no Success" \
    "$(printf '%s\n' "$session" | grep -c '^Response: Error$'),$(printf '%s\n' "$session" | grep -c '^Message: .*AT command queued')" 15,0
  check_eq "no ${drv}AtResponse/${drv}AtDone event for a rejected action" \
    "$(printf '%s\n' "$session" | grep -c "^Event: ${drv}At")" 0
  check_match "CLI '$cli_name cmd' on the stopped device answers as before (untagged path unchanged)" \
    "$(cli "$cli_name cmd $dev AT")" "^\[$dev\] 'AT' Device (disabled|disconnected)\$"
  check_log "log after the ${drv}AtCommand cases: no new ERROR/WARNING" \
    "$ring_errors|aster-emit sms gsm_test failed: APPERROR"
}
at_command_checks Dongle dongle gsm_dongle
at_command_checks Quectel quectel gsm_test

# ---- reload map (packages/controller/src/config/reloadmap.js): every action but the restart re-reads its files, logs no
# WARNING/ERROR and leaves the generated configuration loaded. test/reloadmap.test.js keeps this list equal to the map.
reload_commands='dialplan reload
module reload res_pjsip.so
moh reload
module reload res_rtp_asterisk.so
logger reload
module reload cdr
module reload cel
module reload features
module reload indications
module reload acl
module reload udptl
module reload res_pjproject.so'
actions=""
n=0
while IFS= read -r command; do
  n=$((n + 1))
  actions="${actions}${actions:+$nl$nl}Action: Command${nl}ActionID: reload-$n${nl}Command: $command"
done <<EOF
$reload_commands
EOF
session=$(ami_actions "Action: QuectelReload
ActionID: reload-quectel
When: gracefully

Action: DongleReload
ActionID: reload-dongle
When: gracefully

$actions")
check_match "reload map: QuectelReload When=gracefully is scheduled" "$(ami_block "$session" reload-quectel)" \
  '^Response: Success$' '^Message: reload scheduled$'
check_match "reload map: DongleReload When=gracefully is scheduled" "$(ami_block "$session" reload-dongle)" \
  '^Response: Success$' '^Message: reload scheduled$'
reload_failed=""
n=0
while IFS= read -r command; do
  n=$((n + 1))
  block=$(ami_block "$session" "reload-$n")
  case $command in
    'module reload '*) want="^Output: Module '$(printf '%s' "${command#module reload }" | sed 's/\./\\./g')' reloaded successfully\.\$" ;;
    'dialplan reload') want='^Output: Dialplan reloaded\.$' ;;
    *) want='^Message: Command output follows$' ;;
  esac
  if ! printf '%s\n' "$block" | grep -q '^Response: Success$' || ! printf '%s\n' "$block" | grep -Eq -- "$want"; then
    reload_failed="${reload_failed}${nl}${command}: $(printf '%s' "$block" | tr '\n' '|')"
  fi
done <<EOF
$reload_commands
EOF
check_eq "reload map: the $n Command reloads answer Success (module reloads: reloaded successfully)" "${reload_failed:-none}" none
check_match "after the reloads the generated configuration is still loaded" \
  "$(cli 'quectel show devices'; cli 'dongle show devices'; cli 'dialplan show aster-hangup'; cli 'pjsip show endpoints')" \
  '^gsm_test +1 +Not connec ' '^gsm_uac +0 +Not connec ' '^gsm_unmapped +0 +Stopped ' '^gsm_dongle +1 +Not connec ' \
  '^gsm_ports +0 +Not connec ' "^\[ Context 'aster-hangup' created by 'pbx_config' \]" \
  'Endpoint: +597/597 ' 'Endpoint: +598/598 ' 'Endpoint: +599/599 '
check_log "log after the reloads: no new ERROR/WARNING" "$ring_errors|aster-emit sms gsm_test failed: APPERROR"

# ---- port discovery is callable and never takes Asterisk down ----
# Last, after every check_log: with real modems it warns about ttys the container cannot open.
# Without modems both lists are empty; the check is that the walk and AT probe finish and Asterisk survives.
for drv in quectel dongle; do
  discovery_out=$(cli "$drv discovery" 2>&1 || true)
  case "$discovery_out" in
    *"No such command"*|*"Unknown command"*) fail "$drv discovery is an available CLI command" "$discovery_out" ;;
    "") pass "$drv discovery runs and lists no modem (none attached)" ;;
    *) pass "$drv discovery runs (returned $(printf '%s\n' "$discovery_out" | wc -l) line(s))" ;;
  esac
done
check_match "Asterisk is still up after both discovery commands" \
  "$(cli 'core show uptime' 2>&1 || true)" '^System uptime: '

echo "smoke-test: $passed passed, $failed failed ($image, $platform)"
[ "$failed" -eq 0 ]
