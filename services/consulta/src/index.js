import { serve, repo, publish, consume, HttpError, filterBy, notFound } from '@cm/shared';

const db = repo('cm-consulta');
const ac = new AbortController();

serve(
  {
    // área do médico: ?status=SCHEDULED | área do paciente: ?customerId=
    'GET /consultations': async ({ query }) => filterBy(await db.list('Consultation'), query),
    'GET /consultations/:id': async ({ params }) => notFound(await db.get(params.id)),
    // médico finaliza a consulta e prescreve produtos
    'POST /consultations/:id/complete': async ({ params, body }) => {
      const c = await db.get(params.id);
      if (!c) throw new HttpError(404, 'not found');
      if (c.status === 'COMPLETED') throw new HttpError(409, 'consulta já finalizada');
      if (!Array.isArray(body.items) || !body.items.length)
        throw new HttpError(422, 'items [{sku, maxQty}] obrigatório');
      await db.patch(c.pk, {
        status: 'COMPLETED',
        notes: body.notes || '',
        completedAt: new Date().toISOString(),
      });
      await publish('ConsultationCompleted', {
        consultationId: c.pk,
        customerId: c.customerId,
        doctor: c.doctor,
        items: body.items,
        notes: body.notes || '',
      });
      return { id: c.pk, status: 'COMPLETED' };
    },
  },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-consulta-q',
  {
    AppointmentConfirmed: async (e) => {
      // id da consulta = id do agendamento (simplifica o rastreio no demo)
      await db.put({
        pk: e.appointmentId,
        type: 'Consultation',
        customerId: e.customerId,
        customerName: e.customerName,
        doctor: e.doctor,
        slot: e.slot,
        roomUrl: `https://meet.fake.local/sala/${e.appointmentId}`,
        status: 'SCHEDULED',
      });
    },
  },
  { signal: ac.signal },
);
