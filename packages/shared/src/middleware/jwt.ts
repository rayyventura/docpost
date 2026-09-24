import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { UnauthorizedError } from '../errors.js';

export interface JwtPayload {
  sub: string;
  email?: string;
  scope?: string;
  token_use?: 'user' | 'service';
  exp: number;
  iat: number;
}

declare global {
  // Express augments Request through this namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Factory function that creates an auth middleware configured with a JWKS URL.
 * The JWKS is automatically cached by jose's createRemoteJWKSet.
 */
export function createAuthMiddleware(jwksUrl: string) {
  const JWKS = createRemoteJWKSet(new URL(jwksUrl));

  return async function authMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw new UnauthorizedError('Missing or invalid authorization header');
      }

      const token = authHeader.slice(7);
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: 'docpost-auth',
      });

      req.user = mapPayload(payload);
      next();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        next(err);
        return;
      }
      next(new UnauthorizedError('Invalid or expired token'));
    }
  };
}

function mapPayload(payload: JWTPayload): JwtPayload {
  return {
    sub: payload.sub ?? '',
    email: payload.email as string | undefined,
    scope: payload.scope as string | undefined,
    token_use: payload.token_use as 'user' | 'service' | undefined,
    exp: payload.exp ?? 0,
    iat: payload.iat ?? 0,
  };
}

/**
 * Convenience middleware that throws if req.user is not set.
 * Use after createAuthMiddleware or in routes that require authentication.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }
  next();
}
