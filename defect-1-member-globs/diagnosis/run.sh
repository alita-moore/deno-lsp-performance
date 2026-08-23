#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
SAMPLE_DIR="$here/sample" NOISE="${NOISE:-2000}" TOP="${TOP:-3}" WORK_TAG=member-globs \
  exec "$here/../../harness/capture.sh" "$@"
