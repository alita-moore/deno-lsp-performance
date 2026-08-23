#!/usr/bin/env bash
set -eu
harness="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$harness/.." && pwd)"

sample="${SAMPLE_DIR:?SAMPLE_DIR must name the bundled sample repository}"
tag="${WORK_TAG:-capture}"
work="${TMPDIR:-/tmp}/deno-$tag.$$"
deno_bin="${DENO_BIN:-$root/bin/deno}"
deno_bin="$(cd "$(dirname "$deno_bin")" && pwd)/$(basename "$deno_bin")"
out="$work/capture.txt"

[ -x "$deno_bin" ] || { echo "no deno binary at $deno_bin; see $root/bin/README.md" >&2; exit 1; }
command -v addr2line >/dev/null || { echo "addr2line not found" >&2; exit 1; }

mkdir -p "$work/shim"
ln -sf "$deno_bin" "$work/shim/deno"
[ "$(readlink -f "$work/shim/deno")" = "$deno_bin" ] || { echo "shim does not resolve to $deno_bin" >&2; exit 1; }

if [ $# -ge 1 ]; then
  repo="$(cd "$1" && pwd)"
  target="${2:-}"
  if [ -z "$target" ]; then
    target="$(find "$repo" -name '*.ts' -not -path '*/node_modules/*' -not -path '*/.git/*' | head -1)"
  fi
  [ -n "$target" ] || { echo "no .ts entry file found under $repo; pass one explicitly" >&2; exit 1; }
else
  repo="$work/sample"
  cp -r "$sample" "$repo"
  "$repo/generate-noise.sh" "$repo" "${NOISE:-2000}"
  target="$repo/packages/alpha/src/index.ts"
fi

echo "binary   $deno_bin"
echo "repo     $repo"
echo "entry    $target"
echo "capture  $out"
echo

gcc -shared -fPIC -O1 -o "$work/stacktrace.so" "$harness/stacktrace.c" -ldl -lpthread

ST_MATCH="${ST_MATCH:-}" ST_OUT="$out" LSP_STDERR_LOG="$work/lsp-stderr.log" \
  LD_PRELOAD="$work/stacktrace.so" \
  PATH="$work/shim:$PATH" \
  node "$harness/lsp-probe.mjs" "$repo" "$target" >"$work/probe.log" 2>&1 || true

python3 "$harness/symbolize.py" "$out.*" "$deno_bin" "${TOP:-3}"
echo "probe log: $work/probe.log"
