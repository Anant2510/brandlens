import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@brandlens/contracts': r('../../packages/contracts/src/index.ts'),
      '@brandlens/db': r('../../packages/db/src/index.ts'),
    },
  },
});
