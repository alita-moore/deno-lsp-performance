#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${VERIFY_BUILD_ROOT:-/var/tmp/defect5-verify}
TAG=v2.9.5

mkdir -p "$OUT"
if [ ! -d "$OUT/clone" ]; then
  git clone --depth 1 --branch "$TAG" https://github.com/denoland/deno.git "$OUT/clone" || exit 1
fi

for arm in baseline patched; do
  rm -rf "$OUT/$arm"
  cp -a "$OUT/clone" "$OUT/$arm"
  mkdir -p "$OUT/$arm/libs/config/examples"
  cp "$HERE/members.rs" "$OUT/$arm/libs/config/examples/members.rs"
  if [ "$arm" = patched ]; then
    python3 "$HERE/../apply-authoritative.py" "$OUT/$arm" || exit 1
  fi
  ( cd "$OUT/$arm" && cargo build -p deno_config --example members ) || exit 1
done

echo
echo "MEMBERS_BASELINE=$OUT/baseline/target/debug/examples/members"
echo "MEMBERS_PATCHED=$OUT/patched/target/debug/examples/members"
