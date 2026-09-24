import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://localhost:3001',
      '/.well-known': 'http://localhost:3001',
      '/destinations': 'http://localhost:3003',
      '/jobs': 'http://localhost:3003',
      '/files': 'http://localhost:3003',
    },
  },
});
