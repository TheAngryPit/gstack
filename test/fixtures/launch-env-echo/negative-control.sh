#!/usr/bin/env bash
# Negative control for test/launch-env-echo-ratchet.test.ts: a shell helper is scanned whole.
set -euo pipefail
export GSTACK_CAPY=1
export $(cat "$1")
env
printenv HOME
set
export
# printenv in a comment is not a command
echo 'env' # a quoted word is not a command either
