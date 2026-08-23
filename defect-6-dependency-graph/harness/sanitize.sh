#!/usr/bin/env bash
set -eu
root="${1:?workspace root required}"
scratch="${2:?scratch directory required}"
home_dir="${3:-$HOME}"

sed -e "s#${root}#<workspace>#g" \
    -e "s#${scratch}#<scratch>#g" \
    -e "s#${home_dir}#<home>#g" \
    -e 's#/home/runner/work/[^/]*/[^/]*/deno/#deno/#g' \
    -e 's#/home/runner/\.rustup/toolchains/[^/]*/lib/rustlib/src/rust/library/#rust/library/#g' \
    -e 's#/home/runner/\.cargo/registry/src/[^/]*/#cargo/#g' \
    -e 's#/rustc/[0-9a-f]*/library/#rust/library/#g'
