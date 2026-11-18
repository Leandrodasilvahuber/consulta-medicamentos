import { randomUUID } from 'node:crypto';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { eventBridge, sqs, queueUrl } from './aws.js';
import { processOnce } from './idempotency.js';
import { currentTrace, runWithTrace } from './context.js';
import { injectFault } from './chaos.js';
import { log } from './logger.js';
import { metrics } from './metrics.js';

const BUS = process.env.EVENT_BUS || 'cm-bus';

/** Publica um evento de domínio no EventBridge, propagando traceId/causationId. */
export async function publish(type, detail) {
  const eventId = randomUUID();
  const { traceId, causationId } = currentTrace();
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: BUS,
          Source: `cm.${process.env.SERVICE}`,
          DetailType: type,
          Detail: JSON.stringify({
            ...detail,
            eventId,
            traceId: traceId || randomUUID(),
            causationId,
            producer: process.env.SERVICE,
            occurredAt: new Date().toISOString(),
          }),
        },
      ],
    }),
  );
  metrics.inc('events_published');
  log.info('event.published', { type, eventId });
}

/**
 * Consumidor SQS (competing consumers: N réplicas leem a mesma fila).
 * - dedupe por eventId (idempotência do consumidor)
 * - em erro NÃO apaga a msg -> volta após visibility timeout -> DLQ após 5 tentativas
 */
export function consume(queueName, handlers, { signal } = {}) {
  const url = queueUrl(queueName);
  const loop = async () => {
    while (!signal?.aborted) {
      let res;
      try {
        res = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 10,
            AttributeNames: ['ApproximateReceiveCount'],
          }),
        );
      } catch (err) {
        log.warn('sqs.receive.failed', { err: err.message });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const msg of res.Messages || []) await handleMessage(url, msg, handlers);
    }
  };
  loop();
}

async function handleMessage(url, msg, handlers) {
  let evt;
  try {
    evt = JSON.parse(msg.Body);
    if (!evt.detail?.eventId) throw new Error('envelope inválido');
  } catch (err) {
    // mensagem envenenada: não apaga -> após maxReceiveCount vai para a DLQ
    metrics.inc('events_failed');
    return log.error('event.poison', {
      err: err.message,
      receiveCount: msg.Attributes?.ApproximateReceiveCount,
    });
  }
  const type = evt['detail-type'];
  const detail = evt.detail;
  await runWithTrace({ traceId: detail.traceId, causationId: detail.eventId }, async () => {
    const handler = handlers[type] || handlers['*'];
    const key = `event#${process.env.SERVICE}#${detail.eventId}`;
    const started = Date.now();
    try {
      if (handler) {
        const ok = await processOnce(key, async () => {
          await injectFault('consumer');
          await handler(detail, type);
        });
        // outra réplica processando agora: não apaga, a mensagem volta após o visibility timeout
        if (!ok) return log.warn('event.busy', { type, eventId: detail.eventId });
        log.info('event.handled', { type, eventId: detail.eventId, ms: Date.now() - started });
      }
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: msg.ReceiptHandle }));
      metrics.inc('events_consumed');
    } catch (err) {
      metrics.inc('events_failed');
      log.error('event.failed', {
        type,
        eventId: detail.eventId,
        err: err.message,
        receiveCount: msg.Attributes?.ApproximateReceiveCount,
      });
    }
  });
}
