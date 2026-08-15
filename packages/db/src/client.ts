import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadEnv } from '@elessar/core';
import * as schema from './schema';

export type Database = ReturnType<typeof createDatabase>;

interface ClientOptions {
  /** Max pooled connections. The ingest worker wants few; the web app more. */
  max?: number;
  connectionString?: string;
}

/**
 * Build a connection pool. Prefer `getDatabase()` — this exists for scripts and
 * tests that need an isolated pool they can close deterministically.
 */
export function createDatabase(options: ClientOptions = {}) {
  const env = loadEnv();
  const sql = postgres(options.connectionString ?? env.DATABASE_URL, {
    max: options.max ?? 10,
    // Ingest inserts arrive in large batches; a long idle timeout avoids
    // reconnect churn between the 15-minute poll cycles.
    idle_timeout: 60,
    connect_timeout: 15,
    // `prepare: false` keeps us compatible with transaction-mode poolers
    // (pgbouncer, Supabase, Neon) that reject named prepared statements.
    prepare: false,
    onnotice: () => {},
  });

  return Object.assign(drizzle(sql, { schema, casing: 'snake_case' }), {
    /** Escape hatch for raw SQL (vector ops, window functions). */
    $client: sql,
  });
}

/**
 * Process-wide singleton. Cached on `globalThis` because Next.js dev-mode hot
 * reloading re-evaluates modules on every edit, and a fresh pool per reload
 * exhausts Postgres' connection limit within a few minutes of editing.
 */
const GLOBAL_KEY = Symbol.for('elessar.db');

interface GlobalWithDb {
  [GLOBAL_KEY]?: Database;
}

export function getDatabase(): Database {
  const g = globalThis as GlobalWithDb;
  g[GLOBAL_KEY] ??= createDatabase();
  return g[GLOBAL_KEY];
}

export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end({ timeout: 5 });
}

/** Serialize an embedding for a pgvector column. */
export function toVector(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

/** Parse a pgvector column value back into numbers. */
export function fromVector(value: string | number[] | null): number[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1);
  if (inner === '') return [];
  return inner.split(',').map((n) => Number.parseFloat(n));
}
