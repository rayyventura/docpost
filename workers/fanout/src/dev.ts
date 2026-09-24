import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { processRecord } from './handler.js';
import type { SQSRecord } from 'aws-lambda';

const QUEUE_URL = process.env.UPLOAD_EVENTS_QUEUE_URL
  ?? 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/docpost-upload-events';

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.SQS_ENDPOINT && { endpoint: process.env.SQS_ENDPOINT }),
});

console.log('Fan-out worker polling for upload events...');

async function poll(): Promise<void> {
  while (true) {
    try {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
        }),
      );

      if (!Messages || Messages.length === 0) continue;

      for (const msg of Messages) {
        try {
          await processRecord({
            body: msg.Body!,
            messageId: msg.MessageId!,
            receiptHandle: msg.ReceiptHandle!,
          } as SQSRecord);

          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: QUEUE_URL,
              ReceiptHandle: msg.ReceiptHandle!,
            }),
          );
        } catch (err) {
          console.error('Error processing message:', err);
          // Let visibility timeout handle retry
        }
      }
    } catch (err) {
      console.error('Poll error:', err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

poll();
