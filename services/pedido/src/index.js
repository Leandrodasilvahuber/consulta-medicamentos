import { serve, repo, publish, consume, filterBy, notFound } from '@cm/shared';

const db = repo('cm-pedido');
const ac = new AbortController();

export const FLOW = ['AWAITING_STOCK', 'AWAITING_PAYMENT', 'PAID', 'INVOICED', 'SHIPPED', 'DELIVERED'];
const RANK = { ...Object.fromEntries(FLOW.map((s, i) => [s, i])), CANCELLED: 99 };
const status = (id, s, extra = {}) =>
  db.advance(id, RANK[s], s, { ...extra, updatedAt: new Date().toISOString() });

serve(
  {
    'GET /orders': async ({ query }) =>
      filterBy(await db.list('Order'), query).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    'GET /orders/:id': async ({ params }) => notFound(await db.get(params.id)),
  },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-pedido-q',
  {
    OrderPlaced: (e) =>
      db.advance(e.orderId, 0, 'AWAITING_STOCK', {
        type: 'Order',
        customerId: e.customerId,
        prescriptionId: e.prescriptionId,
        lines: e.lines,
        total: e.total,
        address: e.address,
        traceId: e.traceId,
        createdAt: e.occurredAt,
      }),
    StockReserved: async (e) => {
      const o = await status(e.orderId, 'AWAITING_PAYMENT');
      if (!o.total) throw new Error('pedido ainda não projetado (eventos fora de ordem) - retry');
      await publish('OrderCreated', { orderId: o.pk, customerId: o.customerId, amount: o.total });
    },
    StockUnavailable: (e) => status(e.orderId, 'CANCELLED', { cancelReason: `sem estoque de ${e.sku}` }),
    PaymentDeclined: (e) =>
      e.context === 'order' && status(e.referenceId, 'CANCELLED', { cancelReason: 'pagamento recusado' }),
    PaymentApproved: async (e) => {
      if (e.context !== 'order') return;
      const o = await status(e.referenceId, 'PAID', { paymentId: e.paymentId });
      await publish('OrderPaid', {
        orderId: o.pk,
        customerId: o.customerId,
        lines: o.lines,
        total: o.total,
        address: o.address,
      });
    },
    InvoiceIssued: (e) =>
      !e.synthetic &&
      status(e.orderId, 'INVOICED', { invoice: { number: e.number, accessKey: e.accessKey } }),
    ShipmentDispatched: (e) => status(e.orderId, 'SHIPPED', { trackingCode: e.trackingCode }),
    ShipmentDelivered: (e) => status(e.orderId, 'DELIVERED'),
  },
  { signal: ac.signal },
);
