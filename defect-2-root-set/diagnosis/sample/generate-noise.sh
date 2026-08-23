#!/usr/bin/env bash
set -eu
root="$1"; n="${2:-500}"
for member in alpha beta; do
  for ((i = 0; i < n; i++)); do
    d="$root/packages/$member/.venv/pkg$i/lib"
    mkdir -p "$d"
    : > "$d/module.py"
    d="$root/packages/$member/dist/pkg$i"
    mkdir -p "$d"
    : > "$d/unit$i.js"
    d="$root/packages/$member/src/.cache/pkg$i"
    mkdir -p "$d"
    : > "$d/unit$i.js"
  done
done
mkdir -p "$root/packages/alpha/node_modules/control/lib"
: > "$root/packages/alpha/node_modules/control/lib/index.js"
