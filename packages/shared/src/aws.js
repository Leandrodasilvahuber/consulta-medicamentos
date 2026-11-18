import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SQSClient } from '@aws-sdk/client-sqs';

const cfg = {
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  maxAttempts: 5, // retry com backoff exponencial do SDK
};

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(cfg), {
  marshallOptions: { removeUndefinedValues: true },
});
export const eventBridge = new EventBridgeClient(cfg);
export const sqs = new SQSClient(cfg);
export const queueUrl = (name) => `${cfg.endpoint}/000000000000/${name}`;
