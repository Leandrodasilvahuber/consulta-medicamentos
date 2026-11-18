#!/bin/bash
# Para a stack (mantém os volumes). Use "docker compose down -v" para zerar tudo.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
docker compose stop
command -v notify-send >/dev/null && notify-send -i "$PWD/assets/icon.svg" "Vitalis" "Stack parada" || true
