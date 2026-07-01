#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CPP_DIR="${PROJECT_DIR}/cpp"
BUILD_DIR="${CPP_DIR}/build"
BINARY="${BUILD_DIR}/octagon_booker_cpp"
NODE_BIN="${NODE_BIN:-/Users/stephenlee/.nvm/versions/node/v20.12.0/bin/node}"
NPM_BIN="${NPM_BIN:-/Users/stephenlee/.nvm/versions/node/v20.12.0/bin/npm}"
CMAKE_BIN="${CMAKE_BIN:-/opt/homebrew/bin/cmake}"

if [[ ! -d "${PROJECT_DIR}/node_modules" ]]; then
  "$NPM_BIN" install --no-fund --no-audit
fi

"$NODE_BIN" "${PROJECT_DIR}/src/login.js"

cd "$PROJECT_DIR"
COOKIE_HEADER="$("$NODE_BIN" -e 'const fs=require("fs"); const statePath=process.env.STATE_PATH || ".auth/storage-state.json"; const raw=fs.readFileSync(statePath,"utf8"); const data=JSON.parse(raw); const cookie=(data.cookies||[]).map((c)=>`${c.name}=${c.value}`).join("; "); process.stdout.write(cookie);')"
if [[ -z "$COOKIE_HEADER" ]]; then
  echo "[AUTH] No cookies found in ${STATE_PATH:-.auth/storage-state.json} after refresh." >&2
  exit 2
fi

if [[ ! -x "$BINARY" ]]; then
  "$CMAKE_BIN" -S "$CPP_DIR" -B "$BUILD_DIR"
  "$CMAKE_BIN" --build "$BUILD_DIR" -j
fi

exec env CIVIC_COOKIE="$COOKIE_HEADER" "$BINARY"