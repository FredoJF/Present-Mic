import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: {
    // `generate` can run in environments where DATABASE_URL is absent, so
    // keep a safe SQLite fallback instead of throwing during config load.
    url: process.env.DATABASE_URL ?? 'file:./dev.db'
  }
});
