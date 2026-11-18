import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withIdempotency, processOnce } from '../src/idempotency.js';

/** store em memória com o mesmo contrato do DynamoDB (claim/release/getRecord/markDone) */
const memoryStore = () => {
  const m = new Map();
  return {
    m,
    claim: async (k) => {
      const r = m.get(k);
      if (!r || (r.status === 'IN_PROGRESS' && r.lockedUntil < Date.now())) {
        m.set(k, { status: 'IN_PROGRESS', lockedUntil: Date.now() + 30000 });
        return 'claimed';
      }
      return r.status === 'DONE' ? 'done' : 'busy';
    },
    release: async (k) => m.delete(k),
    getRecord: async (k) => m.get(k),
    markDone: async (k, response) => m.set(k, { status: 'DONE', response }),
  };
};

test('HTTP: mesma chave executa uma única vez e reproduz a resposta', async () => {
  const store = memoryStore();
  let calls = 0;
  const exec = async () => ({ status: 201, body: { n: ++calls } });
  const a = await withIdempotency('k1', exec, store);
  const b = await withIdempotency('k1', exec, store);
  assert.equal(calls, 1);
  assert.deepEqual(b.body, a.body);
  assert.equal(b.replayed, true);
});

test('HTTP: falha libera a chave para retry', async () => {
  const store = memoryStore();
  await assert.rejects(
    withIdempotency(
      'k2',
      async () => {
        throw new Error('boom');
      },
      store,
    ),
  );
  const ok = await withIdempotency('k2', async () => ({ status: 201, body: 'ok' }), store);
  assert.equal(ok.body, 'ok');
});

test('HTTP: chave em andamento retorna 409', async () => {
  const store = memoryStore();
  await store.claim('k3');
  const r = await withIdempotency('k3', async () => ({ status: 201 }), store);
  assert.equal(r.status, 409);
});

test('evento: processa uma vez; duplicata é descartada', async () => {
  const store = memoryStore();
  let calls = 0;
  assert.equal(await processOnce('e1', async () => calls++, store), true);
  assert.equal(await processOnce('e1', async () => calls++, store), true);
  assert.equal(calls, 1);
});

test('evento: réplica concorrente não apaga a mensagem (busy)', async () => {
  const store = memoryStore();
  await store.claim('e2');
  assert.equal(await processOnce('e2', async () => {}, store), false);
});

test('evento: lock expirado de réplica que morreu é retomado (sem perda de evento)', async () => {
  const store = memoryStore();
  store.m.set('e3', { status: 'IN_PROGRESS', lockedUntil: Date.now() - 1 });
  let ran = false;
  assert.equal(await processOnce('e3', async () => (ran = true), store), true);
  assert.equal(ran, true);
});
