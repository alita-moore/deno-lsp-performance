#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
deno_bin="${DENO_BIN:-$root/bin/deno}"
work="$(mktemp -d)"

build() {
  repo="$work/$1"; include="$2"
  mkdir -p "$repo/src" "$repo/dist/cache" "$repo/dist/sub" "$repo/vendored"
  printf 'dist/\ncache/\n' > "$repo/.gitignore"
  printf 'export  const a  =  1\n' > "$repo/src/a.ts"
  printf 'export  const b  =  1\n' > "$repo/dist/b.ts"
  printf 'export  const d  =  1\n' > "$repo/dist/cache/d.ts"
  printf 'export  const e  =  1\n' > "$repo/dist/sub/e.ts"
  printf 'export  const c  =  1\n' > "$repo/vendored/c.ts"
  if [ "$include" = none ]; then
    printf '{}\n' > "$repo/deno.json"
  else
    printf '{"fmt":{"include":%s}}\n' "$include" > "$repo/deno.json"
  fi
  git -C "$repo" init -q
}

report() {
  out="$(cd "$work/$1" && "$deno_bin" fmt --check 2>&1 | sed 's/\x1b\[[0-9;]*m//g' || true)"
  src=$(printf '%s\n' "$out" | grep -c '/src/a.ts' || true)
  dist=$(printf '%s\n' "$out" | grep -c '/dist/b.ts' || true)
  nested=$(printf '%s\n' "$out" | grep -c '/dist/cache/d.ts' || true)
  sub=$(printf '%s\n' "$out" | grep -c '/dist/sub/e.ts' || true)
  vendored=$(printf '%s\n' "$out" | grep -c '/vendored/c.ts' || true)
  printf '%-14s %-18s %6s %6s %10s %12s %10s\n' "$1" "$2" "$src" "$dist" "$sub" "$nested" "$vendored"
}

printf '%-14s %-18s %6s %6s %10s %12s %10s\n' arm 'fmt include' src/ dist/ dist/sub/ dist/cache/ vendored/
build no-include none;               report no-include absent
build literal-path '["dist"]';       report literal-path '["dist"]'
build glob-path '["**/dist"]';       report glob-path '["**/dist"]'
build literal-both '["src","dist"]'; report literal-both '["src","dist"]'

echo
echo '1 = the file was collected and reported unformatted; 0 = it was never collected.'
echo '.gitignore names dist/ and cache/. Every file is badly formatted on purpose.'
echo 'deno fmt reaches the same FileCollector as the tsconfig root-set walk, with use_gitignore on.'
rm -rf "$work"
