import { z } from 'zod';
import { EVENT_CATEGORIES } from './taxonomy';

/**
 * The domain model has exactly two tiers, and keeping it at two is a deliberate
 * constraint:
 *
 *   Observation — one atomic, normalized report from one source at one time and
 *                 (ideally) one place. A news article, a seismograph reading, a
 *                 weather alert. Immutable once written. Carries provenance.
 *
 *   Event       — a real-world happening, materialized as a cluster of
 *                 Observations. Mutable: it accretes observations, and its
 *                 severity/confidence/summary are recomputed as it does.
 *
 * Everything the dashboard shows is an Event. Observations are the audit trail
 * that justifies it — which is the whole point of a platform like this: every
 * pin on the globe must be traceable to primary sources.
 */

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

export type GeoPoint = z.infer<typeof geoPointSchema>;

/**
 * How a location was determined. Drives the confidence penalty applied during
 * scoring — a country-centroid guess should not produce a confident pin.
 */
export const GEO_PRECISIONS = [
  'exact', // source supplied coordinates (USGS, FIRMS, GDACS)
  'city', // resolved to a populated place in the gazetteer
  'admin1', // resolved to a state/province
  'country', // resolved to a country centroid only
  'unknown',
] as const;

export type GeoPrecision = (typeof GEO_PRECISIONS)[number];

export const geoResolutionSchema = z.object({
  point: geoPointSchema,
  precision: z.enum(GEO_PRECISIONS),
  /** Human-readable place name, e.g. "Kharkiv, Kharkivska oblast, UA". */
  placeName: z.string().nullable(),
  /** ISO 3166-1 alpha-2, uppercased. */
  countryCode: z.string().length(2).nullable(),
  admin1: z.string().nullable(),
});

export type GeoResolution = z.infer<typeof geoResolutionSchema>;

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * A connector's output before enrichment. Connectors are responsible for
 * producing this and nothing more — no geocoding, no embedding, no scoring.
 * That separation is what makes connectors trivial to write and test.
 */
export const observationDraftSchema = z.object({
  /** Stable connector id, e.g. "gdelt.events", "usgs.quakes", "rss.bbc-world". */
  sourceId: z.string().min(1),

  /**
   * The source's own identifier for this record, if it has one. Combined with
   * sourceId it forms the natural key used for idempotent upserts, so a replayed
   * fetch window never duplicates rows.
   */
  externalId: z.string().min(1),

  title: z.string().min(1),
  body: z.string().nullable(),
  url: z.string().url().nullable(),

  /** When the event happened (or was reported), per the source. */
  occurredAt: z.date(),
  /** When the source published//made the record available. */
  publishedAt: z.date().nullable(),

  /** Set when the source supplies coordinates directly. */
  geo: geoResolutionSchema.nullable(),

  /**
   * Free-text place hint for the geocoder when `geo` is null — e.g. an RSS
   * item's dateline, or a GDACS country field.
   */
  placeHint: z.string().nullable(),

  /** Connector's own category assignment, if it can make one confidently. */
  category: z.enum(EVENT_CATEGORIES).nullable(),

  /**
   * Source-native magnitude on the source's own scale (Richter, Saffir-Simpson,
   * GDELT Goldstein, …). Interpreted by `severity.ts` per source.
   */
  magnitude: z.number().nullable(),

  /** -1 (very negative) .. +1 (very positive), when the source provides tone. */
  tone: z.number().min(-1).max(1).nullable(),

  /** How many distinct outlets/reports back this record, when known. */
  reportCount: z.number().int().nonnegative().nullable(),

  /** Named actors the source explicitly identifies. */
  actors: z.array(z.string()).default([]),

  /** Untouched source payload, kept for provenance and re-processing. */
  raw: z.unknown(),
});

export type ObservationDraft = z.input<typeof observationDraftSchema>;
export type ParsedObservationDraft = z.output<typeof observationDraftSchema>;

