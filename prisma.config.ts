import { defineConfig } from 'prisma/config';

// Prisma CLI does not load .env automatically. Load it when present; real
// deployments inject environment variables directly.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Optional so that `prisma generate` works without a database (CI, Docker build).
    url: process.env['DATABASE_URL'],
  },
});
