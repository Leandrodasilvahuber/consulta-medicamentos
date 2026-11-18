import { randomUUID } from 'node:crypto';
import {
  ListQueuesCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import { ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { ListRulesCommand, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { serve, consume, repo, sqs, ddb, eventBridge, queueUrl, HttpError, log } from '@cm/shared';
import * as docker from './docker.js';
import * as zabbix from './zabbix.js';

const ac = new AbortController();
const audit = repo('cm-audit');

// ---------------- filas / DLQ
async function queues() {
  const urls = (await sqs.send(new ListQueuesCommand({ QueueNamePrefix: 'cm-' }))).QueueUrls || [];
  const rows = await Promise.all(
    urls.map(async (url) => {
      const a = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] })))
        .Attributes;
      return {
        name: url.split('/').pop(),
        visible: Number(a.ApproximateNumberOfMessages),
        inFlight: Number(a.ApproximateNumberOfMessagesNotVisible),
        isDlq: url.endsWith('-dlq'),
      };
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
const dlqTotal = async () => (await queues()).filter((q) => q.isDlq).reduce((s, q) => s + q.visible, 0);

async function peek(name, max = 10) {
  const r = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl(name),
      MaxNumberOfMessages: max,
      VisibilityTimeout: 2,
      AttributeNames: ['All'],
    }),
  );
  return (r.Messages || []).map((m) => {
    let body;
    try {
      body = JSON.parse(m.Body);
    } catch {
      body = m.Body;
    }
    return {
      id: m.MessageId,
      receiveCount: m.Attributes?.ApproximateReceiveCount,
      sentAt: new Date(Number(m.Attributes?.SentTimestamp)).toISOString(),
      type: body?.['detail-type'] || '(inválida)',
      traceId: body?.detail?.traceId,
      body,
    };
  });
}

/** Redrive: devolve mensagens da DLQ para a fila de origem. */
async function redrive(queue) {
  let moved = 0;
  for (;;) {
    const r = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl(`${queue}-dlq`), MaxNumberOfMessages: 10 }),
    );
    if (!r.Messages?.length) break;
    for (const m of r.Messages) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl(queue), MessageBody: m.Body }));
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl(`${queue}-dlq`), ReceiptHandle: m.ReceiptHandle }),
      );
      moved++;
    }
  }
  return { moved };
}

// ---------------- recursos / inventário
async function resources() {
  const list = await docker.containers();
  return Promise.all(
    list.map(async (c) => {
      if (c.state !== 'running') return c;
      const [st, app] = await Promise.all([
        docker.stats(c.id).catch(() => ({})),
        fetch(`http://${c.name}:3000/metrics`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.json())
          .catch(() => null),
      ]);
      return { ...c, ...st, app };
    }),
  );
}

async function inventory() {
  const tables = (await ddb.send(new ListTablesCommand({}))).TableNames || [];
  const tableInfo = await Promise.all(
    tables.map(async (t) => {
      const d = (await ddb.send(new DescribeTableCommand({ TableName: t }))).Table;
      return { name: t, items: d.ItemCount, bytes: d.TableSizeBytes };
    }),
  );
  const rules = (await eventBridge.send(new ListRulesCommand({ EventBusName: 'cm-bus' }))).Rules || [];
  return {
    tables: tableInfo,
    queues: await queues(),
    rules: rules.map((r) => ({ name: r.Name, pattern: r.EventPattern, state: r.State })),
  };
}

// ---------------- logs agregados
async function aggregatedLogs({ q, service, level, tail = 300 }) {
  const list = (await docker.containers()).filter(
    (c) => c.state === 'running' && (!service || c.service === service) && c.service !== 'zabbix-web',
  );
  const all = (
    await Promise.all(
      list.map(async (c) =>
        (await docker.logs(c.id, tail).catch(() => [])).map((line) => {
          try {
            return { container: c.name, ...JSON.parse(line) };
          } catch {
            return { container: c.name, msg: line };
          }
        }),
      ),
    )
  ).flat();
  return all
    .filter((l) => (!q || JSON.stringify(l).includes(q)) && (!level || l.level === level))
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, 500);
}

