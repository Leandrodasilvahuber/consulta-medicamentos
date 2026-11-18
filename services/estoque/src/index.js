import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { serve, repo, publish, consume, HttpError, CATALOG, ddb, log } from '@cm/shared';

const TABLE = 'cm-estoque';
const db = repo(TABLE);
const ac = new AbortController();
const LOW_STOCK = 5;

/**
 * Movimenta estoque de forma atômica e idempotente (TransactWrite):
 *  - saldo nunca fica negativo, mesmo com várias réplicas;
 *  - o registro da movimentação tem id determinístico, então reprocessar o mesmo evento não movimenta 2x.
 * Retorna o saldo atualizado, ou null se não houver saldo.
 */
async function move(sku, delta, reason, ref, movementId = randomUUID()) {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: {
                pk: `mv#${movementId}`,
                type: 'Movement',
                sku,
                delta,
                reason,
                ref,
                at: new Date().toISOString(),
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { pk: `sku#${sku}` },
              UpdateExpression: 'ADD available :d',
              ConditionExpression: 'attribute_exists(pk) AND available >= :min',
              ExpressionAttributeValues: { ':d': delta, ':min': delta < 0 ? -delta : 0 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err;
    const [mv] = err.CancellationReasons || [];
    if (mv?.Code !== 'ConditionalCheckFailed') return null; // sem saldo / SKU inexistente
    // movimentação já aplicada antes (retry): segue como sucesso
  }
  const stock = await db.get(`sku#${sku}`);
  if (stock.available <= LOW_STOCK) await publish('StockLow', { sku, available: stock.available });
  return stock;
}

// seed do estoque inicial (fake)
for (const p of CATALOG) {
  if (!(await db.get(`sku#${p.sku}`)))
    await db.put({ pk: `sku#${p.sku}`, type: 'Stock', sku: p.sku, name: p.name, available: 20 });
}

serve(
  {
    'GET /stock': () => db.list('Stock'),
    'GET /movements': async () =>
      (await db.list('Movement')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
    // estoquista: entrada de mercadoria (fornecedor) ou ajuste de inventário
    'POST /stock/:sku/adjust': async ({ params, body }) => {
      const delta = Number(body.delta);
      if (!Number.isInteger(delta) || delta === 0) throw new HttpError(422, 'delta inteiro != 0');
      const r = await move(params.sku, delta, body.reason || 'ajuste manual', body.supplierId);
      if (!r) throw new HttpError(409, 'estoque insuficiente ou SKU inexistente');
      return r;
    },
  },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-estoque-q',
  {
    // saga: reserva antes da cobrança; compensa se algum item faltar
    OrderPlaced: async (e) => {
      const done = [];
      for (const l of e.lines) {
        if (await move(l.sku, -l.qty, 'reserva pedido', e.orderId, `res#${e.orderId}#${l.sku}`)) done.push(l);
        else {
          for (const d of done)
            await move(d.sku, d.qty, 'compensação reserva', e.orderId, `comp#${e.orderId}#${d.sku}`);
          log.warn('stock.unavailable', { orderId: e.orderId, sku: l.sku });
          return publish('StockUnavailable', { orderId: e.orderId, sku: l.sku });
        }
      }
      await db.put({ pk: `res#${e.orderId}`, type: 'Reservation', orderId: e.orderId, lines: e.lines });
      await publish('StockReserved', { orderId: e.orderId });
    },
    // pagamento recusado -> devolve a reserva
    PaymentDeclined: async (e) => {
      if (e.context !== 'order') return;
      const res = await db.get(`res#${e.referenceId}`);
      for (const l of res?.lines || [])
        await move(
          l.sku,
          l.qty,
          'estorno pagamento recusado',
          e.referenceId,
          `refund#${e.referenceId}#${l.sku}`,
        );
    },
  },
  { signal: ac.signal },
);
