import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'extension/lib/*.test.js'],
    environment: 'node',
  },
});
