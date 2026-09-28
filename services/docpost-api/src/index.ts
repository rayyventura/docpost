import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = createApp();
const PORT = process.env.PORT ?? 3003;

app.listen(PORT, () => {
  console.log(`DocPost API service listening on port ${PORT}`);
});

export { app };
