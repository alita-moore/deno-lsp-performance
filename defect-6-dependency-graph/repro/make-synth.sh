#!/usr/bin/env bash
set -eu
dest="${1:?destination directory required}"
members="${2:?member count required}"
lock="${3:-none}"

rm -rf "$dest"
mkdir -p "$dest/packages"

printf '{ "nodeModulesDir": "auto" }\n' > "$dest/deno.json"

globs='"packages/*"'
{
  printf '{\n  "name": "synth",\n  "private": true,\n  "version": "1.0.0",\n'
  printf '  "workspaces": [%s]\n}\n' "$globs"
} > "$dest/package.json"

if [ "$lock" != "none" ]; then
  cp "$lock" "$dest/deno.lock"
fi

i=0
while [ "$i" -lt "$members" ]; do
  n=$(printf 'm%03d' "$i")
  mkdir -p "$dest/packages/$n/src"
  printf '{ "name": "@synth/%s", "version": "1.0.0", "main": "src/index.ts" }\n' "$n" > "$dest/packages/$n/package.json"
  printf 'export const %s = %d;\n' "$n" "$i" > "$dest/packages/$n/src/index.ts"
  i=$((i + 1))
done

echo "$dest: $members members, lock=$lock"
