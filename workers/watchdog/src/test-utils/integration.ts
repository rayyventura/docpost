// Test-only helpers for *.integration.test.ts: local Postgres, LocalStack and
// tiny node:http stub servers. Nothing here is imported by production code.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://docpost_service:docpost_local@localhost:5432/docpost_api';
export const LOCALSTACK = process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566';
/**
 * Dedicated bucket for worker integration tests. It has no S3 event notification, so
 * objects put here never reach the shared upload-events queue that dev workers poll.
 */
export const TEST_BUCKET = 'docpost-workers-it';

/** Environment every worker needs to talk to local infrastructure. */
export function useLocalInfraEnv(): void {
  process.env.DATABASE_URL = DATABASE_URL;
  delete process.env.DATABASE_SECRET_ARN;
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = LOCALSTACK;
  process.env.S3_BUCKET = TEST_BUCKET;
}

export function s3Client(): S3Client {
  return new S3Client({
    region: 'us-east-1',
    endpoint: LOCALSTACK,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

/** Creates the test bucket if it does not exist yet (idempotent). */
export async function ensureTestBucket(s3: S3Client): Promise<void> {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
  }
}

export function pgPool(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
}

export interface StubRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface StubServer {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

/** Starts an HTTP server on a random local port that records every request. */
export async function stubServer(
  respond: (req: StubRequest, res: ServerResponse) => void | Promise<void>,
): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: StubRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      requests.push(recorded);
      Promise.resolve(respond(recorded, res)).catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

/** An unsigned JWT-shaped token; the delivery worker only decodes `exp`. */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

// ---------- SQS ----------

export function sqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: LOCALSTACK,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

/**
 * Returns the URL of a dedicated test queue, creating it if needed (idempotent). Dev workers
 * poll the shared docpost-* queues, so tests never publish there. The 60s retention means
 * anything a test does not consume (e.g. delayed re-arm messages) expires on its own.
 */
export async function ensureTestQueue(sqs: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { MessageRetentionPeriod: '60' } }),
  );
  return QueueUrl!;
}

/**
 * Receives messages until `match` has accepted `expected` of them or `timeoutMs` passes.
 * Only matched messages (the ones this test produced) are deleted; others are left alone.
 */
export async function drainMatching(
  sqs: SQSClient,
  queueUrl: string,
  match: (body: Record<string, unknown>) => boolean,
  expected: number,
  timeoutMs = 4000,
): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && found.length < expected) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
    );
    for (const message of Messages) {
      const body = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
      if (!match(body)) {
        // Not ours: make it visible again right away instead of hiding it for 30s.
        await sqs.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: 0 }),
        );
        continue;
      }
      found.push(body);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
    }
  }
  return found;
}
