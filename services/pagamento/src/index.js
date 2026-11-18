import { randomUUID } from 'node:crypto';
import { serve, repo, publish, consume, filterBy, notFound } from '@cm/shared';

const db = repo('cm-pagamento');
const ac = new AbortController();

// Gateway FAKE: valores terminados em ,13 são recusados (para demonstrar o caminho de falha / compensação)
async function charge(context, referenceId, customerId, amount) {
  const approved = Math.round(amount * 100) % 100 !== 13;
  const p = await db.put({
    pk: randomUUID(),
    type: 'Payment',
    context,
    referenceId,
    customerId,
    amount,
    method: 'PIX-FAKE',
    status: approved ? 'APPROVED' : 'DECLINED',
    at: new Date().toISOString(),
  });
  await publish(approved ? 'PaymentApproved' : 'PaymentDeclined', {
    paymentId: p.pk,
    context,
    referenceId,
    amount,
  });
}

serve(
  {
    'GET /payments': async ({ query }) => filterBy(await db.list('Payment'), query),
    'GET /payments/:id': async ({ params }) => notFound(await db.get(params.id)),
  },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-pagamento-q',
  {
    AppointmentRequested: (e) => charge('appointment', e.appointmentId, e.customerId, e.amount),
    OrderCreated: (e) => charge('order', e.orderId, e.customerId, e.amount),
  },
  { signal: ac.signal },
);
