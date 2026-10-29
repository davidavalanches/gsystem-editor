#!/bin/sh
# Starts G-System Editor on a computer: serves the built app on localhost (Web MIDI
# needs a secure context) and opens it full screen in a Chrome/Chromium application window (F11 leaves full screen).
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
port=4719
# Outside an nvm shell the system Node (too old for Vite) would be picked up.
node22=$(ls -d "$HOME"/.nvm/versions/node/v22.*/bin 2>/dev/null | sort -V | tail -n 1)
[ -n "$node22" ] && PATH="$node22:$PATH"
[ -d "$here/dist" ] || (cd "$here" && npm run build)
if ! curl -sf "http://localhost:$port/" >/dev/null 2>&1; then
  (cd "$here" && npx vite preview --port $port --strictPort >/dev/null 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf "http://localhost:$port/" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
for browser in google-chrome chromium chromium-browser; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" --app="http://localhost:$port/" --start-fullscreen
  fi
done
echo "Ouvrez http://localhost:$port/ dans Chrome ou Chromium." >&2
