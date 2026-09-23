#!/bin/sh
# Aster — write-budget: how much the host writes to the disk that carries the appliance, extrapolated to a day.
# The appliance boots from an SD card, so the budget is a write rate: idle, the whole host must stay under 5 MiB/day.
#
# Usage: tools/write-budget.sh [--minutes N | --seconds N] [--budget MIB] [--home DIR] [--device NAME] [--json]
#        tools/write-budget.sh [--minutes N | --seconds N] [--budget MIB] --container NAME[,NAME…] [--json]
#   --minutes    sampling window, default 15 (a shorter one is dominated by whatever happens to run during it)
#   --seconds    the same window in seconds, for a quick check or a CI job
#   --budget     MiB/day that must not be exceeded, default 5; the exit status is 1 above it
#   --home       the directory whose disk is measured, default data/ of this checkout (falls back to / when it does not exist)
#   --device     a /proc/diskstats name (mmcblk0p2, sda1) instead of working it out from --home
#   --container  measure the writes of these docker containers instead (their cgroup's io.stat, summed): what the
#                appliance's own processes wrote, on a machine that is not an idle appliance itself (the CI runner).
#                Needs the memory controller on beside io; without it nothing is attributed and this refuses to
#                report rather than hand back a zero it cannot stand behind (exit 2)
#   --json       one JSON object instead of the human summary
#
# The whole host is measured on purpose: everything lands on the same card (/proc/diskstats, 512-byte sectors).
# --container sums the containers' cgroup io.stat, which misses what dockerd writes for them (their json-file logs).
set -eu

window=900
budget=5
home=$(dirname -- "$0")/../data
device=
containers=
json=no

while [ $# -gt 0 ]; do
  case $1 in
    --minutes) window=$((${2:?--minutes needs a number} * 60)); shift 2 ;;
    --seconds) window=${2:?--seconds needs a number}; shift 2 ;;
    --budget)  budget=${2:?--budget needs a number}; shift 2 ;;
    --home)    home=${2:?--home needs a directory}; shift 2 ;;
    --device)  device=${2:?--device needs a name}; shift 2 ;;
    --container) containers=$(printf '%s' "${2:?--container needs a name}" | tr ',' ' '); shift 2 ;;
    --json)    json=yes; shift ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "write-budget: unknown argument $1" >&2; exit 2 ;;
  esac
done

case $window in '' | *[!0-9]*) echo "write-budget: the window must be a whole number" >&2; exit 2 ;; esac
case $budget in '' | *[!0-9]*) echo "write-budget: --budget must be a whole number" >&2; exit 2 ;; esac
[ "$window" -gt 0 ] || { echo "write-budget: the window must be above zero" >&2; exit 2; }
[ -d "$home" ] || home=/

sectors() {
  awk -v want="$1" '$3 == want {print $10; found = 1} END {if (!found) exit 3}' /proc/diskstats
}

# Bytes the container's cgroup has written so far (wbytes of its io.stat, summed; systemd or cgroupfs layout).
# Without the memory controller beside io, writes are not attributed (wbytes stays 0), so that is an error, not a pass.
container_bytes() {
  id=$(docker inspect -f '{{.Id}}' "$1" 2>/dev/null) || { echo "write-budget: no container $1" >&2; return 3; }
  dir=
  for candidate in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do
    if [ -r "$candidate/io.stat" ]; then dir=$candidate; break; fi
  done
  if [ -z "$dir" ]; then
    echo "write-budget: no io.stat for container $1 (cgroup v2 with the io controller is needed)" >&2
    return 3
  fi
  if [ ! -e "$dir/memory.stat" ]; then
    echo "write-budget: the writes of $1 are not charged to its cgroup, so they cannot be measured: $dir has" >&2
    echo "  io.stat but no memory.stat, and cgroup writeback needs the memory controller beside io. On Raspberry Pi" >&2
    echo "  OS drop cgroup_disable=memory from the kernel command line and reboot; elsewhere measure the whole host" >&2
    echo "  with --home instead." >&2
    return 3
  fi
  # A device line carrying no wbytes field at all is the same unmeasurable case seen from the other side.
  awk '
    { for (i = 2; i <= NF; i++) if ($i ~ /^wbytes=/) { sub(/^wbytes=/, "", $i); sum += $i; seen = 1 } }
    END { if (NR > 0 && !seen) exit 3; print sum + 0 }
  ' "$dir/io.stat" || {
    echo "write-budget: the io.stat of $1 has no wbytes field, so its writes cannot be measured" >&2
    return 3
  }
}
containers_bytes() {
  total=0
  for name in $containers; do
    bytes=$(container_bytes "$name") || return 3
    total=$((total + bytes))
  done
  echo "$total"
}

