import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Bake the root package.json version into the bundle as __APP_VERSION__ so the
// UI can show exactly which build is running (single source of truth — no drift).
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
