# shellcheck shell=bash
# Aster — warnings and errors of the host scripts as framed blocks (in colour on a terminal), sourced by each of them.
# MSG_NAME names the script in an error's title; every warning is listed again by warnings_summary and by die.

MSG_WARNINGS=()
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  MSG_C_WARN=$'\033[1;33m' MSG_C_ERR=$'\033[1;31m' MSG_C_OFF=$'\033[0m'
else
  MSG_C_WARN='' MSG_C_ERR='' MSG_C_OFF=''
fi
MSG_RULE='================================================================================================'

# block COLOUR TITLE TEXT: the text between a titled rule and a closing one, every line marked, so it stands out of
# the log. Lines are not wrapped (the terminal does that), so a grep of the output still finds every sentence whole.
block() {
  local colour=$1 title=$2 line
  shift 2
  {
    printf '\n%s== %s %s%s\n' "$colour" "$title" "${MSG_RULE:$((${#title} + 4))}" "$MSG_C_OFF"
    while IFS= read -r line; do printf '%s||%s %s\n' "$colour" "$MSG_C_OFF" "$line"; done <<< "$*"
    printf '%s%s%s\n' "$colour" "$MSG_RULE" "$MSG_C_OFF"
  } >&2
}

# A warning's first line says what to do; more lines may follow with the why.
warn() { MSG_WARNINGS+=("$*"); block "$MSG_C_WARN" WARNING "$*"; }

# The first line of every warning of the run, numbered, so none is lost in the scroll.
warnings_summary() {
  [ "${#MSG_WARNINGS[@]}" -gt 0 ] || return 0
  local i
  {
    printf '\n%s%s%s\n' "$MSG_C_WARN" "$MSG_RULE" "$MSG_C_OFF"
    printf '%s  %d WARNING(S) IN THIS RUN — read them before you rely on this host:%s\n' "$MSG_C_WARN" "${#MSG_WARNINGS[@]}" "$MSG_C_OFF"
    for i in "${!MSG_WARNINGS[@]}"; do
      printf '%s  %2d.%s %s\n' "$MSG_C_WARN" "$((i + 1))" "$MSG_C_OFF" "${MSG_WARNINGS[$i]%%$'\n'*}"
    done
    printf '%s%s%s\n' "$MSG_C_WARN" "$MSG_RULE" "$MSG_C_OFF"
  } >&2
}

# die TEXT: the run's warnings, then the error. Exits 1, or DIE_STATUS (2 for a usage error: DIE_STATUS=2 die …).
die() {
  warnings_summary
  block "$MSG_C_ERR" "ERROR — ${MSG_NAME:-${0##*/}} stopped" "$*"
  exit "${DIE_STATUS:-1}"
}
