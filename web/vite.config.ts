import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const backend = 'http://localhost:8787';
const proxied = ['/api', '/mcp', '/f', '/u', '/authorize', '/token', '/register', '/.well-known'];

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: backend, changeOrigin: false }])),
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
