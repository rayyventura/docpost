import express from 'express';
import type { Express } from 'express';
import { allowOptions, errorHandler } from '@docpost/shared';
import destinationsRouter from './routes/destinations.js';
import jobsRouter from './routes/jobs.js';
import filesRouter from './routes/files.js';

export function createApp(): Express {
  const app = express();

  app.use(allowOptions);
  app.use(express.json({ limit: '2mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Mount routes
  app.use(destinationsRouter);
  app.use(jobsRouter);
  app.use(filesRouter);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
