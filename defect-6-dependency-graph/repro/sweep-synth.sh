#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
build_root="${SYNTH_ROOT:?SYNTH_ROOT must name a scratch directory to build synthetic workspaces in}"
lock="${SYNTH_LOCK:-none}"
counts="${SYNTH_COUNTS:-1 8 24 73}"
tag="${SYNTH_TAG:-lock}"

for n in $counts; do
  ws="$build_root/n$n-$tag"
  "$here/make-synth.sh" "$ws" "$n" "$lock"
  "$here/run-arm.sh" "synth-n$n-$tag" "$ws" --enable-all --open "$ws/packages/m000/src/index.ts"
done
