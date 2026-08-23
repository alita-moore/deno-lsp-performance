#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
deno_bin="${DENO_BIN:-$root/bin/deno}"
n="${1:-200}"

work="$(mktemp -d)"
gcc -shared -fPIC -O2 -o "$work/dirlog.so" "$root/harness/dirlog.c" -ldl
mkdir -p "$work/shim"; ln -sf "$deno_bin" "$work/shim/deno"

printf '%-18s %8s %8s %8s %8s\n' arm opendir .venv dist src/.cache

for arm in as-built root-exclude member-exclude all-excluded root-files-empty no-root-tsconfig root-include-glob root-include-path; do
  repo="$work/$arm"
  cp -r "$here/sample" "$repo"
  "$here/sample/generate-noise.sh" "$repo" "$n"
  case "$arm" in
    root-exclude)
      cat > "$repo/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "composite": true },
  "exclude": ["**/.venv", "**/dist", "**/.cache"],
  "references": [{ "path": "./packages/alpha" }, { "path": "./packages/beta" }]
}
JSON
      ;;
    member-exclude)
      for member in alpha beta; do
        cat > "$repo/packages/$member/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "composite": true },
  "include": ["src"],
  "exclude": ["**/.cache"]
}
JSON
      done
      ;;
    all-excluded)
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
      ;;
    root-files-empty)
      cat > "$repo/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "composite": true },
  "files": [],
  "references": [{ "path": "./packages/alpha" }, { "path": "./packages/beta" }]
}
JSON
      ;;
    no-root-tsconfig) rm "$repo/tsconfig.json" ;;
    root-include-glob)
      cat > "$repo/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "composite": true },
  "include": ["packages/*/src"],
  "references": [{ "path": "./packages/alpha" }, { "path": "./packages/beta" }]
}
JSON
      ;;
    root-include-path)
      cat > "$repo/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "composite": true },
  "include": ["packages/alpha/src", "packages/beta/src"],
  "references": [{ "path": "./packages/alpha" }, { "path": "./packages/beta" }]
}
JSON
      ;;
  esac

  out="$work/log-$arm.txt"
  rm -f "$out".*
  DIRLOG_OUT="$out" LSP_STDERR_LOG="$work/err-$arm.log" \
    LD_PRELOAD="$work/dirlog.so" PATH="$work/shim:$PATH" \
    node "$root/harness/lsp-probe.mjs" "$repo" "$repo/packages/alpha/src/index.ts" \
    >"$work/probe-$arm.log" 2>&1 || true

  total=$(cat "$out".* | wc -l)
  venv=$(cat "$out".* | grep -c '/\.venv' || true)
  dist=$(cat "$out".* | grep -c '/dist' || true)
  cache=$(cat "$out".* | grep -c '/src/\.cache' || true)
  printf '%-18s %8s %8s %8s %8s\n' "$arm" "$total" "$venv" "$dist" "$cache"
done

echo
echo "tree: $n directories per pkg dir in each of .venv, dist and src/.cache, per member"
rm -rf "$work"
