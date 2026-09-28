// Must stay the first import: later modules read configuration at import time.
import './env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from './app.js';

const app = createApp();
const PORT = process.env.PORT ?? 3002;

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
