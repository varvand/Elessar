import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  centroid as sphericalCentroid,
  computeConfidence,
  computeSeverity,
  gridCell,
  truncate,
  updateCentroid,
  type EventCategory,
  type GeoPrecision,
  type Logger,
} from '@elessar/core';
import {
  entityEdges,
  eventObservations,
  events,
  observationEntities,
  observations,
  toVector,
  fromVector,
  type Database,
  type ObservationRow,
} from '@elessar/db';
import {
  computeVelocity,
  deriveStatus,
  findBestCluster,
  orderEdge,
  pointwiseMutualInformation,
  selectEventTitle,
  type ClusterCandidate,
} from '@elessar/ml';

/**
 * Stage 3 — Correlate.
 *
 * Assigns stage-1 observations to events, creating events as needed, then
 * recomputes each touched event's aggregate state. Advances observations to
 * stage 2.
 *
 * Candidate retrieval uses the pgvector HNSW index over event centroids,
 * restricted to a recent time window. That is what keeps this affordable: the
 * cost per observation is roughly constant no matter how much history has
 * accumulated, because the ANN index does the pruning rather than a scan.
 */

export interface CorrelateResult {
  processed: number;
  eventsCreated: number;
  eventsUpdated: number;
  edgesUpdated: number;
  durationMs: number;
}

const BATCH = 150;

/** How far back to look for a matching event. Mirrors the clustering time gate. */
const CANDIDATE_WINDOW_HOURS = 72;

/** ANN candidates to re-rank per observation. */
const CANDIDATE_LIMIT = 20;

export async function correlatePending(
  db: Database,
  log: Logger,
  options: { maxBatches?: number } = {},
): Promise<CorrelateResult> {
  const started = Date.now();
  let processed = 0;
  let eventsCreated = 0;
  let eventsUpdated = 0;
  const touchedEvents = new Set<string>();
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const pending = await db
      .select()
      .from(observations)
      .where(and(eq(observations.pipelineStage, 1)))
      .orderBy(asc(observations.occurredAt))
      .limit(BATCH);

    if (pending.length === 0) break;

    for (const observation of pending) {
      const outcome = await assignToEvent(db, observation);
      if (outcome.created) eventsCreated += 1;
      touchedEvents.add(outcome.eventId);
      processed += 1;

      await db
        .update(observations)
        .set({ pipelineStage: 2 })
        .where(eq(observations.id, observation.id));
    }

    if (pending.length < BATCH) break;
  }

  // Recompute aggregates once per event rather than once per observation: an
  // event that absorbed 40 observations this cycle would otherwise be
  // recalculated 40 times to the same final value.
  for (const eventId of touchedEvents) {
    await recomputeEvent(db, eventId);
    eventsUpdated += 1;
  }

  const edgesUpdated = touchedEvents.size > 0 ? await updateEntityGraph(db, log) : 0;

  const durationMs = Date.now() - started;
  if (processed > 0) {
    log.info(
      { processed, eventsCreated, eventsUpdated, edgesUpdated, ms: durationMs },
      'correlation complete',
    );
  }

  return { processed, eventsCreated, eventsUpdated, edgesUpdated, durationMs };
}

/**
 * Find or create the event for one observation.
 *
 * The ANN query asks for nearest centroids; `findBestCluster` then applies the
 * temporal, spatial and category gates that a vector index cannot express.
 */
