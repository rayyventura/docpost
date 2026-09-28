import { FOLDER_DESTINATION_REQUIRED, ValidationError } from '@docpost/shared';
import { isUuid } from './ids.js';

export interface IngestRequest {
  taskId: string;
  binderId: string;
  folderId: string;
  name: string;
  contentType: string;
  checksumSha256: string;
  onBehalfOf: string;
  s3Key: string;
  sizeBytes: number;
}

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
]);

export { ALLOWED_CONTENT_TYPES };

export function assertStagingObjectKey(s3Key: string): void {
  if (!s3Key.startsWith('uploads/') || s3Key.includes('..') || s3Key.includes('\\') || s3Key.includes('\0')) {
    throw new ValidationError('Invalid source object key');
  }
}

export function parseIngestBody(raw: unknown): IngestRequest {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('Request body must be a JSON object');
  }

  const body = raw as Record<string, unknown>;
  const { taskId, binderId, folderId, name, contentType, checksumSha256, onBehalfOf, s3Key, sizeBytes } = body;

  if (
    typeof taskId !== 'string' ||
    typeof binderId !== 'string' ||
    typeof name !== 'string' ||
    typeof contentType !== 'string' ||
    typeof checksumSha256 !== 'string' ||
    typeof onBehalfOf !== 'string' ||
    typeof s3Key !== 'string'
  ) {
    throw new ValidationError(
      'body must include taskId, binderId, name, contentType, checksumSha256, onBehalfOf, s3Key as strings',
    );
  }

  if (typeof folderId !== 'string' || folderId.length === 0) {
    throw new ValidationError(FOLDER_DESTINATION_REQUIRED);
  }

  // Rejected here (422, non-retryable) rather than reaching Postgres as a malformed uuid.
  for (const [field, value] of [
    ['taskId', taskId],
    ['binderId', binderId],
    ['folderId', folderId],
    ['onBehalfOf', onBehalfOf],
  ] as const) {
    if (!isUuid(value)) {
      throw new ValidationError(`${field} must be a UUID`);
    }
  }

  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isInteger(sizeBytes)) {
    throw new ValidationError('sizeBytes must be a positive integer');
  }

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError(
      `Unsupported content type: ${contentType}. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
    );
  }

  assertStagingObjectKey(s3Key);

  return {
    taskId,
    binderId,
    folderId,
    name,
    contentType,
    checksumSha256,
    onBehalfOf,
    s3Key,
    sizeBytes,
  };
}
