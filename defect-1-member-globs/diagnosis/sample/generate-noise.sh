#!/usr/bin/env bash
set -eu
root="$1"; n="${2:-2000}"
for member in alpha beta; do
  for tree in .venv dist; do
    for ((i = 0; i < n; i++)); do
      d="$root/packages/$member/$tree/pkg$i/lib"
      mkdir -p "$d"
      : > "$d/module.py"
    done
  done
done
mkdir -p "$root/packages/alpha/node_modules/control/lib"
: > "$root/packages/alpha/node_modules/control/lib/index.js"
mkdir -p "$root/.venv-at-root/pkg0/lib"
: > "$root/.venv-at-root/pkg0/lib/module.py"
