import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://elessar:elessar@localhost:5433/elessar',
  },
  // Extensions are created by infra/postgres/init, not by a migration, so
  // drizzle-kit must not try to manage them.
  extensionsFilters: ['postgis'],
  verbose: true,
  strict: true,
});
