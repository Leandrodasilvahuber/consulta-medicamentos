#!/bin/bash
# Cria o atalho "Vitalis" na área de trabalho e no menu de aplicativos (Linux / freedesktop).
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR" "$APPS_DIR"

entry() {
  cat <<DESK
[Desktop Entry]
Type=Application
Version=1.0
Name=Vitalis Farmácia & Clínica (LocalStack)
Comment=Sobe a stack da farmácia e clínica na LocalStack e abre o backoffice
Exec="$ROOT/scripts/start.sh" --pause
Icon=$ROOT/assets/icon.svg
Terminal=true
Categories=Development;
Actions=open;stop;

[Desktop Action open]
Name=Abrir backoffice
Exec=xdg-open http://localhost:8080/admin/

[Desktop Action stop]
Name=Parar a stack
Exec=$ROOT/scripts/stop.sh
DESK
}

entry > "$APPS_DIR/vitalis.desktop"
entry > "$DESKTOP_DIR/vitalis.desktop"
chmod +x "$DESKTOP_DIR/vitalis.desktop" "$APPS_DIR/vitalis.desktop" "$ROOT"/scripts/*.sh
# GNOME: marca o atalho como confiável para permitir execução com duplo clique
gio set "$DESKTOP_DIR/vitalis.desktop" metadata::trusted true 2>/dev/null || true
echo "Atalho criado em: $DESKTOP_DIR/vitalis.desktop"
