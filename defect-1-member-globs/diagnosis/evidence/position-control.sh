#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
deno_bin="${DENO_BIN:-$root/bin/deno}"
n="${1:-1500}"
for arm in inside-member at-root; do
  work="$(mktemp -d)"
  cp -r "$here/sample" "$work/repo"
  if [ "$arm" = inside-member ]; then
    base="$work/repo/packages/alpha/.venv"
  else
    base="$work/repo/.venv"
  fi
  for ((i = 0; i < n; i++)); do mkdir -p "$base/pkg$i/lib"; : > "$base/pkg$i/lib/module.py"; done
  mkdir -p "$work/shim"; ln -sf "$deno_bin" "$work/shim/deno"
  gcc -shared -fPIC -O1 -o "$work/st.so" "$root/harness/stacktrace.c" -ldl -lpthread
  ST_MATCH="/.venv" ST_OUT="$work/cap.txt" LSP_STDERR_LOG="$work/err.log" \
    LD_PRELOAD="$work/st.so" PATH="$work/shim:$PATH" \
    node "$root/harness/lsp-probe.mjs" "$work/repo" "$work/repo/packages/alpha/src/index.ts" >/dev/null 2>&1 || true
  total=$(grep -h '^TOTAL' "$work/cap.txt".* 2>/dev/null | awk '{s+=$2} END {print s+0}')
  printf '%-16s .venv dirs=%-6s opendir into .venv=%s\n' "$arm" "$n" "$total"
  rm -rf "$work"
done
