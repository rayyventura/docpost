import { createHash } from 'node:crypto';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError, NotFoundError } from '@docpost/shared';

const BUCKET = process.env.S3_BUCKET ?? 'docpost-staging-local';
const DOWNLOAD_EXPIRY = 120;

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

export function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function isMissingObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = String((err as { name?: string }).name ?? '');
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}

export interface StagingObjectInfo {
  contentLength: number;
  checksumSha256Base64?: string;
  checksumType?: string;
}

export async function headStagingObject(s3Key: string): Promise<StagingObjectInfo> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        ChecksumMode: 'ENABLED',
      }),
    );
    return {
      contentLength: head.ContentLength ?? 0,
      checksumSha256Base64: head.ChecksumSHA256,
      checksumType: head.ChecksumType,
    };
  } catch (err) {
    if (isMissingObject(err)) {
      throw new NotFoundError('Source object was not found');
    }
    throw err;
  }
}

export async function copyStagingObjectToDocument(
  sourceKey: string,
  documentId: string,
  contentType: string,
): Promise<void> {
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: copySource(BUCKET, sourceKey),
        Key: documentObjectKey(documentId),
        ContentType: contentType,
        MetadataDirective: 'REPLACE',
      }),
    );
  } catch (err) {
    if (isMissingObject(err)) {
      throw new NotFoundError('Source object was not found');
    }
    throw err;
  }
}

export function hexSha256ToBase64(hex: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex').toString('base64');
}

function checksumMismatch(checksumSha256: string): AppError {
  return new AppError('CHECKSUM_MISMATCH', `Declared checksum does not match. Expected ${checksumSha256}`, 422);
}

/**
 * SHA-256 (hex) of a staged object, computed by streaming GetObject so memory use
 * stays flat regardless of object size.
 */
export async function sha256OfStagingObject(s3Key: string): Promise<string> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    if (!res.Body) {
      throw new NotFoundError('Source object was not found');
    }
    const hash = createHash('sha256');
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch (err) {
    if (isMissingObject(err)) {
      throw new NotFoundError('Source object was not found');
    }
    throw err;
  }
}

/**
 * Rejects with 422 CHECKSUM_MISMATCH unless the staged object has the declared size
 * and SHA-256. Size is checked first from the HEAD response. The checksum uses the
 * full-object SHA-256 S3 reports when there is one; otherwise (multipart COMPOSITE
 * checksums, or no checksum reported) the object is streamed and hashed.
 */
export async function assertObjectMatchesIngest(
  s3Key: string,
  info: StagingObjectInfo,
  sizeBytes: number,
  checksumSha256: string,
): Promise<void> {
  if (info.contentLength !== sizeBytes) {
    throw new AppError(
      'CHECKSUM_MISMATCH',
      `Declared size does not match. Expected ${sizeBytes}, got ${info.contentLength}`,
      422,
    );
  }

  const declared = hexSha256ToBase64(checksumSha256);
  if (!declared) {
    // Not a SHA-256 hex digest, so it cannot match any object.
    throw checksumMismatch(checksumSha256);
  }

  if (info.checksumSha256Base64 && info.checksumType === 'FULL_OBJECT') {
    if (info.checksumSha256Base64.replace(/"/g, '') !== declared) {
      throw checksumMismatch(checksumSha256);
    }
    return;
  }

  const actual = await sha256OfStagingObject(s3Key);
  if (actual !== checksumSha256.toLowerCase()) {
    throw checksumMismatch(checksumSha256);
  }
}

export async function presignDocumentDownload(
  documentId: string,
  filename: string,
  contentType: string,
): Promise<string> {
  const safe = filename.replace(/["\r\n]/g, '');
  const encoded = encodeURIComponent(safe);
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: documentObjectKey(documentId),
    ResponseContentType: contentType,
    ResponseContentDisposition: `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`,
  });
  return getSignedUrl(s3, command, { expiresIn: DOWNLOAD_EXPIRY });
}
