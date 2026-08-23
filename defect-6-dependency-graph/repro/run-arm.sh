#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
arm="${1:?arm name required}"
shift
out="${OUT_DIR:?OUT_DIR must name a writable directory for the raw output of this arm}"
mkdir -p "$out/$arm"

export FSLOG_OUT="$out/$arm/fslog.txt"
export RSS_OUT="$out/$arm/rss.tsv"
export SMAPS_OUT="$out/$arm/smaps.txt"
export LSP_STDERR_LOG="$out/$arm/lsp-stderr.log"
export LD_PRELOAD="${FSLOG_SO:?FSLOG_SO must name the compiled fslog.so}"
if [ -n "${HEAPLOG_SO:-}" ]; then
  export LD_PRELOAD="$HEAPLOG_SO:$LD_PRELOAD"
  export HEAPLOG_OUT="$out/$arm/heaplog.txt"
  rm -f "$out/$arm"/heaplog.txt.*
fi

rm -f "$out/$arm"/fslog.txt.*

taskset -c 0-2 node "$here/../harness/probe6.mjs" "$@" 2>&1 | tee "$out/$arm/probe.log"
