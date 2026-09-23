#!/bin/sh
# Aster — menuselect.opts driver for the Asterisk build (used by the Dockerfile).
#   menuselect-apply.sh apply  <menuselect.opts>                       run from the Asterisk source root after
#                                                                      `make menuselect.makeopts`: disable every
#                                                                      module/sound/utility category, apply the list
#   menuselect-apply.sh verify <menuselect.opts> <moddir> <datadir>    after `make install`: every +module has its
# .so, every -module has none, sounds present
# menuselect exits 1 on an unknown member name, so a typo in a +name fails at apply time (a -name the tree does not
# list is a module this Asterisk version dropped, and is skipped with a note); a member that menuselect refuses to
# enable (unmet dependency) is caught by verify because its .so is missing. `--list-options` output is not used for
# checks: it truncates names at 30 characters.
set -eu
mode=${1:?usage: menuselect-apply.sh apply|verify <menuselect.opts> [moddir datadir]}
opts=${2:?menuselect.opts path}
mk=menuselect.makeopts

# read_opts: prints "+name" / "-name" lines without comments or blanks
read_opts() {
  while IFS= read -r raw || [ -n "$raw" ]; do
    line=$(printf '%s' "${raw%%#*}" | tr -d ' \t\r')
    [ -n "$line" ] || continue
    case "$line" in
      +*|-*) printf '%s\n' "$line" ;;
      *) echo "menuselect-apply: bad line '$raw' (expected +name or -name)" >&2; exit 2 ;;
    esac
  done < "$opts"
}

cflags_check() {
  # MENUSELECT_CFLAGS lists the *enabled* flags (positive category), unlike the module categories.
  rc=0
  for e in $(read_opts | grep -E '^[+-][A-Z][A-Z0-9_]*$' | grep -vE '^[+-](CORE-SOUNDS|EXTRA-SOUNDS|MOH)-'); do
    n=${e#?}
    if grep -E "^MENUSELECT_CFLAGS=" "$mk" | tr ' =' '\n\n' | grep -qx "$n"; then on=1; else on=0; fi
    case "$e" in
      +*) [ $on -eq 1 ] || { echo "menuselect-apply: build flag not enabled: $n" >&2; rc=1; } ;;
      -*) [ $on -eq 0 ] || { echo "menuselect-apply: build flag still enabled: $n" >&2; rc=1; } ;;
    esac
  done
  return $rc
}

case "$mode" in
  apply)
    ms=menuselect/menuselect
    if [ ! -x "$ms" ] || [ ! -f "$mk" ]; then
      echo "menuselect-apply: run from an Asterisk source root after 'make menuselect.makeopts'" >&2
      exit 2
    fi
    # MENUSELECT_CFLAGS and MENUSELECT_CHANNELSTORAGE keep Asterisk's defaults (the list turns BUILD_NATIVE off).
    for cat in ADDONS APPS BRIDGES CDR CEL CHANNELS CODECS FORMATS FUNCS PBX RES TESTS UTILS AGIS CORE_SOUNDS MOH EXTRA_SOUNDS; do
      "$ms" --disable-category "MENUSELECT_$cat" "$mk"
    done
    read_opts | while IFS= read -r e; do
      case "$e" in
        +*) "$ms" --enable "${e#?}" "$mk" ;;
        # A module this Asterisk no longer has (chan_sip went in 21) is as disabled as it gets, so only a member the
        # tree does list may fail here; a +name keeps failing on an unknown name, which is where a typo would matter.
        -*) n=${e#?}
            if ! grep -q "<member name=\"$n\"" menuselect-tree; then
              echo "menuselect-apply: $n is not in this Asterisk; nothing to disable"
            else
              "$ms" --disable "$n" "$mk"
            fi ;;
      esac
    done
    cflags_check
    echo "menuselect-apply: applied; enabled members (names cut at 30 chars by menuselect):"
    "$ms" --list-options "$mk" | grep '^+'
    ;;
  verify)
    moddir=${3:?module dir}; datadir=${4:?data dir}
    rc=0
    for e in $(read_opts); do
      n=${e#?}
      case "$n" in
        CORE-SOUNDS-*|EXTRA-SOUNDS-*)
          lang=$(printf '%s' "$n" | cut -d- -f3 | tr 'A-Z' 'a-z'); fmt=$(printf '%s' "$n" | cut -d- -f4 | tr 'A-Z' 'a-z')
          have=0; [ -d "$datadir/sounds/$lang" ] && [ -n "$(find "$datadir/sounds/$lang" -name "*.$fmt" -print -quit)" ] && have=1 ;;
        MOH-*)
          fmt=$(printf '%s' "$n" | cut -d- -f3 | tr 'A-Z' 'a-z')
          have=0; [ -d "$datadir/moh" ] && [ -n "$(find "$datadir/moh" -name "*.$fmt" -print -quit)" ] && have=1 ;;
        [A-Z]*) continue ;;   # build flags: checked at apply time
        *) if [ -f "$moddir/$n.so" ]; then have=1; else have=0; fi ;;
      esac
      case "$e" in
        +*) [ $have -eq 1 ] || { echo "menuselect-apply: MISSING after install: $n" >&2; rc=1; } ;;
        -*) [ $have -eq 0 ] || { echo "menuselect-apply: PRESENT but rejected: $n" >&2; rc=1; } ;;
      esac
    done
    [ $rc -eq 0 ] && echo "menuselect-apply: verified $(ls "$moddir"/*.so | wc -l) modules in $moddir, sounds in $datadir"
    exit $rc
    ;;
  *) echo "menuselect-apply: unknown mode '$mode' (apply|verify)" >&2; exit 2 ;;
esac
