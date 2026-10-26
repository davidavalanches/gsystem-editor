#!/bin/sh
# Adds G-System Editor to the desktop menu (current user only).
set -e
here=$(cd "$(dirname "$0")" && pwd)
bin="$here/.venv/bin/gsystem-editor"
[ -x "$bin" ] || { echo "Lancez d'abord : python3 -m venv .venv && .venv/bin/pip install -e ." >&2; exit 1; }
dest="$HOME/.local/share/applications/gsystem-editor.desktop"
sed "s|@BIN@|\"$bin\"|" "$here/packaging/gsystem-editor.desktop" > "$dest"
echo "Lanceur installé : $dest"
