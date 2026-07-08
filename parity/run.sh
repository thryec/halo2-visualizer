#!/bin/sh
set -e
cd "$(dirname "$0")"
(cd rust && cargo run --quiet --release) > /tmp/parity_rust.txt
node js/check.js > /tmp/parity_js.txt
if diff /tmp/parity_rust.txt /tmp/parity_js.txt; then echo "PARITY OK"; else echo "PARITY MISMATCH"; exit 1; fi
