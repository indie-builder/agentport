import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  envDir: false,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'web',
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost' } },
    include: ['packages/web/test/**/*.test.ts'],
    setupFiles: ['packages/web/test/setup.ts'],
    testTimeout: 20_000,
  },
});
