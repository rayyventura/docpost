import express from 'express';
import type { Express } from 'express';
import { errorHandler } from '@docpost/shared';
import teamsRouter from './routes/teams.js';
import bindersRouter from './routes/binders.js';
import contentsRouter from './routes/contents.js';
import membersRouter from './routes/members.js';
import documentsRouter from './routes/documents.js';

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Mount routes
  app.use(teamsRouter);
  app.use(bindersRouter);
  app.use(contentsRouter);
  app.use(membersRouter);
  app.use(documentsRouter);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
