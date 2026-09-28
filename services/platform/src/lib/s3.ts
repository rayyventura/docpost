import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

const BUCKET = process.env.S3_BUCKET ?? 'docpost-staging-local';

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.S3_ENDPOINT && {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  }),
});

export function usesObjectStorage(): boolean {
  return Boolean(process.env.S3_BUCKET || process.env.S3_ENDPOINT);
}

export function documentObjectKey(documentId: string): string {
  return `documents/${documentId}`;
}

export async function putDocumentObject(
  documentId: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: documentObjectKey(documentId),
      Body: body,
      ContentType: contentType,
    }),
  );
}

function isMissingObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = String((err as { name?: string }).name ?? '');
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}

export async function getDocumentObjectStream(documentId: string): Promise<Readable | null> {
  try {
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: documentObjectKey(documentId),
      }),
    );
    if (!obj.Body) return null;
    if (obj.Body instanceof Readable) return obj.Body;
    const web = obj.Body.transformToWebStream();
    return Readable.fromWeb(web as import('node:stream/web').ReadableStream);
  } catch (err) {
    if (isMissingObject(err)) return null;
    throw err;
  }
}
