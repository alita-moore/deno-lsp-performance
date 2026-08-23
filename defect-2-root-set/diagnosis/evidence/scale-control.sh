#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
deno_bin="${DENO_BIN:-$root/bin/deno}"

work="$(mktemp -d)"
gcc -shared -fPIC -O2 -o "$work/dirlog.so" "$root/harness/dirlog.c" -ldl
mkdir -p "$work/shim"; ln -sf "$deno_bin" "$work/shim/deno"

printf '%-8s %-14s %8s %8s\n' n arm opendir untracked

for n in 50 200 800; do
  for arm in as-built vcs-ignored; do
    repo="$work/$n-$arm"
    cp -r "$here/sample" "$repo"
    "$here/sample/generate-noise.sh" "$repo" "$n"
    if [ "$arm" = vcs-ignored ]; then
      cat > "$repo/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "composite": true },
  "exclude": ["**/.venv", "**/dist", "**/.cache"],
  "references": [{ "path": "./packages/alpha" }, { "path": "./packages/beta" }]
}
JSON
      for member in alpha beta; do
        cat > "$repo/packages/$member/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "composite": true },
  "include": ["src"],
  "exclude": ["**/.venv", "**/dist", "**/.cache"]
}
JSON
      done
    fi
    out="$work/log-$n-$arm.txt"
    rm -f "$out".*
    DIRLOG_OUT="$out" LSP_STDERR_LOG="$work/err-$n-$arm.log" \
      LD_PRELOAD="$work/dirlog.so" PATH="$work/shim:$PATH" \
      node "$root/harness/lsp-probe.mjs" "$repo" "$repo/packages/alpha/src/index.ts" \
      >"$work/probe-$n-$arm.log" 2>&1 || true
    total=$(cat "$out".* | wc -l)
    untracked=$(cat "$out".* | grep -cE '/(\.venv|dist|\.cache)(/|$)' || true)
    printf '%-8s %-14s %8s %8s\n' "$n" "$arm" "$total" "$untracked"
    rm -rf "$repo"
  done
done

rm -rf "$work"
