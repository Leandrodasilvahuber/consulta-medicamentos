import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { serve, repo, publish, consume, HttpError, CATALOG, ddb } from '@cm/shared';
import { validateAgainstPrescription } from './rules.js';

const db = repo('cm-venda');
const ac = new AbortController();

serve(
  {
    'GET /products': () => CATALOG,
    'POST /checkout': async ({ body }) => {
      const { customerId, prescriptionId, items = [] } = body;
      if (!customerId || !prescriptionId || !items.length)
        throw new HttpError(422, 'customerId, prescriptionId e items obrigatórios');
      const rx = await db.get(`rx#${prescriptionId}`);
      const errors = validateAgainstPrescription(rx, items, customerId);
      if (errors.length) throw new HttpError(422, errors.join('; '));

      const lines = items.map((i) => {
        const p = CATALOG.find((c) => c.sku === i.sku);
        if (!p) throw new HttpError(422, `sku inexistente ${i.sku}`);
        return { ...i, name: p.name, unitPrice: p.price };
      });
      const total = Math.round(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0) * 100) / 100;
      const used = { ...(rx.used || {}) };
      for (const i of items) used[i.sku] = (used[i.sku] || 0) + i.qty;
      // trava otimista: dois checkouts simultâneos na mesma receita não ultrapassam o limite
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: 'cm-venda',
            Key: { pk: rx.pk },
            UpdateExpression: 'SET used = :u, version = :next',
            ConditionExpression: 'attribute_not_exists(version) OR version = :v',
            ExpressionAttributeValues: { ':u': used, ':v': rx.version ?? 0, ':next': (rx.version ?? 0) + 1 },
          }),
        );
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException')
          throw new HttpError(409, 'receita alterada por outra compra simultânea, tente novamente');
        throw err;
      }

      const orderId = randomUUID();
      await publish('OrderPlaced', {
        orderId,
        customerId,
        prescriptionId,
        lines,
        total,
        address: body.address || 'Rua Fake, 123',
      });
      return { $status: 202, body: { orderId, total, status: 'PLACED' } };
    },
  },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-venda-q',
  {
    PrescriptionIssued: (e) =>
      db.put({ pk: `rx#${e.prescriptionId}`, type: 'PrescriptionView', ...e, used: {} }),
  },
  { signal: ac.signal },
);
