import { S3Client, PutObjectCommand, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = process.env.S3_BUCKET ?? 'docpost-staging-local';
const EXPIRY = parseInt(process.env.UPLOAD_URL_EXPIRY_SECONDS ?? '900', 10);
const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MB
const PART_SIZE = 16 * 1024 * 1024; // 16 MB

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.S3_ENDPOINT && {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  }),
});

export { s3, BUCKET };

const DOWNLOAD_EXPIRY = 120;

export async function presignDownload(s3Key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
  });
  return getSignedUrl(s3, command, { expiresIn: DOWNLOAD_EXPIRY });
}

export interface SingleUploadPlan {
  fileId: string;
  presignedUrl: string;
  fields: { key: string; contentType: string; checksumSha256: string };
}

export interface MultipartUploadPlan {
  fileId: string;
  multipart: true;
  partSize: number;
  partCount: number;
}

export type UploadPlan = SingleUploadPlan | MultipartUploadPlan;

export async function generateUploadPlan(
  fileId: string,
  s3Key: string,
  contentType: string,
  checksumSha256: string,
  sizeBytes: number,
): Promise<UploadPlan> {
  if (sizeBytes > MULTIPART_THRESHOLD) {
    const partCount = Math.ceil(sizeBytes / PART_SIZE);
    return { fileId, multipart: true, partSize: PART_SIZE, partCount };
  }

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    ContentType: contentType,
    ContentLength: sizeBytes,
  });

  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: EXPIRY });

  return {
    fileId,
    presignedUrl,
    fields: { key: s3Key, contentType, checksumSha256 },
  };
}

export async function initiateMultipartUpload(
  s3Key: string,
  contentType: string,
  sizeBytes: number,
): Promise<{ uploadId: string; parts: { partNumber: number; url: string }[]; completeUrl: string; abortUrl: string }> {
  const createCmd = new CreateMultipartUploadCommand({
    Bucket: BUCKET,
    Key: s3Key,
    ContentType: contentType,
  });

  const { UploadId } = await s3.send(createCmd);
  if (!UploadId) throw new Error('Failed to initiate multipart upload');

  const partCount = Math.ceil(sizeBytes / PART_SIZE);
  return generateMultipartUrls(s3Key, UploadId, partCount, sizeBytes);
}

export async function resignMultipartParts(
  s3Key: string,
  uploadId: string,
  partNumbers: number[],
  sizeBytes: number,
): Promise<{ uploadId: string; parts: { partNumber: number; url: string }[]; completeUrl: string; abortUrl: string }> {
  const partCount = Math.ceil(sizeBytes / PART_SIZE);
  const parts: { partNumber: number; url: string }[] = [];

  for (const partNumber of partNumbers) {
    const isLast = partNumber === partCount;
    const partSize = isLast ? sizeBytes - (partCount - 1) * PART_SIZE : PART_SIZE;

    const cmd = new UploadPartCommand({
      Bucket: BUCKET,
      Key: s3Key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: partSize,
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: EXPIRY });
    parts.push({ partNumber, url });
  }

  const completeCmd = new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: s3Key,
    UploadId: uploadId,
  });
  const completeUrl = await getSignedUrl(s3, completeCmd, { expiresIn: EXPIRY });

  const abortCmd = new AbortMultipartUploadCommand({
    Bucket: BUCKET,
    Key: s3Key,
    UploadId: uploadId,
  });
  const abortUrl = await getSignedUrl(s3, abortCmd, { expiresIn: EXPIRY });

  return { uploadId, parts, completeUrl, abortUrl };
}

async function generateMultipartUrls(
  s3Key: string,
  uploadId: string,
  partCount: number,
  sizeBytes: number,
): Promise<{ uploadId: string; parts: { partNumber: number; url: string }[]; completeUrl: string; abortUrl: string }> {
  const allPartNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
  return resignMultipartParts(s3Key, uploadId, allPartNumbers, sizeBytes);
}
