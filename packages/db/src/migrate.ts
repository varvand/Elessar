/**
 * Applies pending Drizzle migrations, then makes sure the extensions the schema
 * depends on exist.
 *
 * Extension creation is idempotent and runs *before* migrations: the Docker
 * init script only fires on a fresh volume, so anyone pointing Elessar at a
 * pre-existing Postgres would otherwise hit "type vector does not exist".
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createLogger } from '@elessar/core';
import { closeDatabase, createDatabase } from './client';

const log = createLogger({ module: 'migrate' });

async function main(): Promise<void> {
  const db = createDatabase({ max: 1 });
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

  try {
    for (const extension of ['vector', 'pg_trgm', 'btree_gin']) {
      await db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS ${extension}`));
    }
    log.info({ extensions: ['vector', 'pg_trgm', 'btree_gin'] }, 'extensions ready');

    await migrate(db, { migrationsFolder });
    log.info({ migrationsFolder }, 'migrations applied');
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : error }, 'migration failed');
    process.exitCode = 1;
  } finally {
    await closeDatabase(db);
  }
}

void main();
