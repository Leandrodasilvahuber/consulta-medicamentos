#!/bin/bash
# Provisiona a infra event-driven na LocalStack (roda automaticamente quando a LocalStack fica "ready").
set -euo pipefail
R=us-east-1
BUS=cm-bus
ACC=000000000000

awslocal events create-event-bus --name "$BUS" >/dev/null 2>&1 || true

# Tabelas: idempotência (com TTL) + uma por serviço
for t in idempotency audit chaos cadastro agendamento consulta receita venda pedido pagamento nf entrega estoque; do
  awslocal dynamodb create-table --table-name "cm-$t" \
    --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null 2>&1 || true
done
awslocal dynamodb update-time-to-live --table-name cm-idempotency \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt >/dev/null 2>&1 || true

# fila do serviço : eventos que ela assina (EventBridge rule -> SQS com DLQ)
declare -A SUBS=(
  [agendamento]='["PaymentApproved","PaymentDeclined"]'
  [consulta]='["AppointmentConfirmed"]'
  [receita]='["ConsultationCompleted"]'
  [venda]='["PrescriptionIssued"]'
  [pedido]='["OrderPlaced","StockReserved","StockUnavailable","PaymentApproved","PaymentDeclined","InvoiceIssued","ShipmentDispatched","ShipmentDelivered"]'
  [estoque]='["OrderPlaced","PaymentDeclined"]'
  [pagamento]='["AppointmentRequested","OrderCreated"]'
  [nf]='["OrderPaid"]'
  [entrega]='["InvoiceIssued"]'
)

for svc in "${!SUBS[@]}"; do
  q="cm-$svc-q"
  awslocal sqs create-queue --queue-name "$q-dlq" >/dev/null
  dlq_arn="arn:aws:sqs:$R:$ACC:$q-dlq"
  awslocal sqs create-queue --queue-name "$q" --attributes "{
    \"VisibilityTimeout\":\"10\",
    \"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" >/dev/null
  awslocal events put-rule --event-bus-name "$BUS" --name "to-$svc" \
    --event-pattern "{\"detail-type\":${SUBS[$svc]}}" >/dev/null
  awslocal events put-targets --event-bus-name "$BUS" --rule "to-$svc" \
    --targets "Id=1,Arn=arn:aws:sqs:$R:$ACC:$q" >/dev/null
  echo "[bootstrap] $q <- ${SUBS[$svc]}"
done

# Auditoria: todos os eventos também vão para uma fila de arquivo (event store simples)
awslocal sqs create-queue --queue-name cm-audit-q >/dev/null
awslocal events put-rule --event-bus-name "$BUS" --name to-audit --event-pattern '{"source":[{"prefix":"cm."}]}' >/dev/null
awslocal events put-targets --event-bus-name "$BUS" --rule to-audit --targets "Id=1,Arn=arn:aws:sqs:$R:$ACC:cm-audit-q" >/dev/null

awslocal s3 mb s3://cm-documentos >/dev/null 2>&1 || true
echo "[bootstrap] OK"
