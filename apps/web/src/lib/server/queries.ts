import 'server-only';
import { getDatabase, listEvents, getTopEntitiesForEvents, getDashboardStats, getTimeline, listAlerts, getSourceHealth, getEntityGraph, getEventDetail, findRelatedEvents } from '@elessar/db';
import type { EventCategory } from '@elessar/core';
import { EVENT_CATEGORIES } from '@elessar/core';
import {
  categoriesInGroup,
  groupForCategory,
  STACK_ORDER,
  type CategoryGroupId,
} from '../presentation';
import type {
  AlertDto,
  EventDetailDto,
  EventDto,
  GraphDto,
  SourceHealthDto,
  StatsDto,
  TimelinePointDto,
} from '../api-types';

/**
 * Server-side data access.
 *
 * Route handlers and server components call these; nothing here is ever
 * reachable from the client bundle (`server-only` enforces that at build time).
 * The job of this layer is translation — filter params in, wire DTOs out — so
 * that neither the SQL nor the React tree has to know about the other.
 */

export interface ResolvedFilters {
  groups: CategoryGroupId[];
  minSeverity: number;
  hours: number;
  search: string | null;
  limit: number;
  locatedOnly: boolean;
  orderBy: 'hotness' | 'severity' | 'recent';
}

/**
 * Parse and clamp filters from a URL.
 *
 * Clamped rather than validated-and-rejected: this is a read-only dashboard, and
 * a nonsense `limit=999999` should quietly become a sane page rather than a 400
 * that blanks the operator's screen.
 */
export function parseFilters(url: URL): ResolvedFilters {
  const params = url.searchParams;

  const groupParam = params.get('groups');
  const groups = groupParam
    ? (groupParam.split(',').filter((g) => STACK_ORDER.includes(g as CategoryGroupId)) as CategoryGroupId[])
    : [];

  const hours = clampNumber(params.get('hours'), 1, 720, 24);
  const minSeverity = clampNumber(params.get('minSeverity'), 0, 100, 0);
  const limit = clampNumber(params.get('limit'), 1, 1500, 300);

  const orderByRaw = params.get('orderBy');
  const orderBy =
    orderByRaw === 'severity' || orderByRaw === 'recent' ? orderByRaw : 'hotness';

  return {
    groups,
    minSeverity,
    hours,
    search: params.get('search')?.trim() || null,
    limit,
    locatedOnly: params.get('locatedOnly') === '1',
    orderBy,
  };
}

function clampNumber(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Expand selected groups into the category list the SQL layer filters on. */
function categoriesForGroups(groups: CategoryGroupId[]): EventCategory[] | undefined {
  if (groups.length === 0 || groups.length === STACK_ORDER.length) return undefined;
  return groups.flatMap((group) => categoriesInGroup(group));
}

export async function fetchEvents(filters: ResolvedFilters): Promise<EventDto[]> {
  const db = getDatabase();
  const since = new Date(Date.now() - filters.hours * 60 * 60 * 1000);

  const rows = await listEvents(db, {
    categories: categoriesForGroups(filters.groups),
    minSeverity: filters.minSeverity > 0 ? filters.minSeverity : undefined,
    since,
    search: filters.search ?? undefined,
    locatedOnly: filters.locatedOnly,
    limit: filters.limit,
    orderBy: filters.orderBy,
  });

  // Batched: fetching entities per event would be an N+1 across up to 1500 rows.
  const entityMap = await getTopEntitiesForEvents(
    db,
    rows.map((row) => row.id),
    4,
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    status: row.status,
    severity: row.severity,
    confidence: row.confidence,
    velocity: row.velocity,
    lat: row.lat,
    lon: row.lon,
    geoPrecision: row.geoPrecision,
    placeName: row.placeName,
    countryCode: row.countryCode,
    observationCount: row.observationCount,
    sourceCount: row.sourceCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    entities: entityMap.get(row.id) ?? [],
  }));
}