// ---------------- rastreamento de transações (event store de auditoria)
async function scanAudit() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: 'cm-audit', ExclusiveStartKey }));
    items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function traces(q) {
  const items = (await scanAudit()).filter((i) => !q || i.raw.includes(q));
  const byTrace = {};
  for (const e of items) {
    const t = (byTrace[e.traceId] ||= {
      traceId: e.traceId,
      events: 0,
      first: e.at,
      last: e.at,
      types: new Set(),
    });
    t.events++;
    t.types.add(e.type);
    if (e.at < t.first) t.first = e.at;
    if (e.at > t.last) t.last = e.at;
  }
  return Object.values(byTrace)
    .map((t) => ({ ...t, types: [...t.types], durationMs: new Date(t.last) - new Date(t.first) }))
    .sort((a, b) => b.last.localeCompare(a.last))
    .slice(0, 100);
}

async function trace(id) {
  const events = (await scanAudit()).filter((i) => i.traceId === id).sort((a, b) => a.at.localeCompare(b.at));
  if (!events.length) throw new HttpError(404, 'trace não encontrado');
  const t0 = new Date(events[0].at);
  return {
    traceId: id,
    events: events.map((e) => ({
      ...e,
      raw: undefined,
      detail: JSON.parse(e.raw),
      offsetMs: new Date(e.at) - t0,
    })),
    logs: await aggregatedLogs({ q: id, tail: 1000 }),
  };
}

// ---------------- laboratório de caos
const journal = (action, details) =>
  ddb.send(
    new PutCommand({
      TableName: 'cm-chaos',
      Item: {
        pk: `exp#${Date.now()}#${randomUUID().slice(0, 4)}`,
        type: 'Experiment',
        action,
        details,
        at: new Date().toISOString(),
      },
    }),
  );

async function chaosState() {
  const items = (await ddb.send(new ScanCommand({ TableName: 'cm-chaos' }))).Items || [];
  return {
    faults: items.filter((i) => i.type === 'Fault'),
    journal: items
      .filter((i) => i.type === 'Experiment')
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 50),
  };
}

async function pickContainers(service, which = 'random') {
  const list = (await docker.containers()).filter((c) => c.service === service);
  if (!list.length) throw new HttpError(404, `serviço ${service} sem containers`);
  if (service === 'admin') throw new HttpError(422, 'o admin não se auto-destrói :)');
  return which === 'all' ? list : [list[Math.floor(Math.random() * list.length)]];
}

