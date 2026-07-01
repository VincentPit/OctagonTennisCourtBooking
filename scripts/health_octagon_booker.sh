#!/usr/bin/env bash
set -euo pipefail

# Health check for the Octagon Booker launchd job.
# Usage:
#   ./scripts/health_octagon_booker.sh
#   ./scripts/health_octagon_booker.sh --tail 80

LABEL="${OCTAGON_LAUNCH_LABEL:-$(ls -1 ~/Library/LaunchAgents 2>/dev/null | grep -i 'octagon-booker' | head -n 1 | sed 's/\.plist$//' || true)}"
if [[ -z "$LABEL" ]]; then
  LABEL="com.example.octagon-booker"
fi
GUI_DOMAIN="gui/$(id -u)"
JOB="${GUI_DOMAIN}/${LABEL}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"
MAIN_LOG="${LOG_DIR}/launchd.log"
STDOUT_LOG="${LOG_DIR}/launchd.stdout.log"
STDERR_LOG="${LOG_DIR}/launchd.stderr.log"
NDJSON_LOG="${LOG_DIR}/booking-run.ndjson"

TAIL_LINES=40
if [[ "${1:-}" == "--tail" && -n "${2:-}" ]]; then
  TAIL_LINES="$2"
fi

pass() {
  echo "[PASS] $1"
}

fail() {
  echo "[FAIL] $1"
}

warn() {
  echo "[WARN] $1"
}

echo "=== Octagon Booker Health Check ==="
echo "Job: ${JOB}"
echo

status_output="$(launchctl print "${JOB}" 2>&1 || true)"

if echo "$status_output" | grep -qi "could not find service"; then
  fail "LaunchAgent is not loaded."
  echo
  echo "Suggested fix:"
  echo "  launchctl bootstrap ${GUI_DOMAIN} ~/Library/LaunchAgents/${LABEL}.plist"
  exit 1
else
  pass "LaunchAgent is loaded."
fi

state_line="$(echo "$status_output" | grep -m1 "state =" || true)"
if [[ -n "$state_line" ]]; then
  pass "${state_line}"
else
  warn "Could not parse launchd state line."
fi

if echo "$status_output" | grep -q '"Hour" => 8' && echo "$status_output" | grep -q '"Minute" => 0'; then
  pass "Schedule is daily at 08:00."
else
  fail "Could not confirm 08:00 trigger in launchd event trigger block."
fi

check_file() {
  local file="$1"
  local name="$2"

  if [[ -f "$file" ]]; then
    local size
    size="$(wc -c < "$file" | tr -d ' ')"
    pass "${name} exists (${size} bytes)."
  else
    fail "${name} is missing at ${file}."
  fi
}

check_file "$MAIN_LOG" "Main log"
check_file "$STDOUT_LOG" "Stdout log"
check_file "$STDERR_LOG" "Stderr log"
check_file "$NDJSON_LOG" "Structured run log"

echo
if [[ -f "$MAIN_LOG" ]]; then
  echo "--- Main log tail (${TAIL_LINES}) ---"
  tail -n "$TAIL_LINES" "$MAIN_LOG"
fi

echo
if [[ -f "$NDJSON_LOG" ]]; then
  echo "--- Structured run log tail (10) ---"
  tail -n 10 "$NDJSON_LOG"
fi

echo
pass "Health check completed."
