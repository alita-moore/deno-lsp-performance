#!/usr/bin/env bash
set -uo pipefail
DENO=${DENO_BIN:-deno}
W=${FMT_BUILD_ROOT:-/var/tmp/defect5-fmt}
rm -rf "$W"; mkdir -p "$W/packages/p00" "$W/packages/p01"
printf '{ "workspace": ["packages/p00"] }\n' > "$W/deno.json"
printf '{ "name": "@w/p00", "version": "0.0.1", "exports": "./mod.ts" }\n' > "$W/packages/p00/deno.json"
printf '{ "name": "@w/p00", "version": "0.0.1" }\n' > "$W/packages/p00/package.json"
printf '{ "name": "@w/p01", "version": "0.0.1", "exports": "./mod.ts", "fmt": { "lineWidth": 20 } }\n' > "$W/packages/p01/deno.json"
printf '{ "name": "@w/p01", "version": "0.0.1" }\n' > "$W/packages/p01/package.json"
echo 'export const someVariable = { a: 1, b: 2, c: 3 };' > "$W/packages/p00/mod.ts"
echo 'export const someVariable = { a: 1, b: 2, c: 3 };' > "$W/packages/p01/mod.ts"
cd "$W"
for arm in union authoritative; do
  if [ "$arm" = union ]; then
    printf '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n' > package.json
  else
    printf '{ "name": "root", "private": true }\n' > package.json
  fi
  out=$("$DENO" fmt --check 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
  echo "== $arm"
  echo "   packages/p01/mod.ts reported: $(echo "$out" | grep -c 'p01/mod.ts')"
  echo "   warnings: $(echo "$out" | grep -ci '^Warning')"
done
