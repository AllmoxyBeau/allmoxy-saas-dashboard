import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { etlApiPlugin } from './vite-plugin-etl-api';

// https://vitejs.dev/config/
export default defineConfig({
  // etlApiPlugin: dev-only ETL admin API (POST /api/bid-only/toggle).
  // Production builds on Vercel ignore it because `apply: 'serve'` scopes
  // it to the dev server only.
  plugins: [react(), etlApiPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
