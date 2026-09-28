import './env.js';
import { createApp } from './app.js';

const app = createApp();
const PORT = process.env.PORT ?? 3003;

app.listen(PORT, () => {
  console.log(`DocPost API service listening on port ${PORT}`);
});

export { app };
