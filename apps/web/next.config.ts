import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source rather than a build artifact, so
  // Next must compile them. This keeps the monorepo free of a build-order graph:
  // there is no `dist/` to be stale, and editing a package hot-reloads the app.
  transpilePackages: ['@elessar/core', '@elessar/db'],

  // Next loads .env itself; stop @elessar/core's loader from reading it again.
  env: {
    ELESSAR_SKIP_DOTENV: '1',
  },

  // Keep the Postgres driver out of the bundle: it is a native-ish Node module
  // and bundling it breaks the server runtime.
  serverExternalPackages: ['postgres'],

  typescript: {
    // Typechecking runs as its own task (`pnpm typecheck`); doing it again during
    // build doubles CI time for no extra signal.
    ignoreBuildErrors: false,
  },
};

export default config;
