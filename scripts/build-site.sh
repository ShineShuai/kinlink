#!/usr/bin/env bash
# Assemble the static Client site (no extension files, no tests) into DIR (default: site/).
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-site}"
rm -rf "$out"
mkdir -p "$out/src"
cp index.html diag.html app.js rt.js render-sw.js "$out/"
cp src/*.js "$out/src/"
touch "$out/.nojekyll"
echo "$out: $(find "$out" -type f | wc -l | tr -d ' ') files"
