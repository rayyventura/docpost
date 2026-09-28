import { describe, expect, it } from 'vitest';
import { formatFailureReason } from './failureMessages';

const reason = (code: string, values: Record<string, string | number>) => `${code} ${JSON.stringify(values)}`;

describe('formatFailureReason', () => {
  describe('known codes keep friendly labels', () => {
    it('FILE_NOT_UPLOADED by deadline and missing', () => {
      expect(formatFailureReason(reason('FILE_NOT_UPLOADED', { fileName: 'a.pdf', reason: 'deadline' }))).toBe(
        'a.pdf was not uploaded before the staging deadline',
      );
      expect(formatFailureReason(reason('FILE_NOT_UPLOADED', { fileName: 'a.pdf', reason: 'missing' }))).toBe(
        'a.pdf was not found in staging',
      );
    });

    it('RETRIES_EXHAUSTED with and without the last error', () => {
      expect(
        formatFailureReason(reason('RETRIES_EXHAUSTED', { fileName: 'a.pdf', attemptCount: '3', reason: 'Platform returned 503' })),
      ).toBe('Document could not be delivered after repeated attempts. Platform returned 503');
      expect(formatFailureReason(reason('RETRIES_EXHAUSTED', { fileName: 'a.pdf' }))).toBe(
        'Document could not be delivered after repeated attempts. The delivery worker stopped after the maximum number of retries',
      );
    });

    it('NOT_AUTHORIZED_AT_DELIVERY without platform detail', () => {
      expect(formatFailureReason(reason('NOT_AUTHORIZED_AT_DELIVERY', { fileName: 'a.pdf' }))).toBe(
        'Document could not be delivered because access to that destination was removed',
      );
    });

    it('legacy "CODE: detail" reasons', () => {
      expect(formatFailureReason('FILE_NOT_UPLOADED: a.pdf was not uploaded before the staging deadline')).toBe(
        'a.pdf was not uploaded before the staging deadline',
      );
      expect(formatFailureReason('CHECKSUM_MISMATCH: a.pdf → Team / Binder')).toBe(
        'Document could not be delivered because the file checksum did not match',
      );
    });
  });

  describe('platform rejections show the underlying error', () => {
    it('shows a free-text platform rejection exactly as recorded', () => {
      const raw = 'Platform rejected the document (422 CHECKSUM_MISMATCH): Declared checksum does not match uploaded bytes';
      expect(formatFailureReason(raw)).toBe(raw);
    });

    it('appends the platform message to a known code', () => {
      expect(
        formatFailureReason(reason('CHECKSUM_MISMATCH', { fileName: 'a.pdf', reason: 'Declared checksum does not match' })),
      ).toBe('Document could not be delivered because the file checksum did not match. Declared checksum does not match');
    });

    it('appends status, platform code and message when recorded as fields', () => {
      expect(
        formatFailureReason(
          reason('INVALID_DESTINATION', { fileName: 'a.pdf', status: 422, code: 'FOLDER_ARCHIVED', message: 'Folder is archived' }),
        ),
      ).toBe('Document could not be delivered to that destination. Platform response: 422 FOLDER_ARCHIVED: Folder is archived');
      expect(
        formatFailureReason(
          reason('NOT_AUTHORIZED_AT_DELIVERY', { fileName: 'a.pdf', status: 403, platformCode: 'FORBIDDEN', message: 'Not a member' }),
        ),
      ).toBe(
        'Document could not be delivered because access to that destination was removed. Platform response: 403 FORBIDDEN: Not a member',
      );
    });

    it('never shows raw JSON for an unknown structured code, but keeps the platform detail', () => {
      expect(
        formatFailureReason(reason('PLATFORM_REJECTED', { fileName: 'a.pdf', status: 413, code: 'TOO_LARGE', message: 'File exceeds limit' })),
      ).toBe('Document could not be delivered. Platform response: 413 TOO_LARGE: File exceeds limit');
      expect(formatFailureReason(reason('SOMETHING_NEW', { fileName: 'a.pdf' }))).toBe(
        'Document could not be delivered (SOMETHING_NEW)',
      );
    });

    it('does not treat the FILE_NOT_UPLOADED select key as a platform message', () => {
      expect(formatFailureReason(reason('FILE_NOT_UPLOADED', { fileName: 'a.pdf', reason: 'missing' }))).not.toContain('Platform');
    });
  });

  it('shows anything unparseable as recorded', () => {
    expect(formatFailureReason('File record 123 not found')).toBe('File record 123 not found');
    expect(formatFailureReason('WEIRD {not json}')).toBe('WEIRD {not json}');
    expect(formatFailureReason('UNKNOWN_CODE: some detail')).toBe('UNKNOWN_CODE: some detail');
  });
});
