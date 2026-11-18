#!/bin/bash
# Laboratório de caos (CLI): roda experimentos e verifica a hipótese de estado estável com o E2E.
# Hipótese: toda compra chega a ENTREGUE, sem perda de evento e sem duplicidade, mesmo com falhas.
set -uo pipefail
A=${API:-http://localhost:8080/api}/admin
post() { curl -s -X POST "$A$1" -H 'content-type: application/json' -H "idempotency-key: $(cat /proc/sys/kernel/random/uuid)" -d "${2:-{\}}"; echo; }
e2e() { if bash "$(dirname "$0")/e2e.sh" >/tmp/chaos-e2e.log 2>&1; then echo "  ✅ estado estável mantido"; else echo "  ❌ violado:"; tail -3 /tmp/chaos-e2e.log; fi; }
clear() { post /chaos/faults/clear >/dev/null; }
trap clear EXIT

echo "## 1. Perda de réplica (kill 1x pedido, pagamento, nf-worker)"
for s in pedido pagamento nf-worker; do post /chaos/container "{\"service\":\"$s\",\"action\":\"kill\",\"durationSec\":40}" >/dev/null; done
e2e

echo "## 2. Consumidores instáveis (40% dos eventos falham em todos os serviços)"
post /chaos/faults '{"target":"*","consumerErrorRate":0.4}' >/dev/null
e2e; clear

echo "## 3. Latência de 1.5s em todos os serviços"
post /chaos/faults '{"target":"*","latencyMs":1500}' >/dev/null
e2e; clear

echo "## 4. Mensagens envenenadas -> DLQ"
post /queues/cm-pedido-q-dlq/purge >/dev/null; sleep 2
post /chaos/poison '{"queue":"cm-pedido-q","count":2}'
echo "  aguardando 5 tentativas (~60s)..."
for _ in $(seq 1 24); do n=$(curl -s "$A/dlq-total"); [ "$n" -ge 2 ] 2>/dev/null && break; sleep 5; done
echo "  DLQ total: $(curl -s "$A/dlq-total") (esperado >= 2) — veja/descarte em /admin/ops.html (Filas & DLQ)"

echo "## 5. Queda da AWS (LocalStack pausada 15s no meio da compra)"
( sleep 3; post /chaos/aws-outage '{"seconds":15}' >/dev/null ) &
e2e
echo "fim. Diário completo em /admin/caos.html"
