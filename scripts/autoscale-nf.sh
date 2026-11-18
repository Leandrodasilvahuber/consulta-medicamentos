#!/bin/bash
# Simula o Auto Scaling do EC2 da NF localmente: escala o nf-worker pela profundidade da fila SQS.
# (na AWS real isso é feito pelo ASG + alarme CloudWatch definidos em infra/terraform)
set -euo pipefail
MIN=${MIN:-2}; MAX=${MAX:-6}; PER_WORKER=${PER_WORKER:-10}
while true; do
  depth=$(aws --endpoint-url http://localhost:4566 --region us-east-1 sqs get-queue-attributes \
    --queue-url http://localhost:4566/000000000000/cm-nf-q --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' --output text 2>/dev/null || echo 0)
  want=$(( (depth + PER_WORKER - 1) / PER_WORKER )); (( want < MIN )) && want=$MIN; (( want > MAX )) && want=$MAX
  have=$(docker compose ps -q nf-worker | wc -l)
  if [ "$want" != "$have" ]; then
    echo "$(date +%T) fila=$depth workers $have -> $want"
    docker compose up -d --no-recreate --scale nf-worker="$want" nf-worker >/dev/null
  fi
  sleep 10
done
