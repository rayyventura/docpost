import { IntlMessageFormat } from 'intl-messageformat';

// Friendly wording for failure codes the pipeline records. Stored reasons look like
// `CODE {"fileName": ..., ...}` (structured), `CODE: detail` (legacy), or free text
// such as "Platform rejected the document (422 CHECKSUM_MISMATCH): ...", which is shown
// as recorded so the user sees the platform's own explanation.
const messages: Record<string, string> = {
  FILE_NOT_UPLOADED:
    '{reason, select, deadline {{fileName} was not uploaded before the staging deadline} missing {{fileName} was not found in staging} other {{fileName} was not uploaded}}',
  NOT_AUTHORIZED_AT_DELIVERY:
    'Document could not be delivered because access to that destination was removed',
  CHECKSUM_MISMATCH:
    'Document could not be delivered because the file checksum did not match',
  SIZE_MISMATCH:
    'Document could not be delivered because the uploaded size was {actualSize} bytes instead of {declaredSize}',
  INVALID_DESTINATION:
    'Document could not be delivered to that destination',
  RETRIES_EXHAUSTED:
    'Document could not be delivered after repeated attempts. {reason}',
};

// Templates that already render `reason` themselves (as text or as a select key).
const CONSUMES_REASON = new Set(['FILE_NOT_UPLOADED', 'RETRIES_EXHAUSTED']);

type Values = Record<string, string | number>;

export function formatFailureReason(raw: string): string {
  const parsed = parseFailureReason(raw);
  if (!parsed.code) return raw;

  if (parsed.code === 'RETRIES_EXHAUSTED' && !parsed.values.reason) {
    parsed.values.reason = 'The delivery worker stopped after the maximum number of retries';
  }

  const detail = underlyingError(parsed.code, parsed.values);
  const template = messages[parsed.code];
  if (!template) {
    // Unknown code: never show raw JSON, but always keep the underlying error.
    if (!parsed.structured) return raw;
    return detail ? `Document could not be delivered. ${detail}` : `Document could not be delivered (${parsed.code})`;
  }

  let friendly: string;
  try {
    friendly = new IntlMessageFormat(template, 'en').format(parsed.values) as string;
  } catch {
    return raw;
  }
  return detail ? `${friendly}. ${detail}` : friendly;
}

/**
 * The platform's own explanation (HTTP status, error code, message) when the stored
 * reason carries one, e.g. "Platform response: 422 CHECKSUM_MISMATCH: Declared
 * checksum does not match".
 */
function underlyingError(code: string, values: Values): string {
  const text = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim()) ? String(v).trim() : '');
  const status = text(values.status ?? values.httpStatus);
  const errorCode = text(values.platformCode ?? values.errorCode ?? (values.code !== code ? values.code : ''));
  const message = text(values.message ?? values.platformMessage ?? (CONSUMES_REASON.has(code) ? '' : values.reason));

  const head = [status, errorCode].filter(Boolean).join(' ');
  if (!head && !message) return '';
  if (!head) return message;
  return `Platform response: ${head}${message ? `: ${message}` : ''}`;
}

function parseFailureReason(raw: string): { code: string; values: Values; structured: boolean } {
  const structured = raw.match(/^([A-Z_]+) (\{.*\})$/s);
  if (structured) {
    try {
      const values = JSON.parse(structured[2]) as Values;
      if (values && typeof values === 'object') return { code: structured[1], values, structured: true };
    } catch {
      // Not JSON after all; fall through and show it as recorded.
    }
    return { code: '', values: {}, structured: false };
  }

  const legacy = raw.match(/^([A-Z_]+): (.*)$/s);
  if (!legacy) return { code: '', values: {}, structured: false };

  const code = legacy[1];
  const detail = legacy[2];
  if (!messages[code]) return { code: '', values: {}, structured: false };

  if (code === 'FILE_NOT_UPLOADED' && detail.includes('staging deadline')) {
    return {
      code,
      values: { fileName: detail.replace(/ was not uploaded before the staging deadline$/, ''), reason: 'deadline' },
      structured: false,
    };
  }
  if (code === 'FILE_NOT_UPLOADED' && detail.includes('not found in staging')) {
    return {
      code,
      values: { fileName: detail.replace(/ not found in staging$/, ''), reason: 'missing' },
      structured: false,
    };
  }

  const arrow = detail.split(' → ')[0];
  const values: Values = { fileName: arrow };
  if (code === 'FILE_NOT_UPLOADED') values.reason = 'other';
  return { code, values, structured: false };
}
