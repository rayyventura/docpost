import { beforeAll, describe, expect, it } from 'vitest';

// Presigning is local HMAC signing; it only needs credentials, never the network.
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const MB = 1024 * 1024;
const MULTIPART_THRESHOLD = 100 * MB;
const PART_SIZE = 16 * MB;

let s3: typeof import('./s3.js');

beforeAll(async () => {
  s3 = await import('./s3.js');
});

describe('generateUploadPlan', () => {
  it('returns a single-request plan for a file at exactly 100 MB', async () => {
    const plan = await s3.generateUploadPlan('file-1', 'uploads/j/f/a.pdf', 'application/pdf', 'sha', MULTIPART_THRESHOLD);
    expect(plan).not.toHaveProperty('multipart');
    expect(plan).toMatchObject({
      fileId: 'file-1',
      fields: { key: 'uploads/j/f/a.pdf', contentType: 'application/pdf', checksumSha256: 'sha' },
    });
  });

  it('returns a lazy multipart hint (no URLs, no S3 call) for files over 100 MB', async () => {
    const plan = await s3.generateUploadPlan('file-2', 'uploads/j/f/big.pdf', 'application/pdf', 'sha', MULTIPART_THRESHOLD + 1);
    expect(plan).toEqual({ fileId: 'file-2', multipart: true, partSize: PART_SIZE, partCount: 7 });
  });

  it('sizes the multipart plan for the 1 GB ceiling as 64 parts', async () => {
    const plan = await s3.generateUploadPlan('file-3', 'k', 'application/pdf', 'sha', 1024 * MB);
    expect(plan).toMatchObject({ multipart: true, partCount: 64 });
  });

  it('signs a single-object upload URL that expires in 15 minutes (ADR-004)', async () => {
    const plan = await s3.generateUploadPlan('file-4', 'uploads/j/f/a.pdf', 'application/pdf', 'sha', 12);
    if (!('presignedUrl' in plan)) throw new Error('expected single-request plan');
    const url = new URL(plan.presignedUrl);
    expect(url.host + url.pathname).toContain(s3.BUCKET);
    expect(url.pathname.endsWith('/uploads/j/f/a.pdf')).toBe(true);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    // Declared size is bound into the signature.
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length');
  });

  // BUG: blueprint "Upload URL issuance rules" require a presigned POST whose policy
  // carries content-length-range, an exact Content-Type condition and an
  // x-amz-checksum-sha256 condition. The implementation signs a PutObject URL instead:
  // Content-Type is not a signed header and the declared SHA-256 is only echoed back
  // in `fields`, so S3 does not enforce either.
  it.fails('issues a presigned POST whose policy enforces content-type and sha256 (blueprint)', async () => {
    const plan = await s3.generateUploadPlan('file-5', 'uploads/j/f/a.pdf', 'application/pdf', 'c2hh', 12);
    if (!('presignedUrl' in plan)) throw new Error('expected single-request plan');
    const fields = plan.fields as Record<string, string>;
    expect(fields.Policy ?? fields.policy).toBeDefined();
    const policy = JSON.parse(Buffer.from(fields.Policy ?? fields.policy, 'base64').toString()) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 12]);
    expect(policy.conditions).toContainEqual({ 'Content-Type': 'application/pdf' });
    expect(policy.conditions).toContainEqual({ 'x-amz-checksum-sha256': 'c2hh' });
  });

  // BUG: the SDK's default flexible checksums compute a CRC32 of the *empty* command
  // body at signing time and bake it into the URL (x-amz-checksum-crc32=AAAAAA==).
  // Any real upload through that URL is then rejected by S3 (reproduced against
  // LocalStack in jobs.integration.test.ts).
  it.fails('does not pin a checksum of an empty body into the upload URL', async () => {
    const plan = await s3.generateUploadPlan('file-6', 'uploads/j/f/a.pdf', 'application/pdf', 'sha', 12);
    if (!('presignedUrl' in plan)) throw new Error('expected single-request plan');
    expect(new URL(plan.presignedUrl).searchParams.get('x-amz-checksum-crc32')).toBeNull();
  });
});

describe('presignDownload', () => {
  it('signs a GET for the single object that expires in 2 minutes (ADR-004)', async () => {
    const url = new URL(await s3.presignDownload('uploads/j/f/report.pdf'));
    expect(url.host + url.pathname).toContain(s3.BUCKET);
    expect(url.pathname.endsWith('/uploads/j/f/report.pdf')).toBe(true);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('x-id')).toBe('GetObject');
  });
});

describe('resignMultipartParts', () => {
  it('re-signs only the requested parts plus fresh complete/abort URLs', async () => {
    const size = 40 * MB; // 3 parts: 16 + 16 + 8
    const result = await s3.resignMultipartParts('uploads/j/f/big.pdf', 'upload-123', [2, 3], size);

    expect(result.uploadId).toBe('upload-123');
    expect(result.parts.map((p) => p.partNumber)).toEqual([2, 3]);
    for (const part of result.parts) {
      const url = new URL(part.url);
      expect(url.searchParams.get('uploadId')).toBe('upload-123');
      expect(url.searchParams.get('partNumber')).toBe(String(part.partNumber));
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    }
    const complete = new URL(result.completeUrl);
    expect(complete.searchParams.get('uploadId')).toBe('upload-123');
    expect(complete.searchParams.get('partNumber')).toBeNull();
    const abort = new URL(result.abortUrl);
    expect(abort.searchParams.get('uploadId')).toBe('upload-123');
    expect(abort.searchParams.get('x-id')).toBe('AbortMultipartUpload');
  });

  // BUG: same empty-body CRC32 problem as the single-request plan; part uploads are
  // rejected by S3 with "Checksum Type mismatch".
  it.fails('does not pin a checksum into part upload URLs', async () => {
    const result = await s3.resignMultipartParts('k', 'upload-123', [1], 20 * MB);
    const url = new URL(result.parts[0].url);
    expect(url.searchParams.get('x-amz-checksum-crc32')).toBeNull();
    expect(url.searchParams.get('x-amz-sdk-checksum-algorithm')).toBeNull();
  });
});