if [ -n "$containers" ]; then
  start=$(containers_bytes) || exit 2
  started=$(date +%s)
  sleep "$window"
  end=$(containers_bytes) || exit 2
  elapsed=$(( $(date +%s) - started ))
  [ "$elapsed" -gt 0 ] || elapsed=1
  written=$((end - start))
  tenths=$(( written * 864000 / elapsed / 1048576 ))
  per_day=$((tenths / 10)).$((tenths % 10))
  over=no
  [ "$tenths" -le $((budget * 10)) ] || over=yes
  names=$(printf '%s' "$containers" | tr ' ' ',')
  if [ "$json" = yes ]; then
    printf '{"containers":"%s","seconds":%s,"bytes":%s,"mib_per_day":%s,"budget_mib_per_day":%s,"over_budget":%s}\n' \
      "$names" "$elapsed" "$written" "$per_day" "$budget" "$([ "$over" = yes ] && echo true || echo false)"
  else
    printf 'containers %s: %s bytes written in %s s = %s MiB/day (budget %s MiB/day)\n' "$names" "$written" "$elapsed" "$per_day" "$budget"
    [ "$over" = no ] || echo "write-budget: over budget" >&2
  fi
  [ "$over" = no ]
  exit
fi

# The device behind the mount point (findmnt source, btrfs [subvolume] cut, by-uuid/label resolved); its partition's
# diskstats line is used, the whole disk only as a fallback.
if [ -z "$device" ]; then
  source=$(findmnt -no SOURCE --target "$home" 2>/dev/null || df -P "$home" | awk 'NR == 2 {print $1}')
  source=${source%%[*}
  resolved=$(readlink -f "$source" 2>/dev/null || true)
  [ -b "$resolved" ] && source=$resolved
  device=${source##*/}
  if [ -n "$device" ] && ! sectors "$device" >/dev/null 2>&1; then
    whole=$(echo "$device" | sed -E 's/p?[0-9]+$//')
    [ -n "$whole" ] && sectors "$whole" >/dev/null 2>&1 && device=$whole
  fi
fi
[ -n "$device" ] || { echo "write-budget: cannot tell which device carries $home" >&2; exit 2; }

start=$(sectors "$device") || { echo "write-budget: $device is not in /proc/diskstats (a loop, overlay or network mount?); pass --device" >&2; exit 2; }
started=$(date +%s)
sleep "$window"
end=$(sectors "$device")
elapsed=$(( $(date +%s) - started ))
[ "$elapsed" -gt 0 ] || elapsed=1

written=$(( (end - start) * 512 ))
# MiB/day, rounded to one decimal, in integer arithmetic: bytes * 86400 / elapsed / 1048576.
tenths=$(( written * 864000 / elapsed / 1048576 ))
per_day=$((tenths / 10)).$((tenths % 10))
over=no
[ "$tenths" -le $((budget * 10)) ] || over=yes

if [ "$json" = yes ]; then
  printf '{"device":"%s","home":"%s","seconds":%s,"bytes":%s,"mib_per_day":%s,"budget_mib_per_day":%s,"over_budget":%s}\n' \
    "$device" "$home" "$elapsed" "$written" "$per_day" "$budget" "$([ "$over" = yes ] && echo true || echo false)"
else
  printf '%s carries %s: %s bytes written in %s s = %s MiB/day (budget %s MiB/day)\n' \
    "$device" "$home" "$written" "$elapsed" "$per_day" "$budget"
  [ "$over" = no ] || echo "write-budget: over budget" >&2
fi

[ "$over" = no ]
