#!/bin/sh
# Aster — fetch one channel driver at a pinned commit, apply its real patches, build and install it.
# Runs in the drivers stage of the Dockerfile.
# Usage: build-driver.sh <dongle|quectel> <repo-url> <commit-sha1> <asterisk-version> <module-dir> [patch-dir]
set -eu
drv=${1:?driver}; repo=${2:?repo}; commit=${3:?commit}; astver=${4:?asterisk version}; moddir=${5:?module dir}
patchdir=${6:-/usr/src/patches}
src=/usr/src/chan_$drv

case "$commit" in
  *[!0-9a-f]*|"") echo "build-driver: commit must be a full lowercase sha1, got '$commit'" >&2; exit 2 ;;
esac
[ ${#commit} -eq 40 ] || { echo "build-driver: commit must be 40 hex characters, got '$commit'" >&2; exit 2; }

rm -rf "$src"
mkdir -p "$src"
cd "$src"
git init -q
# GitHub allows fetching a reachable commit by sha; fall back to a full fetch if the server refuses.
git fetch -q --depth 1 "$repo" "$commit" \
  || git fetch -q "$repo" '+refs/heads/*:refs/remotes/origin/*'
git -c advice.detachedHead=false checkout -q "$commit"
[ "$(git rev-parse HEAD)" = "$commit" ] || { echo "build-driver: HEAD is not $commit" >&2; exit 2; }

# Patches are named *-chan-<driver>-*.patch. A file whose first byte is '#' is a placeholder and is skipped;
# a real patch starts with its Upstream:/Purpose: header (git apply ignores text before the first diff).
for p in "$patchdir"/*-chan-"$drv"-*.patch; do
  [ -e "$p" ] || continue
  if [ "$(head -c1 "$p")" = "#" ]; then
    echo "build-driver: $drv: skipping placeholder $(basename "$p")"
    continue
  fi
  echo "build-driver: $drv: applying $(basename "$p")"
  git apply --verbose "$p"
done

./bootstrap
./configure --with-astversion="$astver" DESTDIR="$moddir"
make -j"$(nproc)"
make install
echo "build-driver: $drv: installed $moddir/chan_$drv.so from $repo@$commit"
