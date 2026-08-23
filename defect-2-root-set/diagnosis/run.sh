#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
SAMPLE_DIR="$here/sample" NOISE="${NOISE:-500}" TOP="${TOP:-4}" WORK_TAG=root-set \
  exec "$here/../../harness/capture.sh" "$@"
