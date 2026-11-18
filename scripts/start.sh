#!/bin/bash
# Sobe toda a stack na LocalStack e abre o navegador quando estiver pronta.
set -euo pipefail
PAUSE=${1:-}
pause() { [ "$PAUSE" = "--pause" ] && { echo; read -n1 -rsp "Pressione uma tecla para fechar..."; } || true; }
trap pause EXIT
cd "$(dirname "$(readlink -f "$0")")/.."
G='\033[1;36m'; L='\033[0;96m'; N='\033[0m'
notify() { command -v notify-send >/dev/null && notify-send -i "$PWD/assets/icon.svg" "Vitalis" "$1" || true; }

printf "%b" "$G"
cat <<'ART'
        ██████
        ██████        Vitalis · Farmácia & Clínica
  ██████████████████  stack event-driven na LocalStack
  ██████████████████
        ██████
        ██████
ART
printf "%b\n" "$N"

docker info >/dev/null 2>&1 || { echo "Docker não está rodando."; notify "Docker não está rodando"; exit 1; }
notify "Subindo a stack… (a primeira vez demora alguns minutos)"
echo -e "${L}▶ docker compose up -d --build${N}"
docker compose up -d --build

echo -ne "${L}▶ aguardando os serviços ficarem prontos${N}"
for _ in $(seq 1 180); do
  curl -sf -m 3 http://localhost:8080/api/venda/products >/dev/null && break
  echo -n "."; sleep 3
done
echo
if ! curl -sf -m 3 http://localhost:8080/api/venda/products >/dev/null; then
  notify "A stack não respondeu a tempo. Veja: docker compose logs"; exit 1
fi

echo -e "${G}✔ Pronto!${N}
  Consultas    http://localhost:8080/
  Farmácia     http://localhost:8080/loja/
  Backoffice   http://localhost:8080/admin/
  Strapi       http://localhost:1337/admin
  Zabbix       http://localhost:8081   (Admin / zabbix)"
notify "Pronto! Abrindo o backoffice."
xdg-open http://localhost:8080/admin/ >/dev/null 2>&1 || true
