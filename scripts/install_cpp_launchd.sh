#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLIST_DST="${HOME}/Library/LaunchAgents/com.stephenlee.octagon-booker.plist"
LABEL="com.stephenlee.octagon-booker"
GUI_DOMAIN="gui/$(id -u)"

mkdir -p "${HOME}/Library/LaunchAgents"

cat > "$PLIST_DST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>cd ${PROJECT_DIR} &amp;&amp; TZ=America/New_York MODE=auto DRY_RUN=false HEADLESS=true STATE_PATH=.auth/storage-state.json /bin/bash ./scripts/run_cpp_booker.sh &gt;&gt; ${PROJECT_DIR}/logs/launchd.log 2&gt;&amp;1</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${PROJECT_DIR}/logs/launchd.stderr.log</string>
  <key>StandardOutPath</key>
  <string>${PROJECT_DIR}/logs/launchd.stdout.log</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "${GUI_DOMAIN}" "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "${GUI_DOMAIN}" "$PLIST_DST"
launchctl enable "${GUI_DOMAIN}/${LABEL}"
launchctl print "${GUI_DOMAIN}/${LABEL}" | sed -n '1,80p'

echo "Installed C++ launch agent: $PLIST_DST"