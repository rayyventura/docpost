// Loads services/docpost-api/.env. Must be the first import of the entrypoint: ES module
// imports are evaluated in order before the importing module's body runs, and several
// modules (lib/s3, lib/sqs, middleware/auth, routes) read process.env at import time.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
