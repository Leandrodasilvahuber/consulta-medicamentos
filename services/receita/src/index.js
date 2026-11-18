import { randomUUID } from 'node:crypto';
import { serve, repo, publish, consume, HttpError, filterBy, notFound } from '@cm/shared';

const db = repo('cm-receita');
const ac = new AbortController();
const VALIDITY_DAYS = 180;

serve(
  {
    'GET /prescriptions': async ({ query }) => filterBy(await db.list('Prescription'), query),
    'GET /prescriptions/:id': async ({ params }) => notFound(await db.get(params.id)),
    'GET /prescriptions/by-consultation/:id': async ({ params }) =>
      (await db.list('Prescription')).find((p) => p.consultationId === params.id) ||
      Promise.reject(new HttpError(404, 'ainda não emitida')),
  },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-receita-q',
  {
    ConsultationCompleted: async (e) => {
      const p = await db.put({
        pk: randomUUID(),
        type: 'Prescription',
        consultationId: e.consultationId,
        customerId: e.customerId,
        doctor: e.doctor,
        crm: 'CRM-FAKE-0000',
        items: e.items,
        notes: e.notes,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + VALIDITY_DAYS * 864e5).toISOString(),
      });
      await publish('PrescriptionIssued', {
        prescriptionId: p.pk,
        customerId: p.customerId,
        items: p.items,
        expiresAt: p.expiresAt,
      });
    },
  },
  { signal: ac.signal },
);
