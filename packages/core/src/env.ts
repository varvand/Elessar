import { z } from 'zod';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Configuration is parsed once, eagerly, and fails loudly. A situational
 * awareness system that silently runs with a missing DATABASE_URL and shows an
 * empty globe is worse than one that refuses to start.
 */

/**
 * Load the repo-root `.env` if one exists.
 *
 * Walks upward from the current working directory, because every workspace
 * package runs with its own directory as cwd but shares one `.env` at the root.
 * Uses Node's built-in env-file loader rather than a dotenv dependency.
 *
 * Real environment variables always win: `loadEnvFile` does not overwrite
 * existing keys, which is what makes this safe in production and in CI where
 * config arrives through the actual environment.
 */
function loadDotEnvFile(): void {
  // Next.js loads .env itself and sets this; loading again would be redundant.
  if (process.env.ELESSAR_SKIP_DOTENV === '1') return;

  let dir = resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Malformed or unreadable .env: fall through to the schema, which will
        // report precisely which variables are missing.
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .default('postgres://elessar:elessar@localhost:5433/elessar'),

  ELESSAR_LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),

  ELESSAR_USER_AGENT: z
    .string()
    .default('Elessar/0.1 (+https://github.com/your-org/elessar)'),

  ELESSAR_MODEL_CACHE: z.string().default('./data/models'),

  // Optional keyed sources: empty string is normalized to undefined so
  // connectors can simply check for presence.
  FIRMS_MAP_KEY: z
    .string()
    .transform((v) => (v.trim() === '' ? undefined : v.trim()))
    .optional(),

  RELIEFWEB_APPNAME: z
    .string()
    .transform((v) => (v.trim() === '' ? undefined : v.trim()))
    .optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  if (cached) return cached;
  if (!source) loadDotEnvFile();
  const parsed = envSchema.safeParse(source ?? process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: drop the memoized config so a fresh env can be parsed. */
export function resetEnvCache(): void {
  cached = null;
}
