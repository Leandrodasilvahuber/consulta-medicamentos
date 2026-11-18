# Vitalis Farmácia & Clínica: POC event-driven (LocalStack)

Demo **mínima e 100% fake** (pagamento, telemedicina, NF e transportadora são simulados) de um sistema de
consulta → receita → venda → pedido → pagamento → NF → entrega, com microserviços Node.js orientados a eventos,
rodando localmente na LocalStack.

## Subir

```bash
npm install            # dev deps (lint/test) + lockfile
docker compose up -d --build
bash scripts/e2e.sh    # fluxo ponta a ponta
bash scripts/chaos-experiments.sh   # laboratório de caos via CLI
```

**Atalho na área de trabalho (Linux/GNOME):** `bash scripts/install-desktop.sh` cria o ícone "Vitalis Farmácia & Clínica (LocalStack)".
Ele sobe a stack, espera ficar pronta e abre o backoffice. Clique com o botão direito para "Parar a stack" ou "Abrir backoffice".
Também dá para usar `scripts/start.sh` e `scripts/stop.sh` direto.

> A primeira subida demora: o bootstrap da LocalStack leva alguns minutos e o build do Strapi também.

| URL                          | O quê                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| http://localhost:8080/       | Landing de **consultas** (consulta → receita → compra)                    |
| http://localhost:8080/loja/  | Landing da **farmácia** (ordem inversa: medicamento → receita → consulta) |
| http://localhost:8080/admin/ | Backoffice: Médico, Paciente, Estoque, Expedição, Operações, Lab. de Caos |
| http://localhost:1337/admin  | Strapi (CMS das landings)                                                 |
| http://localhost:8081        | Zabbix (Admin / zabbix)                                                   |
| http://localhost:4566        | LocalStack                                                                |

## Arquitetura

```
landing/admin ─► nginx gateway (LB + retry em outra réplica) ─► serviços HTTP (2 réplicas cada)
                                                                    │ publish
                                                                    ▼
                                      EventBridge (cm-bus) ── regras ──► SQS por serviço (+DLQ) ──► consumidores
                                                                    └──► cm-audit-q ──► admin (event store / traces)
```

| Serviço       | Responsabilidade                                   | Consome                                            |
| ------------- | -------------------------------------------------- | -------------------------------------------------- |
| `cadastro`    | clientes, colaboradores, fornecedores              | —                                                  |
| `agendamento` | agenda consulta e dispara cobrança                 | PaymentApproved/Declined                           |
| `consulta`    | sala online (fake) e finalização pelo médico       | AppointmentConfirmed                               |
| `receita`     | emite receita (validade 180 dias)                  | ConsultationCompleted                              |
| `venda`       | catálogo + checkout **validado contra a receita**  | PrescriptionIssued (projeção local)                |
| `estoque`     | saldo, reserva atômica, compensação (saga)         | OrderPlaced, PaymentDeclined                       |
| `pedido`      | ciclo de vida do pedido (máquina de estados)       | OrderPlaced, Stock*, Payment*, Invoice*, Shipment* |
| `pagamento`   | gateway fake (valor terminado em ,13 é recusado)   | AppointmentRequested, OrderCreated                 |
| `nf-worker`   | emissão **assíncrona** de NF fake (worker de fila) | OrderPaid                                          |
| `entrega`     | separação/despacho/entrega (transportadora fake)   | InvoiceIssued                                      |
| `admin`       | operações, observabilidade e laboratório de caos   | todos (fila de auditoria)                          |

Saga da compra: `OrderPlaced → StockReserved → OrderCreated → PaymentApproved → OrderPaid → InvoiceIssued →`
(expedidor despacha) `ShipmentDispatched → ShipmentDelivered`. Falta de estoque ou pagamento recusado levam o
pedido a `CANCELLED`, e o estoque é devolvido.

### Disponibilidade e redundância

- **2 réplicas** por serviço (competing consumers na mesma fila SQS), limite de memória por container.
- **Gateway** com `proxy_next_upstream` (inclusive POST, que é seguro por causa da Idempotency-Key) e rate limit.
- **DLQ** em todas as filas (`maxReceiveCount=5`) e redrive pelo painel.
- **Idempotência** em 2 níveis (`packages/shared/src/idempotency.js`):
  - HTTP: todo POST exige `Idempotency-Key`. Mesma chave devolve a mesma resposta; com a requisição ainda em andamento, devolve 409.
  - Consumidor: dedupe por `eventId` com escrita condicional no DynamoDB (atômico entre réplicas).
