import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { EventCategory, EventStatus } from '@elessar/core';
import { halfLifeHours } from '@elessar/core';
import type { Database } from './client';
import {
  alerts,
  entities,
  entityEdges,
  eventObservations,
  events,
  observationEntities,
  observations,
  sources,
} from './schema';

/**
 * Read side. Every query the dashboard needs lives here rather than in route
 * handlers, so the SQL is reviewable in one place and the web app stays a thin
 * presentation layer.
 */

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface EventFilters {
  categories?: EventCategory[];
  statuses?: EventStatus[];
  minSeverity?: number;
  minConfidence?: number;
  since?: Date;
  until?: Date;
  countryCode?: string;
  bbox?: BoundingBox;
  /** Free-text match against title/summary/place. */
  search?: string;
  /** Only events that have usable coordinates (what the globe needs). */
  locatedOnly?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'hotness' | 'severity' | 'recent';
}

/**
 * Time-decayed severity, with the half-life chosen per category.
 *
 * Built as a SQL CASE from the same `halfLifeHours` table the scoring code uses,
 * so the ordering an analyst sees can never drift from the documented decay
 * model. Ordering by raw severity instead would leave a week-old magnitude-7
 * earthquake permanently pinned above an unfolding crisis.
 */
function hotnessExpression(): SQL<number> {
  const categoriesInPlay: EventCategory[] = [
    'seismic',
    'severe_weather',
    'wildfire',
    'cyber',
    'armed_conflict',
    'humanitarian',
    'health',
    'economy',
  ];

  /**
   * Half-life values are emitted as inline numeric literals rather than bound
   * parameters.
   *
   * postgres.js binds a JS number in an untyped position as `text`, which makes
   * the division below fail with "operator does not exist: numeric / text". The
   * values come from `halfLifeHours` — our own constant table, never user input —
   * and are coerced through `Number()` here, so inlining them carries no
   * injection risk.
   */
  const branches = categoriesInPlay.map(
    (category) =>
      sql`when ${events.category} = ${category} then ${sql.raw(
        Number(halfLifeHours(category)).toString(),
      )}`,
  );

  const halfLife = sql`(case ${sql.join(branches, sql` `)} else ${sql.raw(
    Number(halfLifeHours('other')).toString(),
  )} end)::numeric`;

  /**
   * `greatest(0, …)` on the age is load-bearing, not defensive dressing.
   *
   * Some sources legitimately emit future timestamps — an NWS flood warning
   * carries a forecast river-crest onset up to three days ahead. A negative age
   * makes `power(0.5, negative)` *amplify* severity without bound, and in
   * practice it did: routine county flood warnings scored a hotness of 239 on a
   * 0–100 scale and buried every real event in the feed. Clamping the age means
   * time decay can only ever reduce a score, which is the only behaviour that
   * makes the ranking meaningful.
   */
  return sql<number>`
    ${events.severity} * power(
      0.5,
      (greatest(0, extract(epoch from (now() - ${events.lastSeenAt}))) / 3600.0) / ${halfLife}
    )
  `;
}

function eventConditions(filters: EventFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.categories?.length) {
    conditions.push(inArray(events.category, filters.categories));
  }
  if (filters.statuses?.length) {
    conditions.push(inArray(events.status, filters.statuses));
  }
  if (filters.minSeverity !== undefined) {
    conditions.push(gte(events.severity, filters.minSeverity));
  }
  if (filters.minConfidence !== undefined) {
    conditions.push(gte(events.confidence, filters.minConfidence));
  }
  if (filters.since) {
    conditions.push(gte(events.lastSeenAt, filters.since));
  }
  if (filters.until) {
    conditions.push(lte(events.firstSeenAt, filters.until));
  }
  if (filters.countryCode) {
    conditions.push(eq(events.countryCode, filters.countryCode.toUpperCase()));
  }
  if (filters.locatedOnly) {
    conditions.push(isNotNull(events.lat));
    conditions.push(isNotNull(events.lon));
  }
  if (filters.bbox) {
    const { minLat, maxLat, minLon, maxLon } = filters.bbox;
    conditions.push(gte(events.lat, minLat));
    conditions.push(lte(events.lat, maxLat));
    // A viewport spanning the antimeridian arrives with minLon > maxLon; it
    // must be treated as two ranges rather than an empty one.
    if (minLon <= maxLon) {
      conditions.push(gte(events.lon, minLon));
      conditions.push(lte(events.lon, maxLon));
    } else {
      const wrapped = or(gte(events.lon, minLon), lte(events.lon, maxLon));
      if (wrapped) conditions.push(wrapped);
    }
  }
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    const matched = or(
      sql`${events.title} ilike ${term}`,
      sql`${events.summary} ilike ${term}`,
      sql`${events.placeName} ilike ${term}`,
    );
    if (matched) conditions.push(matched);
  }

  return conditions;
}

