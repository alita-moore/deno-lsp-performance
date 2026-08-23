#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
work="${WORK:-/var/tmp/defect6-verify}"
deno_root="$work/deno-v2.9.5"
probe="$work/probe"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$work/target}"

mkdir -p "$work"
[ -d "$deno_root" ] || git clone --depth 1 --branch v2.9.5 https://github.com/denoland/deno "$deno_root"

echo "=== the clone ==="
git -C "$deno_root" describe --tags
git -C "$deno_root" checkout -- .

echo
echo "=== control: deno_resolver alone does not check on this tree, patched or not ==="
( cd "$deno_root" && cargo check -p deno_resolver --features sync 2>&1 | grep -E "^error|-->" | head -6 ) || true

echo
echo "=== applying ==="
python3 "$here/../apply-shared-snapshot.py" "$deno_root"

echo
echo "=== the diff ==="
git -C "$deno_root" --no-pager diff --stat

echo
echo "=== re-applying must fail without writing ==="
python3 "$here/../apply-shared-snapshot.py" "$deno_root" && { echo "UNEXPECTED: second apply succeeded"; exit 1; }
git -C "$deno_root" --no-pager diff --stat

echo
echo "=== every patched file parses, and the two the patch reformats are rustfmt-clean ==="
for f in libs/resolver/npm/managed/resolution.rs cli/lsp/resolver.rs; do
  printf '%-42s ' "$f"
  ( cd "$deno_root" && rustfmt --edition 2024 --emit stdout --quiet "$f" >/dev/null ) && printf 'parses  '
  ( cd "$deno_root" && rustfmt --edition 2024 --emit stdout --quiet "$f" 2>/dev/null | diff -q - "$f" >/dev/null ) \
    && echo "rustfmt-clean" || echo "WOULD BE REFORMATTED"
done

echo
echo "=== cargo check of the library half, and of both untouched set_snapshot callers ==="
( cd "$deno_root" && cargo check -p deno_npm_installer )

echo
echo "=== type-check the exact expression the CLI edit produces ==="
rm -rf "$probe"
cp -r "$here/probe" "$probe"
sed -i "s#DENO_ROOT#$deno_root#g" "$probe/Cargo.toml"
( cd "$probe" && cargo check )

echo
echo "=== negative control: the same probe must fail against the unpatched tree ==="
git -C "$deno_root" checkout -- .
( cd "$probe" && cargo check 2>&1 | grep -E "^error" | head -3 ) || true
python3 "$here/../apply-shared-snapshot.py" "$deno_root" >/dev/null
echo "done"
