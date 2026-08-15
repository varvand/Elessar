import pino from 'pino';
import type { Logger } from './types';

/**
 * Structured logging. The ingest worker is a long-running background process
 * whose failures are usually partial (one connector wedged, the rest fine), so
 * every log line carries the source id and pipeline stage as fields rather than
 * being interpolated into a message string.
 */

let root: pino.Logger | null = null;

function rootLogger(): pino.Logger {
  if (root) return root;
  const level = process.env.ELESSAR_LOG_LEVEL ?? 'info';
  const pretty = process.env.NODE_ENV !== 'production';

  root = pino({
    level,
    base: undefined, // drop pid/hostname noise in dev
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname',
              messageFormat: '{if source}[{source}] {end}{msg}',
            },
          },
        }
      : {}),
  });
  return root;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return rootLogger().child(bindings) as unknown as Logger;
}
