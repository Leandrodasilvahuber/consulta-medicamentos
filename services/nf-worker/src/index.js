import { randomInt } from 'node:crypto';
import { consume, publish, repo, log, serve, filterBy } from '@cm/shared';

const db = repo('cm-nf');
const ac = new AbortController();
const fakeAccessKey = () => Array.from({ length: 44 }, () => randomInt(10)).join('');

// worker de fila; HTTP apenas para health/metrics (Zabbix / ASG health check) e consulta
serve(
  { 'GET /invoices': async ({ query }) => filterBy(await db.list('Invoice'), query) },
  { onShutdown: () => ac.abort() },
);

consume(
  'cm-nf-q',
  {
    OrderPaid: async (e) => {
      await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SEFAZ_MS || 1500))); // latência da SEFAZ
      const nf = await db.put({
        pk: e.orderId,
        type: 'Invoice',
        orderId: e.orderId,
        number: String(randomInt(1e5, 1e6)),
        series: '1',
        accessKey: fakeAccessKey(),
        total: e.total,
        lines: e.lines,
        synthetic: !!e.synthetic,
        issuedAt: new Date().toISOString(),
        sefaz: 'FAKE-AUTORIZADA',
        worker: process.env.HOSTNAME,
      });
      log.info('nf.issued', { orderId: e.orderId, number: nf.number, worker: process.env.HOSTNAME });
      await publish('InvoiceIssued', {
        orderId: e.orderId,
        number: nf.number,
        accessKey: nf.accessKey,
        address: e.address,
        lines: e.lines,
        synthetic: !!e.synthetic,
      });
    },
  },
  { signal: ac.signal },
);
