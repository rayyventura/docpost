import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '@docpost/shared';

/**
 * Stand-in for requireUserAuth in unit tests. A bearer token of the form
 * `user:<uuid>` authenticates as that user; `service:<id>` is a service token;
 * anything else is rejected the same way the real middleware rejects it.
 */
export function fakeRequireUserAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing or invalid authorization header'));
    return;
  }
  const token = header.slice(7);
  if (token.startsWith('service:')) {
    next(new ForbiddenError('Service tokens not allowed on this endpoint'));
    return;
  }
  if (!token.startsWith('user:')) {
    next(new UnauthorizedError('Invalid or expired token'));
    return;
  }
  req.user = { sub: token.slice(5), name: 'Test User', email: 'test@example.com', exp: 0, iat: 0 };
  next();
}

export const userToken = (userId: string): string => `user:${userId}`;
