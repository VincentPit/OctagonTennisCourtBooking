#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="${PROJECT_DIR}/cpp/build/octagon_booker_cpp"

# Track daily bookings - one per day max
DAILY_BOOKING_FLAG="/tmp/octagon_booker_$(date +%Y%m%d).flag"
if [[ -f "$DAILY_BOOKING_FLAG" ]]; then
  exit 0
fi

# Binary reads cookies directly from storage state file
cd "$PROJECT_DIR"
OUTPUT=$("$BINARY" 2>&1)
echo "$OUTPUT"

# Check if booking was successful
if echo "$OUTPUT" | grep -q "Submitted successfully for"; then
  touch "$DAILY_BOOKING_FLAG"
  BOOKINGS=$(echo "$OUTPUT" | grep "Submitted successfully for" | sed 's/.*Submitted successfully for //' | sort | uniq)
  DATE=$(echo "$OUTPUT" | grep "^Plan" | head -1 | sed 's/.*: //' | cut -d' ' -f1-2)
  TIME=$(echo "$OUTPUT" | grep "Checking slot" | head -1 | sed 's/.*Checking slot //' | cut -d'-' -f1)
  COURTS=$(echo "$BOOKINGS" | tr '\n' ', ' | sed 's/,$//')
  osascript -e "display notification \"${DATE} at ${TIME}\\n${COURTS}\" with title \"🎾 Courts Booked!\""
fi