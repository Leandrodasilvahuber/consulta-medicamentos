import { randomUUID } from 'node:crypto';
import { serve, repo, publish, consume, HttpError, filterBy, notFound } from '@cm/shared';

const db = repo('cm-agendamento');
const PRICE = 150;
const ac = new AbortController();

serve(
  {
    'POST /appointments': async ({ body }) => {
      if (!body.customerId || !body.slot) throw new HttpError(422, 'customerId e slot obrigatórios');
      const appt = await db.put({
        pk: randomUUID(),
        type: 'Appointment',
        customerId: body.customerId,
        customerName: body.customerName,
        slot: body.slot,
        doctor: body.doctor || 'Dra. Fake',
        price: PRICE,
        status: 'AWAITING_PAYMENT',
        createdAt: new Date().toISOString(),
      });
      await publish('AppointmentRequested', {
        appointmentId: appt.pk,
        customerId: appt.customerId,
        amount: PRICE,
      });
      return { id: appt.pk, ...appt };
    },
    'GET /appointments': async ({ query }) => filterBy(await db.list('Appointment'), query),
    'GET /appointments/:id': async ({ params }) => notFound(await db.get(params.id)),
  },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-agendamento-q',
  {
    PaymentApproved: async (e) => {
      if (e.context !== 'appointment') return;
      const appt = await db.patch(e.referenceId, { status: 'CONFIRMED', paymentId: e.paymentId });
      await publish('AppointmentConfirmed', {
        appointmentId: appt.pk,
        customerId: appt.customerId,
        customerName: appt.customerName,
        slot: appt.slot,
        doctor: appt.doctor,
      });
    },
    PaymentDeclined: async (e) => {
      if (e.context === 'appointment') await db.patch(e.referenceId, { status: 'PAYMENT_DECLINED' });
    },
  },
  { signal: ac.signal },
);