async function assignToEvent(
  db: Database,
  observation: ObservationRow,
): Promise<{ eventId: string; created: boolean }> {
  const embedding = fromVector(observation.embedding as unknown as string | number[] | null);

  // No embedding means enrichment failed for this row; it still deserves to be
  // visible, so it becomes a singleton event rather than being dropped.
  if (!embedding || embedding.length === 0) {
    return { eventId: await createEvent(db, observation, null), created: true };
  }

  const since = new Date(Date.now() - CANDIDATE_WINDOW_HOURS * 60 * 60 * 1000);

  const rows = await db.execute<{
    id: string;
    centroid: string;
    category: string;
    lat: number | null;
    lon: number | null;
    geo_precision: string;
    country_code: string | null;
    last_seen_at: Date;
    first_seen_at: Date;
    observation_count: number;
  }>(sql`
    select id, centroid::text as centroid, category, lat, lon, geo_precision,
           country_code, last_seen_at, first_seen_at, observation_count
    from ${events}
    where centroid is not null
      -- Bound as an explicit timestamptz literal: raw Date parameters are not
      -- serializable through drizzle's execute() path on the postgres.js driver.
      and last_seen_at >= ${since.toISOString()}::timestamptz
    order by centroid <=> ${toVector(embedding)}::vector
    limit ${CANDIDATE_LIMIT}
  `);

  const candidates: ClusterCandidate[] = [];
  for (const row of rows) {
    const candidateCentroid = fromVector(row.centroid);
    if (!candidateCentroid) continue;
    candidates.push({
      eventId: row.id,
      centroid: candidateCentroid,
      category: row.category as EventCategory,
      lat: row.lat,
      lon: row.lon,
      geoPrecision: row.geo_precision as GeoPrecision,
      countryCode: row.country_code,
      lastSeenAt: new Date(row.last_seen_at),
      firstSeenAt: new Date(row.first_seen_at),
      observationCount: row.observation_count,
    });
  }

  const match = findBestCluster(
    {
      embedding,
      category: observation.category as EventCategory,
      point:
        observation.lat !== null && observation.lon !== null
          ? { lat: observation.lat, lon: observation.lon }
          : null,
      geoPrecision: (observation.geoPrecision as GeoPrecision) ?? 'unknown',
      countryCode: observation.countryCode,
      occurredAt: observation.occurredAt,
    },
    candidates,
  );

  if (!match) {
    return { eventId: await createEvent(db, observation, embedding), created: true };
  }

  await db
    .insert(eventObservations)
    .values({
      eventId: match.eventId,
      observationId: observation.id,
      similarity: match.similarity,
    })
    .onConflictDoNothing();

  // Incremental centroid update — O(dim) rather than re-averaging every member.
  const candidate = candidates.find((c) => c.eventId === match.eventId);
  if (candidate) {
    const nextCentroid = updateCentroid(
      candidate.centroid,
      candidate.observationCount,
      embedding,
    );
    await db
      .update(events)
      .set({ centroid: sql`${toVector(nextCentroid)}::vector` })
      .where(eq(events.id, match.eventId));
  }

  return { eventId: match.eventId, created: false };
}

async function createEvent(
  db: Database,
  observation: ObservationRow,
  embedding: number[] | null,
): Promise<string> {
  const [created] = await db
    .insert(events)
    .values({
      title: truncate(observation.title, 200),
      summary: observation.body ? truncate(observation.body, 600) : null,
      category: observation.category,
      status: 'active',
      severity: observation.severity,
      confidence: observation.confidence,
      velocity: 0,
      lat: observation.lat,
      lon: observation.lon,
      geoPrecision: observation.geoPrecision,
      placeName: observation.placeName,
      countryCode: observation.countryCode,
      gridCell: observation.gridCell,
      observationCount: 1,
      sourceCount: 1,
      firstSeenAt: observation.occurredAt,
      lastSeenAt: observation.occurredAt,
      ...(embedding ? { centroid: sql`${toVector(embedding)}::vector` } : {}),
    })
    .returning({ id: events.id });

  const eventId = created!.id;

  await db
    .insert(eventObservations)
    .values({ eventId, observationId: observation.id, similarity: 1 })
    .onConflictDoNothing();

  return eventId;
}

/**
 * Recompute an event's aggregate state from its members.
 *
 * Derived wholesale rather than incrementally patched. Incremental updates to
 * severity, centroid geography and title would each need their own correctness
 * argument, and any bug would accumulate silently across an event's whole life.
 * One query per touched event per cycle is a price worth paying for state that
 * is always exactly a function of its members.
 */
