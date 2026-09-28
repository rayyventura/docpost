/**
 * Loads services/platform/.env into process.env.
 *
 * Imported first by the entrypoint so values are in place before any module that
 * reads configuration at import time (lib/s3.ts, middleware/auth.ts). dotenv never
 * overrides variables already set in the real environment.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
