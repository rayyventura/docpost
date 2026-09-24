import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { errorHandler } from '@docpost/shared';
import teamsRouter from './routes/teams.js';
import bindersRouter from './routes/binders.js';
import contentsRouter from './routes/contents.js';
import membersRouter from './routes/members.js';
import documentsRouter from './routes/documents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT ?? 3002;

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

async function start(): Promise<void> {
  // Ensure uploads directory exists
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });

  app.listen(PORT, () => {
    console.log(`Platform service listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start platform service:', err);
  process.exit(1);
});

export { app };
