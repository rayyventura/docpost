import { Router, Request, Response, NextFunction } from 'express';
import { requireUserAuth } from '../middleware/auth.js';

const router = Router();

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:3002';
const PROXY_TIMEOUT_MS = 5_000;

async function proxyToPlatform(
  platformPath: string,
  authorizationHeader: string,
): Promise<{ status: number; body: unknown }> {
  const url = `${PLATFORM_URL}${platformPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authorizationHeader,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    const body: unknown = await response.json();

    if (response.status >= 500) {
      return {
        status: 502,
        body: { error: { code: 'UPSTREAM_ERROR', message: 'Platform service unavailable' } },
      };
    }

    return { status: response.status, body };
  } catch {
    clearTimeout(timer);
    return {
      status: 502,
      body: { error: { code: 'UPSTREAM_ERROR', message: 'Platform service unavailable' } },
    };
  }
}

// All routes require user authentication
router.use(requireUserAuth);

// GET /destinations/teams
router.get('/destinations/teams', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authorization = req.headers.authorization;
    if (!authorization) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization' } });
      return;
    }

    const { status, body } = await proxyToPlatform('/teams?docPostEnabled=true', authorization);
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

// GET /destinations/teams/:id/binders
router.get(
  '/destinations/teams/:id/binders',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authorization = req.headers.authorization;
      if (!authorization) {
        res
          .status(401)
          .json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization' } });
        return;
      }

      const { status, body } = await proxyToPlatform(
        `/teams/${req.params.id}/binders`,
        authorization,
      );
      res.status(status).json(body);
    } catch (err) {
      next(err);
    }
  },
);

// GET /destinations/binders/:id/contents
router.get(
  '/destinations/binders/:id/contents',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authorization = req.headers.authorization;
      if (!authorization) {
        res
          .status(401)
          .json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization' } });
        return;
      }

      const { status, body } = await proxyToPlatform(
        `/binders/${req.params.id}/contents`,
        authorization,
      );
      res.status(status).json(body);
    } catch (err) {
      next(err);
    }
  },
);

// GET /destinations/folders/:id/contents
router.get(
  '/destinations/folders/:id/contents',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authorization = req.headers.authorization;
      if (!authorization) {
        res
          .status(401)
          .json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization' } });
        return;
      }

      const { status, body } = await proxyToPlatform(
        `/folders/${req.params.id}/contents`,
        authorization,
      );
      res.status(status).json(body);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
