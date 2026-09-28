import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors.js';

function isPayloadTooLarge(err: Error): boolean {
  return (
    err.name === 'PayloadTooLargeError' ||
    ('type' in err && (err as { type?: string }).type === 'entity.too.large') ||
    ('status' in err && (err as { status?: number }).status === 413)
  );
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

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
