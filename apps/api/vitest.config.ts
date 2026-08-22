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
    // Ordered: the subpath pattern has to be tried before the bare-name one,
    // or `@brandlens/db/seed/rule-packs` resolves to the package index and
    // then fails to find the export.
    alias: [
      { find: /^@brandlens\/contracts$/, replacement: r('../../packages/contracts/src/index.ts') },
      { find: /^@brandlens\/db\/seed\//, replacement: r('../../packages/db/src/seed/steps/') },
      { find: /^@brandlens\/db$/, replacement: r('../../packages/db/src/index.ts') },
    ],
  },
});
