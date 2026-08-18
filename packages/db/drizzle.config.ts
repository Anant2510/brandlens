import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '../../.env') });

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://brandlens:brandlens@localhost:5432/brandlens',
  },
  verbose: true,
  strict: false,
});
