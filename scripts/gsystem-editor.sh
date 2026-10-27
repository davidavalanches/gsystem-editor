#!/bin/sh
# Starts G-System Editor on a computer: serves the built app on localhost (Web MIDI
# needs a secure context) and opens it full screen in a Chrome/Chromium application window (F11 leaves full screen).
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
port=4719
[ -d "$here/dist" ] || (cd "$here" && npm run build)
if ! curl -s "http://localhost:$port/" >/dev/null 2>&1; then
  (cd "$here" && npx vite preview --port $port --strictPort >/dev/null 2>&1 &)
  sleep 1
fi
for browser in google-chrome chromium chromium-browser; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" --app="http://localhost:$port/" --start-fullscreen
  fi
done
echo "Ouvrez http://localhost:$port/ dans Chrome ou Chromium." >&2
