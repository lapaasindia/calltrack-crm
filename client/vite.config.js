import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Bake the root package.json version into the bundle as __APP_VERSION__ so the
// UI can show exactly which build is running (single source of truth — no drift).
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;

// Dev-server API proxy target. `CRM_API=http://localhost:3190 npx vite` points
// the dev client at a throwaway server instead of the office one.
const API_TARGET = process.env.CRM_API || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  server: {
    proxy: { '/api': API_TARGET },
  },
  build: {
    // Hidden source maps: written next to the assets for the host to keep, but
    // never referenced from the bundle (so nothing is served to browsers).
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run)[\\/]/.test(id)) return 'vendor-router';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
});