const routes = {
  'GET /overview': async () => {
    const [q, c, p] = await Promise.all([queues(), docker.containers(), zabbix.problems().catch(() => null)]);
    return {
      dlqTotal: q.filter((x) => x.isDlq).reduce((s, x) => s + x.visible, 0),
      backlog: q.filter((x) => !x.isDlq).reduce((s, x) => s + x.visible + x.inFlight, 0),
      containersUp: c.filter((x) => x.state === 'running').length,
      containersTotal: c.length,
      zabbixProblems: p ? p.length : 'indisponível',
      faultsActive: (await chaosState()).faults.length,
    };
  },
  'GET /dlq-total': dlqTotal,
  'GET /queues': queues,
  'GET /queues/:name/messages': ({ params }) => peek(params.name),
  'POST /queues/:name/redrive': async ({ params }) => {
    const r = await redrive(params.name);
    await journal('redrive', { queue: params.name, ...r });
    return r;
  },
  'POST /queues/:name/purge': async ({ params }) => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl(params.name) }));
    return { purged: params.name };
  },
  'GET /resources': resources,
  'GET /inventory': inventory,
  'GET /logs': ({ query }) => aggregatedLogs(query),
  'GET /traces': ({ query }) => traces(query.q),
  'GET /traces/:id': ({ params }) => trace(params.id),
  'GET /config': () => ({
    env: process.env.APP_ENV || 'dev',
    zabbixPort: Number(process.env.ZABBIX_PORT || 8081),
  }),
  'GET /zabbix/problems': () => zabbix.problems(),
  'POST /zabbix/provision': () => zabbix.provision().then(() => ({ ok: true })),

  'GET /chaos': chaosState,
  // falhas injetadas no código (latência / taxa de erro HTTP / taxa de erro no consumidor)
  'POST /chaos/faults': async ({ body }) => {
    const item = {
      pk: body.target || '*',
      type: 'Fault',
      latencyMs: Number(body.latencyMs) || 0,
      httpErrorRate: Number(body.httpErrorRate) || 0,
      consumerErrorRate: Number(body.consumerErrorRate) || 0,
      at: new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: 'cm-chaos', Item: item }));
    await journal('fault.set', item);
    return item;
  },
  'POST /chaos/faults/clear': async () => {
    for (const f of (await chaosState()).faults)
      await ddb.send(new DeleteCommand({ TableName: 'cm-chaos', Key: { pk: f.pk } }));
    await journal('fault.clear', {});
    return { cleared: true };
  },
  // infraestrutura: kill / restart / pause temporário de réplicas
  'POST /chaos/container': async ({ body }) => {
    const targets = await pickContainers(body.service, body.which);
    const act = body.action || 'kill';
    for (const c of targets) await docker.action(c.id, act);
    if (act === 'pause' || act === 'stop' || act === 'kill') {
      const secs = Number(body.durationSec) || 30;
      setTimeout(() => {
        for (const c of targets) docker.action(c.id, act === 'pause' ? 'unpause' : 'start').catch(() => {});
      }, secs * 1000).unref();
    }
    await journal(`container.${act}`, {
      service: body.service,
      containers: targets.map((c) => c.name),
      durationSec: body.durationSec,
    });
    return {
      action: act,
      containers: targets.map((c) => c.name),
      autoRecoverSec: Number(body.durationSec) || 30,
    };
  },
  // queda da dependência (LocalStack = "AWS" fora do ar)
  'POST /chaos/aws-outage': async ({ body }) => {
    const [ls] = await pickContainers('localstack');
    const secs = Math.min(Number(body.seconds) || 15, 120);
    await docker.action(ls.id, 'pause');
    setTimeout(() => docker.action(ls.id, 'unpause').catch(() => {}), secs * 1000).unref();
    await journal('aws.outage', { seconds: secs });
    return { pausedFor: secs };
  },
  // mensagens envenenadas -> devem terminar na DLQ
  'POST /chaos/poison': async ({ body }) => {
    const queue = body.queue || 'cm-pedido-q';
    for (let i = 0; i < (Number(body.count) || 1); i++)
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl(queue), MessageBody: '{"veneno": tru' }));
    await journal('poison', { queue, count: body.count || 1 });
    return { queue, sent: Number(body.count) || 1 };
  },
  // rajada de carga na fila de NF (eventos sintéticos) -> observar autoscaling/backlog
  'POST /chaos/burst': async ({ body }) => {
    const count = Math.min(Number(body.count) || 50, 500);
    for (let i = 0; i < count; i += 10) {
      await eventBridge.send(
        new PutEventsCommand({
          Entries: Array.from({ length: Math.min(10, count - i) }, () => ({
            EventBusName: 'cm-bus',
            Source: 'chaos.lab',
            DetailType: 'OrderPaid',
            Detail: JSON.stringify({
              orderId: `synthetic-${randomUUID()}`,
              eventId: randomUUID(),
              traceId: 'chaos-burst',
              synthetic: true,
              lines: [],
              total: 0,
              producer: 'chaos',
              occurredAt: new Date().toISOString(),
            }),
          })),
        }),
      );
    }
    await journal('burst', { count });
    return { published: count, queue: 'cm-nf-q' };
  },
};

serve(routes, { onShutdown: () => ac.abort() });

// event store de auditoria: recebe TODOS os eventos do barramento
consume(
  'cm-audit-q',
  {
    '*': (detail, type) =>
      audit.put({
        pk: detail.eventId,
        type,
        producer: detail.producer,
        traceId: detail.traceId || 'sem-trace',
        causationId: detail.causationId,
        at: detail.occurredAt,
        raw: JSON.stringify(detail),
      }),
  },
  { signal: ac.signal },
);

zabbix.provisionInBackground();
log.info('admin.ready');
