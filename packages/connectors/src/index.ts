import { loadEnv, type SourceDefinition } from '@elessar/core';
import { gdeltEventsConnector } from './gdelt';
import { usgsQuakesConnector } from './usgs';
import { gdacsConnector } from './gdacs';
import { nwsAlertsConnector } from './nws';
import { eonetConnector } from './eonet';
import { firmsConnector } from './firms';
import { newsConnectors } from './rss';

export { createHttpClient, resetHttpState, HttpError } from './http';
export { parseFeed, createRssConnector, NEWS_FEEDS, asArray, nodeText, nodeAttr } from './rss';
export { gdeltEventsConnector } from './gdelt';
export { usgsQuakesConnector } from './usgs';
export { gdacsConnector } from './gdacs';
export { nwsAlertsConnector } from './nws';
export { eonetConnector } from './eonet';
export { firmsConnector } from './firms';

/**
 * The source registry.
 *
 * Everything Elessar can ingest. Ordering matters only for readability; the
 * scheduler decides its own order from each source's interval and health.
 *
 * To add a source: write a module exporting a `SourceDefinition` and add it
 * here. That is the entire contract — no registration elsewhere, no schema
 * change, no UI change. The dashboard's source panel and the category matrix
 * are both generated from this array.
 */
export const ALL_CONNECTORS: SourceDefinition[] = [
  // Global news-derived events — the broadest coverage.
  gdeltEventsConnector,

  // Authoritative hazard feeds.
  usgsQuakesConnector,
  gdacsConnector,
  eonetConnector,
  nwsAlertsConnector,
  firmsConnector,

  // Editorial news feeds — narrative context around the machine-coded events.
  ...newsConnectors,
];

/**
 * Connectors that can actually run in this environment: enabled, and with every
 * required environment variable present.
 *
 * Returned alongside the skipped list so the operator gets told *why* a source
 * is missing from the dashboard rather than having to guess.
 */
export function resolveAvailableConnectors(): {
  available: SourceDefinition[];
  skipped: { id: string; reason: string }[];
} {
  const env = loadEnv() as unknown as Record<string, string | undefined>;
  const available: SourceDefinition[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const connector of ALL_CONNECTORS) {
    const missing = (connector.requiresEnv ?? []).filter((key) => !env[key]);
    if (missing.length > 0) {
      skipped.push({
        id: connector.id,
        reason: `missing environment: ${missing.join(', ')}`,
      });
      continue;
    }
    available.push(connector);
  }

  return { available, skipped };
}

export function getConnector(id: string): SourceDefinition | undefined {
  return ALL_CONNECTORS.find((connector) => connector.id === id);
}
