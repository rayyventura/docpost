import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors.js';

function isPayloadTooLarge(err: Error): boolean {
  return (
    err.name === 'PayloadTooLargeError' ||
    ('type' in err && (err as { type?: string }).type === 'entity.too.large') ||
    ('status' in err && (err as { status?: number }).status === 413)
  );
}

// body-parser (via express.json()) raises http-errors carrying a `type` such as
// 'entity.parse.failed' and a 4xx `status`/`statusCode` with `expose: true`. These are client
// mistakes, not server faults: answer 400 and do not log them as unhandled errors. Errors from other
// libraries that merely carry a status code are left alone so real faults still surface as 500s.
function isMalformedJson(err: Error): boolean {
  return (err as { type?: unknown }).type === 'entity.parse.failed';
}

function isRequestClientError(err: Error): boolean {
  const { status, statusCode, type, expose } = err as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
    expose?: unknown;
  };
  const code = typeof status === 'number' ? status : statusCode;
  const is4xx = typeof code === 'number' && code >= 400 && code < 500;
  return is4xx && (typeof type === 'string' || expose === true);
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  if (isPayloadTooLarge(err)) {
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'This send is too large. Use fewer files or destinations, or try again.',
      },
    });
    return;
  }

  if (isMalformedJson(err)) {
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON',
      },
    });
    return;
  }

  if (isRequestClientError(err)) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'The request could not be processed',
      },
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
