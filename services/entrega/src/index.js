import { randomUUID } from 'node:crypto';
import { serve, repo, publish, consume, HttpError, filterBy, notFound, runWithTrace } from '@cm/shared';

const db = repo('cm-entrega');
const ac = new AbortController();
const DELIVERY_MS = Number(process.env.FAKE_DELIVERY_MS || 5000);

async function dispatch(s) {
  if (s.status !== 'READY_TO_SHIP') throw new HttpError(409, `status atual ${s.status}`);
  const trackingCode = `FK${randomUUID().slice(0, 8).toUpperCase()}BR`;
  const out = await db.patch(s.pk, {
    status: 'DISPATCHED',
    trackingCode,
    dispatchedAt: new Date().toISOString(),
  });
  await publish('ShipmentDispatched', { orderId: s.pk, trackingCode });
  // transportadora fake confirma a entrega depois de um tempo
  setTimeout(
    () =>
      fetch(`http://localhost:${process.env.PORT || 3000}/shipments/${s.pk}/delivered`, {
        method: 'POST',
        headers: { 'idempotency-key': `delivered-${s.pk}` },
      }).catch(() => {}),
    DELIVERY_MS,
  ).unref();
  return out;
}

async function deliver(s) {
  if (s.status === 'DELIVERED') return s;
  const out = await db.patch(s.pk, { status: 'DELIVERED', deliveredAt: new Date().toISOString() });
  await publish('ShipmentDelivered', { orderId: s.pk, trackingCode: s.trackingCode });
  return out;
}

// as ações do expedidor continuam o trace da compra (traceId gravado no envio)
const withShipment =
  (fn) =>
  async ({ params }) => {
    const s = await db.get(params.orderId);
    if (!s) throw new HttpError(404, 'not found');
    return runWithTrace({ traceId: s.traceId }, () => fn(s));
  };

serve(
  {
    // área do expedidor: ?status=READY_TO_SHIP
    'GET /shipments': async ({ query }) => filterBy(await db.list('Shipment'), query),
    'GET /shipments/:orderId': async ({ params }) => notFound(await db.get(params.orderId)),
    'POST /shipments/:orderId/dispatch': withShipment(dispatch),
    'POST /shipments/:orderId/delivered': withShipment(deliver), // webhook da transportadora (fake)
  },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-entrega-q',
  {
    InvoiceIssued: async (e) => {
      if (e.synthetic) return;
      await db.put({
        pk: e.orderId,
        type: 'Shipment',
        orderId: e.orderId,
        address: e.address,
        lines: e.lines,
        invoiceNumber: e.number,
        traceId: e.traceId,
        carrier: 'Transportadora Fake',
        status: 'READY_TO_SHIP',
        createdAt: new Date().toISOString(),
      });
    },
  },
  { signal: ac.signal },
);
