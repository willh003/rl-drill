#!/bin/sh
# Install the Mac side: the hourly launchd agent, and (optionally) the Dock
# launcher app. Run from the drill directory:
#
#   sh install.sh
#
# Everything is installed pointing at THIS directory -- move the directory
# and you re-run this. Uninstall:
#
#   launchctl unload ~/Library/LaunchAgents/local.arabic-drill.plist
#   rm ~/Library/LaunchAgents/local.arabic-drill.plist
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/local.arabic-drill.plist"

[ -f "$DIR/cards.json" ] || {
  echo "No cards.json here yet. Copy cards.example.json to cards.json"
  echo "or write your own deck first."
  exit 1
}

# --- launchd agent: hourly firings, 8am-10pm --------------------------------
mkdir -p "$AGENTS"
sed "s|__DRILL_DIR__|$DIR|g" "$DIR/arabic-drill.plist.template" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded $PLIST"
echo "  fires hourly 08:00-22:00; exits silently when nothing is due"

# --- Dock launcher (optional but nice) --------------------------------------
# A compiled applet, because a bare osascript process launched any other way
# never receives keyboard focus on macOS.
APP="$DIR/Recall.app"
TMP_DIR="$(mktemp -d -t launcher)"
sed "s|__DRILL_DIR__|$DIR|g" "$DIR/launcher.js" > "$TMP_DIR/launcher.js"
rm -rf "$APP"
osacompile -s -l JavaScript -o "$APP" "$TMP_DIR/launcher.js"
rm -rf "$TMP_DIR"
if [ -f "$DIR/Recall.icns" ]; then
  cp "$DIR/Recall.icns" "$APP/Contents/Resources/applet.icns"
fi
echo "built  $APP"
echo "  drag it into /Applications if you want it in Launchpad/Spotlight"

echo
echo "Try it now:  /usr/bin/python3 '$DIR/drill.py' --status"
