#!/bin/bash
# Fluxo ponta a ponta: cadastro -> agendamento -> pagamento -> consulta -> receita -> venda -> pedido -> NF -> entrega
set -euo pipefail
API=${API:-http://localhost:8080/api}
post() { curl -sf -X POST "$API$1" -H 'content-type: application/json' -H "idempotency-key: ${3:-$(cat /proc/sys/kernel/random/uuid)}" -d "$2"; }
get() { curl -sf "$API$1"; }
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)$1??'')}catch{console.log('')}})"; }
waitfor() { for _ in $(seq 1 40); do v=$(get "$1" 2>/dev/null | field "$2" || true); [ "$v" = "$3" ] && return 0; sleep 1; done; echo "timeout $1 $2=$3"; exit 1; }

CID=$(post /cadastro/customers '{"name":"Paciente E2E","document":"000","email":"e2e@ex.com"}' | field .id)
[ -n "$CID" ] || { echo "falha ao cadastrar cliente"; exit 1; }
echo "cliente      $CID"
KEY=appt-$CID
AID=$(post /agendamento/appointments "{\"customerId\":\"$CID\",\"customerName\":\"Paciente E2E\",\"slot\":\"2026-12-01T10:00\"}" "$KEY" | field .id)
AID2=$(post /agendamento/appointments "{\"customerId\":\"$CID\",\"slot\":\"2026-12-01T10:00\"}" "$KEY" | field .id)
[ "$AID" = "$AID2" ] && echo "idempotência OK (mesma chave -> mesmo agendamento $AID)"
waitfor "/agendamento/appointments/$AID" .status CONFIRMED && echo "consulta paga e confirmada"
waitfor "/consulta/consultations/$AID" .status SCHEDULED && echo "sala: $(get "/consulta/consultations/$AID" | field .roomUrl)"
post "/consulta/consultations/$AID/complete" '{"items":[{"sku":"AMOXI-500","maxQty":2}]}' >/dev/null
for _ in $(seq 1 30); do RX=$(get "/receita/prescriptions/by-consultation/$AID" 2>/dev/null | field .pk || true); [ -n "$RX" ] && break; sleep 1; done
echo "receita      $RX"
sleep 2 # projeção da receita chegando na venda

echo -n "venda fora da receita (deve falhar): "
curl -s -X POST "$API/venda/checkout" -H 'content-type: application/json' -H "idempotency-key: x-$RX" \
  -d "{\"customerId\":\"$CID\",\"prescriptionId\":\"$RX\",\"items\":[{\"sku\":\"SALB-100\",\"qty\":1}]}"; echo
OID=$(post /venda/checkout "{\"customerId\":\"$CID\",\"prescriptionId\":\"$RX\",\"items\":[{\"sku\":\"AMOXI-500\",\"qty\":2}]}" | field .orderId)
echo "pedido       $OID"
waitfor "/entrega/shipments/$OID" .status READY_TO_SHIP && echo "  -> estoque reservado, pago, NF emitida: pronto para expedição"
post "/entrega/shipments/$OID/dispatch" '{}' >/dev/null && echo "  -> expedidor despachou"
waitfor "/pedido/orders/$OID" .status DELIVERED && echo "  -> ENTREGUE"
echo "  rastreio: $(get "/pedido/orders/$OID" | field .trackingCode)"
get "/pedido/orders/$OID" | field '.invoice' | sed 's/^/NF fake: /'
echo "trace da compra: $(get "/pedido/orders/$OID" | field .traceId)  (veja em /admin/ops.html?tab=Transações)"
echo "E2E OK"
