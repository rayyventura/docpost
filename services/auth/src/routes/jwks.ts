import { Router, Request, Response, NextFunction } from 'express';
import { getJwks } from '../crypto/keys.js';

const router = Router();

router.get('/.well-known/jwks.json', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const jwks = await getJwks();
    res.status(200).json(jwks);
  } catch (err) {
    next(err);
  }
});

router.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
  const baseUrl = process.env.AUTH_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
  res.status(200).json({
    issuer: 'docpost-auth',
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
  });
});

export default router;
