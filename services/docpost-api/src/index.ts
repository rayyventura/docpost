import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { errorHandler } from '@docpost/shared';
import destinationsRouter from './routes/destinations.js';
import jobsRouter from './routes/jobs.js';
import filesRouter from './routes/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT ?? 3003;

app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`DocPost API service listening on port ${PORT}`);
});

export { app };
