import { PutCommand, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './aws.js';

/** Repositório mínimo — uma tabela DynamoDB por serviço (database-per-service). */
export function repo(table) {
  const self = {
    put: (item) => ddb.send(new PutCommand({ TableName: table, Item: item })).then(() => item),
    get: async (pk) => (await ddb.send(new GetCommand({ TableName: table, Key: { pk } }))).Item,
    list: async (type) =>
      (
        await ddb.send(
          new ScanCommand({
            TableName: table,
            FilterExpression: '#t = :t',
            ExpressionAttributeNames: { '#t': 'type' },
            ExpressionAttributeValues: { ':t': type },
          }),
        )
      ).Items,
    patch: async (pk, fields) => {
      const keys = Object.keys(fields);
      const res = await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk },
          UpdateExpression: 'SET ' + keys.map((k, i) => `#k${i} = :v${i}`).join(', '),
          ExpressionAttributeNames: Object.fromEntries(keys.map((k, i) => [`#k${i}`, k])),
          ExpressionAttributeValues: Object.fromEntries(keys.map((k, i) => [`:v${i}`, fields[k]])),
          ReturnValues: 'ALL_NEW',
        }),
      );
      return res.Attributes;
    },
    /**
     * Máquina de estados monotônica: grava os campos sempre, mas só avança o status se o rank for maior.
     * Protege contra eventos fora de ordem entre réplicas (condição atômica no DynamoDB).
     */
    advance: async (pk, rank, status, fields = {}) => {
      try {
        const res = await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk },
            UpdateExpression:
              'SET #s = :s, #rk = :rk' +
              Object.keys(fields)
                .map((k, i) => `, #f${i} = :f${i}`)
                .join(''),
            ConditionExpression: 'attribute_not_exists(#rk) OR #rk < :rk',
            ExpressionAttributeNames: {
              '#s': 'status',
              '#rk': 'statusRank',
              ...Object.fromEntries(Object.keys(fields).map((k, i) => [`#f${i}`, k])),
            },
            ExpressionAttributeValues: {
              ':s': status,
              ':rk': rank,
              ...Object.fromEntries(Object.values(fields).map((v, i) => [`:f${i}`, v])),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return res.Attributes;
      } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
        // evento atrasado: guarda só os dados, mantém o status mais avançado
        return Object.keys(fields).length ? self.patch(pk, fields) : self.get(pk);
      }
    },
  };
  return self;
}
