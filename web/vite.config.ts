import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const backend = 'http://localhost:8787';
const page = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);
const proxied = ['/api', '/mcp', '/f', '/u', '/authorize', '/token', '/register', '/.well-known'];

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      // SPA first; static landing pages (ja / en / zh) share landing/landing.css.
      input: {
        main: page('./index.html'),
        landing: page('./landing/index.html'),
        en: page('./en/index.html'),
        zh: page('./zh/index.html'),
      },
    },
  },
  server: {
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: backend, changeOrigin: false }])),
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
