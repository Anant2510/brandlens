import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
  resolve: {
    alias: [
      { find: /^@brandlens\/contracts$/, replacement: r('../../packages/contracts/src/index.ts') },
      { find: /^@brandlens\/db$/, replacement: r('../../packages/db/src/index.ts') },
      { find: /^@brandlens\/api\//, replacement: r('../api/src/') },
    ],
  },
});
