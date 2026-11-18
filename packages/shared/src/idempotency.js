import { PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './aws.js';

const TABLE = process.env.IDEMPOTENCY_TABLE || 'cm-idempotency';
const LOCK_SECONDS = Number(process.env.IDEMPOTENCY_LOCK_SECONDS || 30);
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * Tenta reservar a chave. Retorna:
 *  - 'claimed': primeira execução (ou lock anterior expirou: a réplica que segurava morreu)
 *  - 'done':    já processado com sucesso
 *  - 'busy':    outra réplica está processando agora
 * O lock com expiração evita que um crash no meio do processamento "trave" a chave e o evento se perca.
 */
export async function claim(pk) {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk, status: 'IN_PROGRESS', lockedUntil: nowS() + LOCK_SECONDS, expiresAt: nowS() + 86400 },
        ConditionExpression: 'attribute_not_exists(pk) OR (#s = :ip AND lockedUntil < :now)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':ip': 'IN_PROGRESS', ':now': nowS() },
      }),
    );
    return 'claimed';
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    return (await getRecord(pk))?.status === 'DONE' ? 'done' : 'busy';
  }
}

export const release = (pk) => ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk } }));

export const getRecord = async (pk) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk } }))).Item;

export const markDone = (pk, response = null) =>
  ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk },
      UpdateExpression: 'SET #s = :s, #r = :r REMOVE lockedUntil',
      ExpressionAttributeNames: { '#s': 'status', '#r': 'response' },
      ExpressionAttributeValues: { ':s': 'DONE', ':r': response },
    }),
  );

const defaultStore = { claim, release, getRecord, markDone };

/**
 * Idempotency-Key HTTP (store injetável para teste).
 * Mesma chave -> mesma resposta; requisição concorrente com a mesma chave -> 409.
 */
export async function withIdempotency(key, exec, store = defaultStore) {
  const state = await store.claim(key);
  if (state === 'claimed') {
    try {
      const response = await exec();
      await store.markDone(key, response);
      return response;
    } catch (err) {
      await store.release(key);
      throw err;
    }
  }
  if (state === 'done') return { ...(await store.getRecord(key)).response, replayed: true };
  return { status: 409, body: { error: 'request with this Idempotency-Key in progress' } };
}

/**
 * Processamento idempotente de evento. Retorna true se a mensagem pode ser removida da fila.
 * 'busy' -> false: deixa a mensagem voltar (se a outra réplica morrer, o lock expira e alguém reprocessa).
 */
export async function processOnce(key, handler, store = defaultStore) {
  const state = await store.claim(key);
  if (state === 'done') return true;
  if (state === 'busy') return false;
  try {
    await handler();
    await store.markDone(key);
    return true;
  } catch (err) {
    await store.release(key);
    throw err;
  }
}
