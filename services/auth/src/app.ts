import express from 'express';
import type { Express } from 'express';
import { allowOptions, errorHandler } from '@docpost/shared';
import registerRouter from './routes/register.js';
import loginRouter from './routes/login.js';
import refreshRouter from './routes/refresh.js';
import passwordResetRouter from './routes/password-reset.js';
import tokenRouter from './routes/token.js';
import jwksRouter from './routes/jwks.js';

export function createApp(): Express {
  const app = express();

  app.use(allowOptions);
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Mount routes
  app.use(registerRouter);
  app.use(loginRouter);
  app.use(refreshRouter);
  app.use(passwordResetRouter);
  app.use(tokenRouter);
  app.use(jwksRouter);

  // Error handler (must be after routes)
  app.use(errorHandler);

  return app;
}
