#!/bin/sh
# Adds G-System Editor to the desktop menu (current user only).
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
dest="$HOME/.local/share/applications/gsystem-editor.desktop"
cat > "$dest" <<DESKTOP
[Desktop Entry]
Type=Application
Name=G-System Editor
Comment=Éditeur libre pour TC Electronic G-System
Exec="$here/scripts/gsystem-editor.sh"
Terminal=false
Categories=Audio;AudioVideo;Music;
DESKTOP
echo "Lanceur installé : $dest"
