import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Contexto de rastreamento distribuído: traceId atravessa HTTP -> eventos -> outros serviços. */
const als = new AsyncLocalStorage();
export const runWithTrace = (ctx, fn) =>
  als.run({ traceId: ctx.traceId || randomUUID(), causationId: ctx.causationId }, fn);
export const currentTrace = () => als.getStore() || {};
