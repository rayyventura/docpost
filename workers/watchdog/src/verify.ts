import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';

/**
 * Outcome of checking a staged object against the size declared at submit.
 * The fan-out worker keeps an identical copy of this check (workers/fanout/src/verify.ts)
 * so both promotion paths accept and reject exactly the same uploads.
 */
export type Verification =
  | { status: 'verified'; actualSize: number }
  | { status: 'missing'; error: unknown }
  | { status: 'rejected'; reason: string };

export async function verifyStagedObject(
  s3: S3Client,
  bucket: string,
  file: { s3Key: string; sizeBytes: bigint | number | string; originalName: string },
): Promise<Verification> {
  let actualSize: number;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: file.s3Key }));
    actualSize = head.ContentLength ?? 0;
  } catch (error) {
    return { status: 'missing', error };
  }

  const declaredSize = Number(file.sizeBytes);
  if (actualSize !== declaredSize) {
    return {
      status: 'rejected',
      reason: `SIZE_MISMATCH ${JSON.stringify({ fileName: file.originalName, declaredSize, actualSize })}`,
    };
  }
  return { status: 'verified', actualSize };
}