export interface EventListRow {
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
  firstSeenAt: Date;
  lastSeenAt: Date;
  hotness: number;
}

export async function listEvents(
  db: Database,
  filters: EventFilters = {},
): Promise<EventListRow[]> {
  const conditions = eventConditions(filters);
  const hotness = hotnessExpression();

  const orderBy =
    filters.orderBy === 'severity'
      ? [desc(events.severity), desc(events.lastSeenAt)]
      : filters.orderBy === 'recent'
        ? [desc(events.lastSeenAt)]
        : [desc(hotness), desc(events.lastSeenAt)];

  return db
    .select({
      id: events.id,
      title: events.title,
      summary: events.summary,
      category: events.category,
      status: events.status,
      severity: events.severity,
      confidence: events.confidence,
      velocity: events.velocity,
      lat: events.lat,
      lon: events.lon,
      geoPrecision: events.geoPrecision,
      placeName: events.placeName,
      countryCode: events.countryCode,
      observationCount: events.observationCount,
      sourceCount: events.sourceCount,
      firstSeenAt: events.firstSeenAt,
      lastSeenAt: events.lastSeenAt,
      hotness: sql<number>`${hotness}`.as('hotness'),
    })
    .from(events)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(Math.min(filters.limit ?? 200, 2000))
    .offset(filters.offset ?? 0);
}

export async function countEvents(db: Database, filters: EventFilters = {}): Promise<number> {
  const conditions = eventConditions(filters);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .where(conditions.length ? and(...conditions) : undefined);
  return row?.count ?? 0;
}

export interface EventDetail extends EventListRow {
  observations: {
    id: string;
    sourceId: string;
    sourceName: string;
    title: string;
    body: string | null;
    url: string | null;
    occurredAt: Date;
    severity: number;
    similarity: number;
    placeName: string | null;
    magnitude: number | null;
    tone: number | null;
  }[];
  entities: { id: string; name: string; kind: string; mentions: number }[];
}

export async function getEventDetail(db: Database, id: string): Promise<EventDetail | null> {
  const hotness = hotnessExpression();

  const [event] = await db
    .select({
      id: events.id,
      title: events.title,
      summary: events.summary,
      category: events.category,
      status: events.status,
      severity: events.severity,
      confidence: events.confidence,
      velocity: events.velocity,
      lat: events.lat,
      lon: events.lon,
      geoPrecision: events.geoPrecision,
      placeName: events.placeName,
      countryCode: events.countryCode,
      observationCount: events.observationCount,
      sourceCount: events.sourceCount,
      firstSeenAt: events.firstSeenAt,
      lastSeenAt: events.lastSeenAt,
      hotness: sql<number>`${hotness}`.as('hotness'),
    })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);

  if (!event) return null;

  const memberObservations = await db
    .select({
      id: observations.id,
      sourceId: observations.sourceId,
      sourceName: sources.name,
      title: observations.title,
      body: observations.body,
      url: observations.url,
      occurredAt: observations.occurredAt,
      severity: observations.severity,
      similarity: eventObservations.similarity,
      placeName: observations.placeName,
      magnitude: observations.magnitude,
      tone: observations.tone,
    })
    .from(eventObservations)
    .innerJoin(observations, eq(observations.id, eventObservations.observationId))
    .innerJoin(sources, eq(sources.id, observations.sourceId))
    .where(eq(eventObservations.eventId, id))
    .orderBy(desc(observations.occurredAt))
    .limit(200);

  // Entity weights for this event: sum mentions across its observations.
  const eventEntities = await db
    .select({
      id: entities.id,
      name: entities.name,
      kind: entities.kind,
      mentions: sql<number>`sum(${observationEntities.mentions})::int`,
    })
    .from(eventObservations)
    .innerJoin(
      observationEntities,
      eq(observationEntities.observationId, eventObservations.observationId),
    )
    .innerJoin(entities, eq(entities.id, observationEntities.entityId))
    .where(eq(eventObservations.eventId, id))
    .groupBy(entities.id, entities.name, entities.kind)
    .orderBy(desc(sql`sum(${observationEntities.mentions})`))
    .limit(25);

  return { ...event, observations: memberObservations, entities: eventEntities };
}

