import { IntlMessageFormat } from 'intl-messageformat';

const messages: Record<string, string> = {
  FILE_NOT_UPLOADED:
    '{reason, select, deadline {{fileName} was not uploaded before the staging deadline} missing {{fileName} was not found in staging} other {{fileName} was not uploaded}}',
  NOT_AUTHORIZED_AT_DELIVERY:
    '{fileName} could not be delivered because access to that destination was removed',
  CHECKSUM_MISMATCH:
    '{fileName} could not be delivered because the file checksum did not match',
  SIZE_MISMATCH:
    '{fileName} could not be delivered because the uploaded size was {actualSize} bytes instead of {declaredSize}',
  RETRIES_EXHAUSTED:
    '{fileName} could not be delivered after repeated attempts',
};

export function formatFailureReason(raw: string): string {
  const parsed = parseFailureReason(raw);
  const template = messages[parsed.code];
  if (!template) return raw;

  try {
    return new IntlMessageFormat(template, 'en').format(parsed.values) as string;
  } catch {
    return raw;
  }
}

function parseFailureReason(raw: string): { code: string; values: Record<string, string | number> } {
  const structured = raw.match(/^([A-Z_]+) (\{.*\})$/);
  if (structured) {
    const values = JSON.parse(structured[2]) as Record<string, string | number>;
    return { code: structured[1], values };
  }

  const legacy = raw.match(/^([A-Z_]+): (.*)$/);
  if (!legacy) return { code: '', values: {} };

  const code = legacy[1];
  const detail = legacy[2];
  if (code === 'FILE_NOT_UPLOADED' && detail.includes('staging deadline')) {
    return {
      code,
      values: { fileName: detail.replace(/ was not uploaded before the staging deadline$/, ''), reason: 'deadline' },
    };
  }
  if (code === 'FILE_NOT_UPLOADED' && detail.includes('not found in staging')) {
    return {
      code,
      values: { fileName: detail.replace(/ not found in staging$/, ''), reason: 'missing' },
    };
  }

  const arrow = detail.split(' → ')[0];
  return { code, values: { fileName: arrow, reason: 'other' } };
}
