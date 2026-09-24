import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { UnauthorizedError, ForbiddenError } from '@docpost/shared';
import type { JwtPayload } from '@docpost/shared';

const AUTH_JWKS_URL = process.env.AUTH_JWKS_URL ?? 'http://localhost:3001/.well-known/jwks.json';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(AUTH_JWKS_URL));
  }
  return jwks;
}

function extractBearerToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or invalid authorization header');
  }
  return authHeader.slice(7);
}

async function validateJwt(token: string): Promise<JwtPayload> {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: 'docpost-auth',
      algorithms: ['RS256'],
    });

    const jwtPayload = payload as JWTPayload & {
      email?: string;
      scope?: string;
      token_use?: 'user' | 'service';
    };

    if (!jwtPayload.sub) {
      throw new UnauthorizedError('Token missing subject');
    }

    return {
      sub: jwtPayload.sub,
      email: jwtPayload.email,
      scope: jwtPayload.scope,
      token_use: jwtPayload.token_use,
      exp: jwtPayload.exp ?? 0,
      iat: jwtPayload.iat ?? 0,
    };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      throw err;
    }
    throw new UnauthorizedError('Invalid or expired token');
  }
}

export function requireUserAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);

  validateJwt(token)
    .then((payload) => {
      if (payload.token_use === 'service') {
        throw new ForbiddenError('Service tokens not allowed on this endpoint');
      }
      req.user = payload;
      next();
    })
    .catch(next);
}