- **Lock com expiração** na idempotência: se uma réplica morre no meio do processamento, outra retoma depois de 30s, sem perder o evento.
- **Status monotônico** (`repo.advance`): eventos fora de ordem nunca regridem o pedido.
- Estoque nunca fica negativo e cada movimentação acontece uma vez só (`TransactWrite` com id determinístico).
- Receita com trava otimista (`version`): checkouts simultâneos não ultrapassam o limite prescrito. Graceful shutdown: o health responde 503 e o LB tira a réplica.
- **NF em EC2 escalável:** `infra/terraform` define o Launch Template, o ASG multi-AZ (2 a 6) e alarmes de profundidade da fila.
  O ASG é recurso Pro na LocalStack, então fica atrás de `-var enable_autoscaling=true` (ligue na AWS real).
  Localmente, `scripts/autoscale-nf.sh` escala `nf-worker` pela fila. Também dá para usar `docker compose up --scale nf-worker=N`.

### Observabilidade (Backoffice → Operações)

- **Filas & DLQ:** profundidade, mensagens em processamento, ver mensagem, redrive e descarte.
- **Transações:** o `traceId` atravessa HTTP → eventos → serviços (AsyncLocalStorage). A tela mostra a linha do tempo dos eventos e os logs correlacionados.
- **Recursos:** memória/CPU por container (Docker API) + heap, event loop p99 e contadores de eventos de cada app.
- **Inventário AWS:** tabelas DynamoDB (itens/bytes) e regras de roteamento do EventBridge.
- **Logs:** logs JSON agregados de todos os containers, com filtro por texto, traceId, serviço e nível.
- **Zabbix:** o admin provisiona sozinho os hosts, os itens HTTP `/health` e os triggers (serviço fora do ar, DLQ > 0).

### Laboratório de Caos (Backoffice → Lab. de Caos)

Hipótese de estado estável: _toda compra paga chega a ENTREGUE, sem perda de evento e sem duplicidade_.

- Falhas na aplicação (por serviço ou globais): latência, taxa de erro HTTP, taxa de erro no consumidor.
- Infraestrutura: kill, pause, stop ou restart de réplica, com recuperação automática.
- **Queda da AWS** (LocalStack pausada), **mensagens envenenadas** (devem cair na DLQ) e **rajada de NFs**.
- Experimentos guiados, sonda E2E pelo navegador e diário de experimentos.

### Áreas por perfil (demo sem autenticação)

- **Médico:** fila de consultas confirmadas, sala online e prescrição (produto + quantidade máxima).
- **Paciente:** agendamentos, link da sala, receitas (validade) e pedidos com andamento, NF e rastreio.
- **Estoquista:** saldo, alerta de estoque baixo, entrada por fornecedor/ajuste, pedidos bloqueados e movimentações.
- **Expedidor:** separação (picking com NF), despacho, em trânsito e entregues.

## Monorepo e CI/CD

```
packages/shared   lib comum: eventos, idempotência, tracing, caos, http, repo
services/*        microserviços (uma imagem Docker; SERVICE escolhe qual roda)
apps/landing-*    landings estáticas (conteúdo via Strapi, com fallback)
apps/admin        backoffice
apps/cms          Strapi v5
infra/            bootstrap LocalStack, gateway nginx, terraform (EC2/ASG), postgres
```

- `npm run validate`: ESLint + Prettier + testes (`node --test`).
- `.github/workflows/ci.yml`: validações estáticas (lint, format, testes, `npm audit`, `docker compose config`,
  hadolint, shellcheck, `terraform fmt/validate`).
- `.github/workflows/cd.yml`: sobe a stack na LocalStack, aplica o terraform e roda o E2E.

## Limitações (é POC)

- Sem autenticação/RBAC. NF, pagamento e vídeo são fake.
- Listagens usam `Scan` no DynamoDB.
- Não há outbox: se o `publish` falhar logo depois de gravar, o retry via Idempotency-Key resolve na maioria dos casos, mas não em todos.
- O admin acessa o `docker.sock`. Por isso todas as portas ficam presas em `127.0.0.1`.
- Postgres único para Strapi e Zabbix.
- O caos nunca afeta o próprio `admin`, para sempre ser possível desligá-lo.

> **Rodando junto com o projeto `cannabis-medicinal`:** as duas stacks usam as mesmas portas (8080, 1337, 4566, 8081).
> Pare uma (`scripts/stop.sh`) antes de subir a outra.
