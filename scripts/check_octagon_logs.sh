#!/usr/bin/env bash
set -euo pipefail

# Quick log/status helper for the Octagon Booker launchd job.
# Usage examples:
#   ./scripts/check_octagon_logs.sh follow
#   ./scripts/check_octagon_logs.sh recent 200
#   ./scripts/check_octagon_logs.sh filter
#   ./scripts/check_octagon_logs.sh status
#   ./scripts/check_octagon_logs.sh unified 24h
#   ./scripts/check_octagon_logs.sh ndjson 20

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"

MAIN_LOG="${LOG_DIR}/launchd.log"
STDOUT_LOG="${LOG_DIR}/launchd.stdout.log"
STDERR_LOG="${LOG_DIR}/launchd.stderr.log"
NDJSON_LOG="${LOG_DIR}/booking-run.ndjson"

LABEL="${OCTAGON_LAUNCH_LABEL:-$(ls -1 ~/Library/LaunchAgents 2>/dev/null | grep -i 'octagon-booker' | head -n 1 | sed 's/\.plist$//' || true)}"
if [[ -z "$LABEL" ]]; then
  LABEL="com.example.octagon-booker"
fi
GUI_DOMAIN="gui/$(id -u)"

usage() {
  cat <<'EOF'
Usage: check_octagon_logs.sh <command> [arg]

Commands:
  follow               Follow main run log (launchd.log)
  stdout               Follow launchd stdout log
  stderr               Follow launchd stderr log
  recent [N]           Show last N lines from main log (default: 200)
  filter               Show last 50 success/failure highlights from main log
  status               Show launchd status for detected Octagon Booker label
  unified [WINDOW]     Show macOS unified logs for label (default: 24h)
  ndjson [N]           Show last N structured entries (default: 20)
  all [N]              Show recent main/stdout/stderr/ndjson summaries
  help                 Show this help

Examples:
  ./scripts/check_octagon_logs.sh follow
  ./scripts/check_octagon_logs.sh recent 300
  OCTAGON_LAUNCH_LABEL=com.example.octagon-booker ./scripts/check_octagon_logs.sh unified 12h
EOF
}

ensure_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "Log file not found: $file" >&2
    exit 1
  fi
}

cmd="${1:-help}"

case "$cmd" in
  follow)
    ensure_file "$MAIN_LOG"
    tail -f "$MAIN_LOG"
    ;;
  stdout)
    ensure_file "$STDOUT_LOG"
    tail -f "$STDOUT_LOG"
    ;;
  stderr)
    ensure_file "$STDERR_LOG"
    tail -f "$STDERR_LOG"
    ;;
  recent)
    ensure_file "$MAIN_LOG"
    lines="${2:-200}"
    tail -n "$lines" "$MAIN_LOG"
    ;;
  filter)
    ensure_file "$MAIN_LOG"
    grep -E "submitted successfully|Booking run failed|Failed before submit|Safe mode active" "$MAIN_LOG" | tail -n 50 || true
    ;;
  status)
    launchctl print "${GUI_DOMAIN}/${LABEL}"
    ;;
  unified)
    window="${2:-24h}"
    log show --last "$window" --predicate "eventMessage CONTAINS \"${LABEL}\"" --style compact
    ;;
  ndjson)
    ensure_file "$NDJSON_LOG"
    lines="${2:-20}"
    tail -n "$lines" "$NDJSON_LOG"
    ;;
  all)
    lines="${2:-50}"

    echo "=== launchd status ==="
    launchctl print "${GUI_DOMAIN}/${LABEL}" | sed -n '1,80p'

    echo
    echo "=== main log (last ${lines}) ==="
    [[ -f "$MAIN_LOG" ]] && tail -n "$lines" "$MAIN_LOG" || echo "missing: $MAIN_LOG"

    echo
    echo "=== stdout log (last ${lines}) ==="
    [[ -f "$STDOUT_LOG" ]] && tail -n "$lines" "$STDOUT_LOG" || echo "missing: $STDOUT_LOG"

    echo
    echo "=== stderr log (last ${lines}) ==="
    [[ -f "$STDERR_LOG" ]] && tail -n "$lines" "$STDERR_LOG" || echo "missing: $STDERR_LOG"

    echo
    echo "=== structured ndjson (last ${lines}) ==="
    [[ -f "$NDJSON_LOG" ]] && tail -n "$lines" "$NDJSON_LOG" || echo "missing: $NDJSON_LOG"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo >&2
    usage
    exit 2
    ;;
esac
