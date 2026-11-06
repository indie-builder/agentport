import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    projects: ['packages/web/vitest.config.ts'],
  },
});
