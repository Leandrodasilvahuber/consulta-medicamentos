#!/bin/bash
# Para a stack de um ambiente (padrão: dev), mantendo os volumes. Ex.: bash scripts/stop.sh prod
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
ENV_NAME=${1:-dev}
docker compose --env-file "env/$ENV_NAME.env" stop
command -v notify-send >/dev/null && notify-send -i "$PWD/assets/icon.svg" "Vitalis" "Stack $ENV_NAME parada" || true
