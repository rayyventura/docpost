import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { errorHandler } from '@docpost/shared';
import { initKeys, getKid } from './crypto/keys.js';
import registerRouter from './routes/register.js';
import loginRouter from './routes/login.js';
import tokenRouter from './routes/token.js';
import jwksRouter from './routes/jwks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Mount routes
app.use(registerRouter);
app.use(loginRouter);
app.use(tokenRouter);
app.use(jwksRouter);

// Error handler (must be after routes)
app.use(errorHandler);

async function start() {
  // Initialize RSA key pair
  await initKeys();
  console.log(`JWT signing key initialized (kid: ${getKid()})`);

  app.listen(PORT, () => {
    console.log(`Auth service listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start auth service:', err);
  process.exit(1);
});
