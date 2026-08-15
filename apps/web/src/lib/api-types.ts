/**
 * Wire types shared between route handlers and client components.
 *
 * Declared once here rather than inferred from the query layer, because the wire
 * format is a contract: dates cross as ISO strings, and the client must never
 * accidentally depend on a Drizzle row shape that a schema change could alter.
 */

export interface EventDto {
  id: string;
  title: string;
  summary: string | null;
  category: string;
  status: string;
  severity: number;
  confidence: number;
  velocity: number;
  lat: number | null;
  lon: number | null;
  geoPrecision: string;
  placeName: string | null;
  countryCode: string | null;
  observationCount: number;
  sourceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  entities?: { name: string; kind: string; weight: number }[];
}

/**
 * `entities` is omitted and redeclared: the feed needs a compact
 * {name, kind, weight} triple for chips, while the detail view needs the entity
 * id (to link into the graph) and a raw mention count. Widening one shape to
 * serve both would ship the feed a payload it never uses, multiplied by 600 rows.
 */
export interface EventDetailDto extends Omit<EventDto, 'entities'> {
  observations: {
    id: string;
    sourceId: string;
    sourceName: string;
    title: string;
    body: string | null;
    url: string | null;
    occurredAt: string;
    severity: number;
    similarity: number;
    placeName: string | null;
    magnitude: number | null;
    tone: number | null;
  }[];
  entities: { id: string; name: string; kind: string; mentions: number }[];
  related: { id: string; title: string; similarity: number; category: string; severity: number }[];
}

export interface StatsDto {
  activeEvents: number;
  observations24h: number;
  criticalEvents: number;
  openAlerts: number;
  countriesAffected: number;
  topCategories: { category: string; count: number }[];
  healthySources: number;
  totalSources: number;
}

export interface TimelinePointDto {
  bucket: string;
  /** Counts keyed by category group id. */
  groups: Record<string, number>;
  total: number;
}

export interface AlertDto {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  category: string | null;
  placeName: string | null;
  lat: number | null;
  lon: number | null;
  zScore: number | null;
  observed: number | null;
  expected: number | null;
  severity: number;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface SourceHealthDto {
  id: string;
  name: string;
  homepage: string;
  license: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  observationsIngested: number;
  lastRunObservations: number | null;
  lastRunDurationMs: number | null;
}

export interface GraphDto {
  nodes: { id: string; name: string; kind: string; mentionCount: number }[];
  edges: { source: string; target: string; weight: number; pmi: number }[];
}

/** Query string shape for the events endpoint. */
export interface EventQuery {
  groups?: string[];
  minSeverity?: number;
  hours?: number;
  search?: string;
  limit?: number;
  locatedOnly?: boolean;
  orderBy?: 'hotness' | 'severity' | 'recent';
}