async function recomputeEvent(db: Database, eventId: string): Promise<void> {
  const members = await db
    .select({
      id: observations.id,
      sourceId: observations.sourceId,
      title: observations.title,
      body: observations.body,
      severity: observations.severity,
      confidence: observations.confidence,
      category: observations.category,
      categoryConfidence: observations.categoryConfidence,
      magnitude: observations.magnitude,
      tone: observations.tone,
      reportCount: observations.reportCount,
      lat: observations.lat,
      lon: observations.lon,
      geoPrecision: observations.geoPrecision,
      placeName: observations.placeName,
      countryCode: observations.countryCode,
      occurredAt: observations.occurredAt,
    })
    .from(eventObservations)
    .innerJoin(observations, eq(observations.id, eventObservations.observationId))
    .where(eq(eventObservations.eventId, eventId));

  if (members.length === 0) return;

  const distinctSources = new Set(members.map((m) => m.sourceId));

  const occurredTimes = members.map((m) => m.occurredAt.getTime());
  const firstSeenAt = new Date(Math.min(...occurredTimes));
  const lastSeenAt = new Date(Math.max(...occurredTimes));

  // Majority category, weighted by each member's classification confidence so a
  // confident minority beats a hesitant majority.
  const categoryWeights = new Map<string, number>();
  for (const member of members) {
    categoryWeights.set(
      member.category,
      (categoryWeights.get(member.category) ?? 0) + Math.max(member.categoryConfidence, 0.1),
    );
  }
  const category = [...categoryWeights.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  // Geographic centroid, weighted toward precisely-located members so a single
  // country-centroid observation cannot drag a well-located event off target.
  const locatedMembers = members.filter(
    (m): m is typeof m & { lat: number; lon: number } => m.lat !== null && m.lon !== null,
  );

  const precisionWeight: Record<string, number> = {
    exact: 8,
    city: 4,
    admin1: 2,
    country: 1,
    unknown: 0.5,
  };

  const point = sphericalCentroid(
    locatedMembers.map((m) => ({
      point: { lat: m.lat, lon: m.lon },
      weight: precisionWeight[m.geoPrecision] ?? 1,
    })),
  );

  // The event's precision is that of its best-located member — the tightest
  // constraint we actually have on where this happened.
  const bestPrecision = locatedMembers.reduce<GeoPrecision>((best, m) => {
    const current = (m.geoPrecision as GeoPrecision) ?? 'unknown';
    return (precisionWeight[current] ?? 0) > (precisionWeight[best] ?? 0) ? current : best;
  }, 'unknown');

  const bestLocated = locatedMembers.find((m) => m.geoPrecision === bestPrecision);

  // Severity: the most severe member, re-scored with the event's corroboration.
  // Max rather than mean because an event is as serious as its worst confirmed
  // report — averaging would let routine follow-up coverage dilute a disaster.
  const peak = members.reduce((worst, m) => (m.severity > worst.severity ? m : worst), members[0]!);

  const scoreInput = {
    sourceId: peak.sourceId,
    category: category as EventCategory,
    categoryConfidence: peak.categoryConfidence,
    magnitude: peak.magnitude,
    tone: peak.tone,
    reportCount: peak.reportCount,
    geoPrecision: bestPrecision,
    sourceCount: distinctSources.size,
  };

  const recentCutoff = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const recentCount = members.filter((m) => m.occurredAt >= recentCutoff).length;
  const velocity = computeVelocity(firstSeenAt, lastSeenAt, members.length, recentCount);

  const title = selectEventTitle(
    members.map((m) => ({
      title: m.title,
      sourceId: m.sourceId,
      severity: m.severity,
      occurredAt: m.occurredAt,
    })),
  );

  await db
    .update(events)
    .set({
      title,
      summary: buildSummary(members),
      category,
      status: deriveStatus(lastSeenAt, velocity),
      severity: computeSeverity(scoreInput),
      confidence: computeConfidence(scoreInput),
      velocity,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      geoPrecision: bestPrecision,
      placeName: bestLocated?.placeName ?? null,
      countryCode: mostCommonCountry(members),
      gridCell: point ? gridCell(point) : null,
      observationCount: members.length,
      sourceCount: distinctSources.size,
      firstSeenAt,
      lastSeenAt,
      updatedAt: new Date(),
    })
    .where(eq(events.id, eventId));
}

/**
 * Extractive summary from member bodies.
 *
 * Deliberately simple: the highest-severity member's body, truncated. The
 * centroid-based MMR selection in `@elessar/ml` produces better prose but needs
 * per-sentence embeddings, which is not worth an extra model pass per event on
 * every cycle. `selectSummarySentences` is wired up and available when a
 * deployment wants to trade throughput for summary quality.
 */
function buildSummary(members: { body: string | null; severity: number }[]): string | null {
  const withBody = members
    .filter((m): m is typeof m & { body: string } => Boolean(m.body?.trim()))
    .sort((a, b) => b.severity - a.severity);

  const best = withBody[0];
  return best ? truncate(best.body, 500) : null;
}

function mostCommonCountry(members: { countryCode: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const member of members) {
    if (!member.countryCode) continue;
    counts.set(member.countryCode, (counts.get(member.countryCode) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Entity co-occurrence graph
// ---------------------------------------------------------------------------

/** Entities per observation considered for edges. */
const MAX_ENTITIES_PER_PAIRING = 8;

/**
 * Rebuild co-occurrence edges from recently-correlated observations.
 *
 * Pairs are aggregated in memory across the whole window before any write:
 * generating them per-observation would issue the same country-pair upsert
 * thousands of times per cycle.
 *
 * Only the top-N entities per observation participate. Full pairing is O(k²) and
 * the tail entities of a document are the noisy ones — including them costs
 * quadratically while adding mostly spurious edges.
 */
async function updateEntityGraph(db: Database, log: Logger): Promise<number> {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const rows = await db
    .select({
      observationId: observationEntities.observationId,
      entityId: observationEntities.entityId,
      mentions: observationEntities.mentions,
    })
    .from(observationEntities)
    .innerJoin(observations, eq(observations.id, observationEntities.observationId))
    .where(and(gte(observations.ingestedAt, since), eq(observations.pipelineStage, 2)))
    .orderBy(asc(observationEntities.observationId));

  if (rows.length === 0) return 0;

  // Group by observation.
  const byObservation = new Map<string, { entityId: string; mentions: number }[]>();
  for (const row of rows) {
    const list = byObservation.get(row.observationId) ?? [];
    list.push({ entityId: row.entityId, mentions: row.mentions });
    byObservation.set(row.observationId, list);
  }

  const pairCounts = new Map<string, number>();
  const entityDocCounts = new Map<string, number>();
  const totalDocuments = byObservation.size;

  for (const entityList of byObservation.values()) {
    const top = entityList
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, MAX_ENTITIES_PER_PAIRING);

    for (const entity of top) {
      entityDocCounts.set(entity.entityId, (entityDocCounts.get(entity.entityId) ?? 0) + 1);
    }

    for (let i = 0; i < top.length; i += 1) {
      for (let j = i + 1; j < top.length; j += 1) {
        const [a, b] = orderEdge(top[i]!.entityId, top[j]!.entityId);
        const key = `${a}|${b}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  if (pairCounts.size === 0) return 0;

  const now = new Date();
  const edgeRows = [...pairCounts.entries()].map(([key, coOccurrences]) => {
    const [sourceEntityId, targetEntityId] = key.split('|') as [string, string];
    const pmi = pointwiseMutualInformation(
      coOccurrences,
      entityDocCounts.get(sourceEntityId) ?? 0,
      entityDocCounts.get(targetEntityId) ?? 0,
      totalDocuments,
    );
    return { sourceEntityId, targetEntityId, coOccurrences, pmi, lastSeenAt: now };
  });

  const CHUNK = 300;
  for (let start = 0; start < edgeRows.length; start += CHUNK) {
    await db
      .insert(entityEdges)
      .values(edgeRows.slice(start, start + CHUNK))
      .onConflictDoUpdate({
        target: [entityEdges.sourceEntityId, entityEdges.targetEntityId],
        set: {
          coOccurrences: sql`${entityEdges.coOccurrences} + excluded.co_occurrences`,
          // PMI is recomputed from this window rather than accumulated: it is a
          // ratio, and summing ratios is meaningless.
          pmi: sql`excluded.pmi`,
          lastSeenAt: now,
        },
      });
  }

  log.debug(
    { edges: edgeRows.length, documents: totalDocuments },
    'entity graph updated',
  );

  return edgeRows.length;
}

/**
 * Refresh `status` and `velocity` for events that received nothing this cycle,
 * so an event goes dormant by the passage of time rather than lingering as
 * "active" forever.
 */
export async function ageEvents(db: Database, log: Logger): Promise<number> {
  const stale = await db
    .select({
      id: events.id,
      lastSeenAt: events.lastSeenAt,
      velocity: events.velocity,
      status: events.status,
    })
    .from(events)
    .where(inArray(events.status, ['active', 'developing']))
    .limit(5000);

  let updated = 0;
  const now = new Date();

  for (const event of stale) {
    const nextStatus = deriveStatus(event.lastSeenAt, event.velocity, now);
    if (nextStatus !== event.status) {
      await db.update(events).set({ status: nextStatus }).where(eq(events.id, event.id));
      updated += 1;
    }
  }

  if (updated > 0) log.debug({ updated }, 'event statuses aged');
  return updated;
}
