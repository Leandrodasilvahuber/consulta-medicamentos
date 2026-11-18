#!/bin/bash
# Sobe um ambiente (dev | prod) e roda o smoke test ponta a ponta.
#   bash scripts/deploy.sh dev                      # build local
#   IMAGE=ghcr.io/...:sha-abc bash scripts/deploy.sh prod   # usa a imagem publicada pela CI (sem build)
# SKIP_E2E=1 pula o teste. CORE_ONLY=1 sobe só o núcleo (sem Strapi/Postgres/Zabbix), como no CD.
set -euo pipefail
ENV_NAME=${1:-dev}
cd "$(dirname "$(readlink -f "$0")")/.."
ENV_FILE="env/$ENV_NAME.env"
[ -f "$ENV_FILE" ] || { echo "ambiente desconhecido: $ENV_NAME (use dev ou prod)"; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
dc() { docker compose --env-file "$ENV_FILE" "$@"; }

CORE=(localstack cadastro agendamento consulta receita venda pedido pagamento entrega estoque nf-worker admin gateway)
services=()
[ "${CORE_ONLY:-}" = "1" ] && services=("${CORE[@]}")

echo "▶ deploy $ENV_NAME (projeto $COMPOSE_PROJECT_NAME, gateway :$GATEWAY_PORT, imagem ${IMAGE:-build local})"
if [ -n "${IMAGE:-}" ]; then
  docker pull -q "$IMAGE"
  dc up -d --no-build --remove-orphans "${services[@]}"
else
  dc up -d --build --remove-orphans "${services[@]}"
fi

echo -n "▶ aguardando a API"
for _ in $(seq 1 150); do
  curl -sf -m 3 "http://localhost:$GATEWAY_PORT/api/venda/products" >/dev/null && break
  echo -n "."
  sleep 2
done
echo
curl -sf -m 3 "http://localhost:$GATEWAY_PORT/api/venda/products" >/dev/null || { echo "API não respondeu"; exit 1; }

if [ "${SKIP_E2E:-}" != "1" ]; then
  echo "▶ smoke test e2e"
  API="http://localhost:$GATEWAY_PORT/api" bash scripts/e2e.sh
fi
echo "✔ $ENV_NAME no ar: http://localhost:$GATEWAY_PORT/"