/** Top entities per event, batched — avoids an N+1 when rendering the feed. */
export async function getTopEntitiesForEvents(
  db: Database,
  eventIds: string[],
  perEvent = 4,
): Promise<Map<string, { name: string; kind: string; weight: number }[]>> {
  const result = new Map<string, { name: string; kind: string; weight: number }[]>();
  if (eventIds.length === 0) return result;

  const rows = await db
    .select({
      eventId: eventObservations.eventId,
      name: entities.name,
      kind: entities.kind,
      weight: sql<number>`sum(${observationEntities.mentions})::int`,
      rank: sql<number>`row_number() over (
        partition by ${eventObservations.eventId}
        order by sum(${observationEntities.mentions}) desc
      )`.as('rank'),
    })
    .from(eventObservations)
    .innerJoin(
      observationEntities,
      eq(observationEntities.observationId, eventObservations.observationId),
    )
    .innerJoin(entities, eq(entities.id, observationEntities.entityId))
    .where(inArray(eventObservations.eventId, eventIds))
    .groupBy(eventObservations.eventId, entities.id, entities.name, entities.kind);

  for (const row of rows) {
    if (row.rank > perEvent) continue;
    const list = result.get(row.eventId) ?? [];
    list.push({ name: row.name, kind: row.kind, weight: row.weight });
    result.set(row.eventId, list);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export interface TimelineBucket {
  bucket: Date;
  category: string;
  count: number;
  avgSeverity: number;
  maxSeverity: number;
}

/**
 * Observation volume over time, bucketed and split by category — the stacked
 * area chart under the globe. Reads observations rather than events so the
 * curve reflects incoming signal rather than clustering decisions.
 */
export async function getTimeline(
  db: Database,
  options: {
    since: Date;
    bucketMinutes?: number;
    categories?: EventCategory[];
  },
): Promise<TimelineBucket[]> {
  const bucketMinutes = options.bucketMinutes ?? 60;
  const conditions: SQL[] = [gte(observations.occurredAt, options.since)];
  if (options.categories?.length) {
    conditions.push(inArray(observations.category, options.categories));
  }

  const bucket = sql<Date>`
    to_timestamp(
      floor(extract(epoch from ${observations.occurredAt}) / ${bucketMinutes * 60})
      * ${bucketMinutes * 60}
    )
  `.as('bucket');

  return db
    .select({
      bucket,
      category: observations.category,
      count: sql<number>`count(*)::int`,
      avgSeverity: sql<number>`round(avg(${observations.severity}))::int`,
      maxSeverity: sql<number>`max(${observations.severity})::int`,
    })
    .from(observations)
    .where(and(...conditions))
    .groupBy(sql`1`, observations.category)
    .orderBy(asc(sql`1`));
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export async function listAlerts(
  db: Database,
  options: { limit?: number; openOnly?: boolean } = {},
) {
  const conditions: SQL[] = [];
  if (options.openOnly) {
    conditions.push(sql`${alerts.acknowledgedAt} is null`);
  }

  return db
    .select()
    .from(alerts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(alerts.createdAt))
    .limit(options.limit ?? 50);
}

// ---------------------------------------------------------------------------
// Entity graph
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  mentionCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  pmi: number;
}

/**
 * Co-occurrence subgraph around the most-mentioned entities.
 *
 * Ranked by PMI rather than raw co-occurrence: raw counts produce a hairball
 * where every node connects to whichever country appears most, which tells an
 * analyst nothing. PMI surfaces pairs that appear together more than their
 * individual frequencies would predict.
 */
export async function getEntityGraph(
  db: Database,
  options: { nodeLimit?: number; edgeLimit?: number; since?: Date } = {},
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const nodeLimit = options.nodeLimit ?? 60;

  const conditions: SQL[] = [];
  if (options.since) conditions.push(gte(entities.lastSeenAt, options.since));

  const nodes = await db
    .select({
      id: entities.id,
      name: entities.name,
      kind: entities.kind,
      mentionCount: entities.mentionCount,
    })
    .from(entities)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(entities.mentionCount))
    .limit(nodeLimit);

  if (nodes.length === 0) return { nodes: [], edges: [] };

  const nodeIds = nodes.map((n) => n.id);
  const edges = await db
    .select({
      source: entityEdges.sourceEntityId,
      target: entityEdges.targetEntityId,
      weight: entityEdges.coOccurrences,
      pmi: entityEdges.pmi,
    })
    .from(entityEdges)
    .where(
      and(
        inArray(entityEdges.sourceEntityId, nodeIds),
        inArray(entityEdges.targetEntityId, nodeIds),
        gte(entityEdges.coOccurrences, 2),
      ),
    )
    .orderBy(desc(entityEdges.pmi))
    .limit(options.edgeLimit ?? 240);

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Operational
// ---------------------------------------------------------------------------

export async function getSourceHealth(db: Database) {
  return db
    .select({
      id: sources.id,
      name: sources.name,
      homepage: sources.homepage,
      license: sources.license,
      enabled: sources.enabled,
      lastRunAt: sources.lastRunAt,
      lastSuccessAt: sources.lastSuccessAt,
      lastErrorAt: sources.lastErrorAt,
      lastError: sources.lastError,
      consecutiveFailures: sources.consecutiveFailures,
      observationsIngested: sources.observationsIngested,
      lastRunObservations: sources.lastRunObservations,
      lastRunDurationMs: sources.lastRunDurationMs,
    })
    .from(sources)
    .orderBy(asc(sources.id));
}

export interface DashboardStats {
  activeEvents: number;
  observations24h: number;
  criticalEvents: number;
  openAlerts: number;
  countriesAffected: number;
  topCategories: { category: string; count: number }[];
  healthySources: number;
  totalSources: number;
}

export async function getDashboardStats(db: Database): Promise<DashboardStats> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Independent aggregates over different tables: run them concurrently rather
  // than paying five sequential round-trips on every dashboard load.
  const [activeRow, obsRow, criticalRow, alertRow, countryRow, categoryRows, sourceRows] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(and(eq(events.status, 'active'), gte(events.lastSeenAt, since24h))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(observations)
        .where(gte(observations.ingestedAt, since24h)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(and(gte(events.severity, 70), gte(events.lastSeenAt, since24h))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(alerts)
        .where(sql`${alerts.acknowledgedAt} is null`),
      db
        .select({ count: sql<number>`count(distinct ${events.countryCode})::int` })
        .from(events)
        .where(and(isNotNull(events.countryCode), gte(events.lastSeenAt, since24h))),
      db
        .select({
          category: events.category,
          count: sql<number>`count(*)::int`,
        })
        .from(events)
        .where(gte(events.lastSeenAt, since24h))
        .groupBy(events.category)
        .orderBy(desc(sql`count(*)`))
        .limit(8),
      db
        .select({
          total: sql<number>`count(*)::int`,
          healthy: sql<number>`count(*) filter (where ${sources.consecutiveFailures} = 0)::int`,
        })
        .from(sources)
        .where(eq(sources.enabled, true)),
    ]);

  return {
    activeEvents: activeRow[0]?.count ?? 0,
    observations24h: obsRow[0]?.count ?? 0,
    criticalEvents: criticalRow[0]?.count ?? 0,
    openAlerts: alertRow[0]?.count ?? 0,
    countriesAffected: countryRow[0]?.count ?? 0,
    topCategories: categoryRows,
    healthySources: sourceRows[0]?.healthy ?? 0,
    totalSources: sourceRows[0]?.total ?? 0,
  };
}

/**
 * Semantically similar events, via the centroid HNSW index. Powers the
 * "related events" panel — the connect-the-dots feature that distinguishes this
 * from a news reader.
 */
export async function findRelatedEvents(
  db: Database,
  eventId: string,
  limit = 8,
): Promise<{ id: string; title: string; similarity: number; category: string; severity: number }[]> {
  const rows = await db.execute<{
    id: string;
    title: string;
    similarity: number;
    category: string;
    severity: number;
  }>(sql`
    with target as (
      select centroid from ${events} where ${events.id} = ${eventId}
    )
    select
      e.id,
      e.title,
      e.category,
      e.severity,
      1 - (e.centroid <=> target.centroid) as similarity
    from ${events} e, target
    where e.id <> ${eventId}
      and e.centroid is not null
      and target.centroid is not null
    order by e.centroid <=> target.centroid
    limit ${limit}
  `);

  return [...rows];
}