export async function fetchEventDetail(id: string): Promise<EventDetailDto | null> {
  const db = getDatabase();
  const detail = await getEventDetail(db, id);
  if (!detail) return null;

  const related = await findRelatedEvents(db, id, 6);

  return {
    id: detail.id,
    title: detail.title,
    summary: detail.summary,
    category: detail.category,
    status: detail.status,
    severity: detail.severity,
    confidence: detail.confidence,
    velocity: detail.velocity,
    lat: detail.lat,
    lon: detail.lon,
    geoPrecision: detail.geoPrecision,
    placeName: detail.placeName,
    countryCode: detail.countryCode,
    observationCount: detail.observationCount,
    sourceCount: detail.sourceCount,
    firstSeenAt: detail.firstSeenAt.toISOString(),
    lastSeenAt: detail.lastSeenAt.toISOString(),
    observations: detail.observations.map((observation) => ({
      id: observation.id,
      sourceId: observation.sourceId,
      sourceName: observation.sourceName,
      title: observation.title,
      body: observation.body,
      url: observation.url,
      occurredAt: observation.occurredAt.toISOString(),
      severity: observation.severity,
      similarity: observation.similarity,
      placeName: observation.placeName,
      magnitude: observation.magnitude,
      tone: observation.tone,
    })),
    entities: detail.entities,
    related: related.map((event) => ({
      id: event.id,
      title: event.title,
      similarity: Number(event.similarity),
      category: event.category,
      severity: event.severity,
    })),
  };
}

export async function fetchStats(): Promise<StatsDto> {
  return getDashboardStats(getDatabase());
}

/**
 * Observation volume over time, folded into category groups.
 *
 * The fold happens here rather than in SQL because the grouping is a
 * presentation concern — the store keeps full category granularity, and a future
 * view that wants all 18 categories should not need a schema change.
 */
export async function fetchTimeline(
  hours: number,
  groups: CategoryGroupId[],
): Promise<TimelinePointDto[]> {
  const db = getDatabase();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Bucket width scales with the window so the chart always has a readable
  // number of marks — 5-minute buckets over a week would be 2000 slivers.
  const bucketMinutes = hours <= 6 ? 15 : hours <= 24 ? 60 : hours <= 72 ? 180 : 360;

  const rows = await getTimeline(db, {
    since,
    bucketMinutes,
    categories: categoriesForGroups(groups),
  });

  const byBucket = new Map<string, TimelinePointDto>();

  for (const row of rows) {
    const key = new Date(row.bucket).toISOString();
    let point = byBucket.get(key);
    if (!point) {
      point = { bucket: key, groups: {}, total: 0 };
      byBucket.set(key, point);
    }
    const group = groupForCategory(row.category);
    point.groups[group] = (point.groups[group] ?? 0) + row.count;
    point.total += row.count;
  }

  // Fill empty buckets so the area chart shows genuine gaps in activity rather
  // than interpolating across them.
  const filled: TimelinePointDto[] = [];
  const bucketMs = bucketMinutes * 60 * 1000;
  const start = Math.floor(since.getTime() / bucketMs) * bucketMs;
  const end = Date.now();

  for (let t = start; t <= end; t += bucketMs) {
    const key = new Date(t).toISOString();
    filled.push(byBucket.get(key) ?? { bucket: key, groups: {}, total: 0 });
  }

  return filled;
}

export async function fetchAlerts(limit = 40): Promise<AlertDto[]> {
  const rows = await listAlerts(getDatabase(), { limit, openOnly: false });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    category: row.category,
    placeName: row.placeName,
    lat: row.lat,
    lon: row.lon,
    zScore: row.zScore,
    observed: row.observed,
    expected: row.expected,
    severity: row.severity,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
  }));
}

export async function fetchSourceHealth(): Promise<SourceHealthDto[]> {
  const rows = await getSourceHealth(getDatabase());
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    homepage: row.homepage,
    license: row.license,
    enabled: row.enabled,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    observationsIngested: row.observationsIngested,
    lastRunObservations: row.lastRunObservations,
    lastRunDurationMs: row.lastRunDurationMs,
  }));
}

export async function fetchGraph(hours = 24): Promise<GraphDto> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return getEntityGraph(getDatabase(), { nodeLimit: 55, edgeLimit: 200, since });
}

/** All categories, for the filter panel's group → category breakdown. */
export const ALL_CATEGORIES = EVENT_CATEGORIES;