/** Enrichment output merged onto a draft to produce a persistable observation. */
export interface ObservationEnrichment {
  geo: GeoResolution | null;
  category: (typeof EVENT_CATEGORIES)[number];
  categoryConfidence: number;
  embedding: number[];
  entities: ExtractedEntity[];
  severity: number;
  confidence: number;
  /** Normalized text actually fed to the embedder — kept for debuggability. */
  embeddedText: string;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const ENTITY_KINDS = ['person', 'organization', 'place', 'group', 'unknown'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface ExtractedEntity {
  /** Surface form as it appeared in the text. */
  surface: string;
  /** Normalized key for deduplication: lowercased, punctuation-stripped. */
  key: string;
  kind: EntityKind;
  /** Number of mentions within this single observation. */
  mentions: number;
  /** Extractor confidence, 0..1. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EVENT_STATUSES = ['active', 'developing', 'dormant', 'closed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * Severity and confidence are both 0..100 integers.
 *
 *   severity   — how much this matters. Combines source-native magnitude,
 *                corroboration breadth, and category base rate.
 *   confidence — how much we trust that it is real and correctly located.
 *                Independent of severity: a well-corroborated minor event has
 *                high confidence and low severity.
 *
 * Keeping them orthogonal is what lets an analyst filter "high severity but
 * low confidence" — the single most operationally interesting quadrant.
 */
export interface EventScores {
  severity: number;
  confidence: number;
}

export interface EventSummary {
  id: string;
  title: string;
  summary: string | null;
  category: (typeof EVENT_CATEGORIES)[number];
  status: EventStatus;
  severity: number;
  confidence: number;
  lat: number | null;
  lon: number | null;
  placeName: string | null;
  countryCode: string | null;
  geoPrecision: GeoPrecision;
  observationCount: number;
  sourceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Rate of change in observation volume; drives the "escalating" badge. */
  velocity: number;
  topEntities: { name: string; kind: EntityKind; weight: number }[];
}

// ---------------------------------------------------------------------------
// Connector contract
// ---------------------------------------------------------------------------

/**
 * Opaque, connector-defined checkpoint persisted between runs (a last-seen
 * timestamp, an ETag, a file cursor). The framework stores and returns it
 * without interpreting it, so a connector can evolve its cursor shape freely.
 */
export type SourceCursor = Record<string, unknown>;

export interface FetchContext {
  /** Cursor persisted by this connector's previous successful run. */
  cursor: SourceCursor | null;
  /** Fetch helper with the shared rate limiter, retry and UA already wired in. */
  http: HttpClient;
  signal: AbortSignal;
  log: Logger;
}

export interface FetchResult {
  observations: ObservationDraft[];
  /** Cursor to persist for the next run. Null leaves the existing one intact. */
  cursor: SourceCursor | null;
  /** Set when the source signalled "nothing changed" (HTTP 304). */
  notModified?: boolean;
}

export interface SourceDefinition {
  id: string;
  /** Display name for the sources panel. */
  name: string;
  /** Where the data comes from, shown in the UI for attribution. */
  homepage: string;
  /** Licence/attribution string. Non-optional: attribution is not optional. */
  license: string;
  /** Minimum seconds between runs. The scheduler will not go faster. */
  intervalSeconds: number;
  /** Minimum milliseconds between individual HTTP requests to this host. */
  minRequestIntervalMs: number;
  /** Set when the connector needs an API key that may be absent. */
  requiresEnv?: string[];
  /** Categories this source can produce, for the UI's source/category matrix. */
  emits: readonly (typeof EVENT_CATEGORIES)[number][];
  fetch(ctx: FetchContext): Promise<FetchResult>;
}

// ---------------------------------------------------------------------------
// Small shared interfaces (kept here so packages need not depend on each other)
// ---------------------------------------------------------------------------

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  /** Sent as If-None-Match; a 304 response is surfaced, not thrown. */
  etag?: string | null;
  /** Sent as If-Modified-Since. */
  lastModified?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  etag: string | null;
  lastModified: string | null;
  /** True when the server returned 304 and no body was transferred. */
  notModified: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
}

export interface HttpClient {
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

export interface Logger {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}
