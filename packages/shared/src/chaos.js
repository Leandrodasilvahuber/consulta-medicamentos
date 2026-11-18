import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './aws.js';
import { log } from './logger.js';

/**
 * Injeção de falhas controlada pelo Laboratório de Caos (tabela cm-chaos).
 * Config por serviço ou global ('*'): { latencyMs, httpErrorRate, consumerErrorRate }
 */
let current = {};
const SERVICE = process.env.SERVICE;

async function refresh() {
  try {
    // 1 leitura em lote por réplica a cada 5s (barato até para a LocalStack)
    const r = await ddb.send(
      new BatchGetCommand({ RequestItems: { 'cm-chaos': { Keys: [{ pk: SERVICE }, { pk: '*' }] } } }),
    );
    const items = r.Responses?.['cm-chaos'] || [];
    const own = items.find((i) => i.pk === SERVICE);
    const all = items.find((i) => i.pk === '*');
    const next = { ...(all || {}), ...(own || {}) };
    if (JSON.stringify(next) !== JSON.stringify(current)) log.warn('chaos.config', next);
    current = next;
  } catch {
    /* sem config de caos = sem falhas */
  }
}
// o admin (painel de controle do caos) nunca recebe falhas: senão não daria para desligá-las
const IMMUNE = SERVICE === 'admin' || process.env.NODE_ENV === 'test';
if (!IMMUNE) setInterval(refresh, 5000).unref();

export class ChaosError extends Error {}

export async function injectFault(kind) {
  if (current.latencyMs) await new Promise((r) => setTimeout(r, Number(current.latencyMs)));
  const rate = Number(kind === 'http' ? current.httpErrorRate : current.consumerErrorRate) || 0;
  if (Math.random() < rate) throw new ChaosError(`chaos: falha injetada (${kind})`);
}
