import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  computeConfidence,
  computeSeverity,
  embeddingText,
  gridCell,
  isEventCategory,
  type EventCategory,
  type GeoPrecision,
  type Logger,
} from '@elessar/core';
import {
  entities,
  observationEntities,
  observations,
  toVector,
  type Database,
  type ObservationRow,
} from '@elessar/db';
import {
  classifyWithPrior,
  embedBatch,
  extractEntities,
  priorStrengthFor,
  resolveLocation,
} from '@elessar/ml';

/**
 * Stage 2 — Enrich.
 *
 * Takes observations at pipeline_stage 0 and fills in everything derived:
 * location, embedding, category, entities, severity, confidence. Advances them
 * to stage 1.
 *
 * Batched throughout, because the embedding model is ~50× more efficient on a
 * batch of 32 than on 32 single calls, and it is the dominant cost in the
 * pipeline.
 */

export interface EnrichResult {
  processed: number;
  located: number;
  entitiesLinked: number;
  durationMs: number;
}

/** Rows per pass. Bounded so memory stays flat regardless of backlog size. */
const BATCH = 200;

export async function enrichPending(
  db: Database,
  log: Logger,
  options: { maxBatches?: number } = {},
): Promise<EnrichResult> {
  const started = Date.now();
  let processed = 0;
  let located = 0;
  let entitiesLinked = 0;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const pending = await db
      .select()
      .from(observations)
      .where(eq(observations.pipelineStage, 0))
      // Oldest first, so a backlog drains in the order events happened and the
      // clustering stage sees a coherent timeline rather than a shuffled one.
      .orderBy(asc(observations.ingestedAt))
      .limit(BATCH);

    if (pending.length === 0) break;

    const result = await enrichBatch(db, pending, log);
    processed += result.processed;
    located += result.located;
    entitiesLinked += result.entitiesLinked;

    if (pending.length < BATCH) break;
  }

  const durationMs = Date.now() - started;
  if (processed > 0) {
    log.info(
      { processed, located, entitiesLinked, ms: durationMs },
      'enrichment complete',
    );
  }

  return { processed, located, entitiesLinked, durationMs };
}

async function enrichBatch(
  db: Database,
  rows: ObservationRow[],
  log: Logger,
): Promise<EnrichResult> {
  const started = Date.now();

  // --- 1. Resolve locations (synchronous, in-process gazetteer) -----------
  const resolved = rows.map((row) => {
    const raw = row.raw as { actionGeo?: { fipsCountryCode?: string | null } } | null;

    const geo = resolveLocation({
      title: row.title,
      body: row.body,
      placeHint: row.placeName,
      // Trust coordinates the connector already supplied.
      geo:
        row.lat !== null && row.lon !== null
          ? {
              point: { lat: row.lat, lon: row.lon },
              precision: (row.geoPrecision as GeoPrecision) ?? 'unknown',
              placeName: row.placeName,
              countryCode: row.countryCode,
              admin1: row.admin1,
            }
          : null,
      fipsCountryCode: raw?.actionGeo?.fipsCountryCode ?? null,
    });

    return { row, geo };
  });

  // --- 2. Embed (batched — the expensive step) ---------------------------
  const texts = resolved.map(({ row, geo }) =>
    embeddingText(row.title, row.body, geo?.placeName ?? null),
  );
  const embeddings = await embedBatch(texts);

  // --- 3. Classify, extract entities, score ------------------------------
  interface Enriched {
    row: ObservationRow;
    category: EventCategory;
    categoryConfidence: number;
    embedding: number[];
    geo: (typeof resolved)[number]['geo'];
    severity: number;
    confidence: number;
    entityList: ReturnType<typeof extractEntities>;
  }

  const enriched: Enriched[] = [];

  for (let i = 0; i < resolved.length; i += 1) {
    const entry = resolved[i];
    const embedding = embeddings[i];
    if (!entry || !embedding) continue;

    const { row, geo } = entry;
    const text = texts[i] ?? row.title;

    // The connector's own category is a prior whose weight depends on how
    // authoritative that source is about classification.
    const prior = isEventCategory(row.category) && row.category !== 'other' ? row.category : null;
    const classification = classifyWithPrior(
      text,
      embedding,
      prior,
      priorStrengthFor(row.sourceId),
    );

    const geoPrecision: GeoPrecision = geo?.precision ?? 'unknown';

    const declaredActors = extractDeclaredActors(row.raw);
    const entityList = extractEntities(`${row.title}. ${row.body ?? ''}`, {
      declaredActors,
      maxEntities: 20,
    });

    const scoreInput = {
      sourceId: row.sourceId,
      category: classification.category,
      categoryConfidence: classification.confidence,
      magnitude: row.magnitude,
      tone: row.tone,
      reportCount: row.reportCount,
      geoPrecision,
      sourceCount: 1,
    };

    enriched.push({
      row,
      category: classification.category,
      categoryConfidence: classification.confidence,
      embedding,
      geo,
      severity: computeSeverity(scoreInput),
      confidence: computeConfidence(scoreInput),
      entityList,
    });

    if (geo) { /* counted below */ }
  }

  // --- 4. Persist enrichment --------------------------------------------
  let located = 0;

  // One UPDATE per observation. Kept simple rather than folded into a single
  // bulk CASE statement: this is not the pipeline's bottleneck (embedding is),
  // and a readable update is worth more here than a marginal gain.
  for (const item of enriched) {
    if (item.geo) located += 1;

    await db
      .update(observations)
      .set({
        lat: item.geo?.point.lat ?? null,
        lon: item.geo?.point.lon ?? null,
        geoPrecision: item.geo?.precision ?? 'unknown',
        placeName: item.geo?.placeName ?? null,
        countryCode: item.geo?.countryCode ?? null,
        admin1: item.geo?.admin1 ?? null,
        gridCell: item.geo ? gridCell(item.geo.point) : null,
        category: item.category,
        categoryConfidence: item.categoryConfidence,
        severity: item.severity,
        confidence: item.confidence,
        embedding: sql`${toVector(item.embedding)}::vector`,
        pipelineStage: 1,
      })
      .where(eq(observations.id, item.row.id));
  }

  // --- 5. Entity upsert and linking -------------------------------------
  const entitiesLinked = await linkEntities(db, enriched, log);

  return {
    processed: enriched.length,
    located,
    entitiesLinked,
    durationMs: Date.now() - started,
  };
}

/** GDELT names its actors structurally; pull them out for the entity extractor. */
function extractDeclaredActors(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;

  const actors: string[] = [];
  for (const key of ['actor1', 'actor2']) {
    const actor = record[key];
    if (actor && typeof actor === 'object') {
      const name = (actor as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name.trim().length > 1) actors.push(name.trim());
    }
  }
  return actors;
}

/**
 * Upsert entities and their observation links.
 *
 * Deduplicated across the whole batch before touching the database: the same
 * handful of countries and organizations appear in most observations of a batch,
 * so per-observation upserts would issue the same write hundreds of times.
 */
async function linkEntities(
  db: Database,
  enriched: {
    row: ObservationRow;
    entityList: ReturnType<typeof extractEntities>;
  }[],
  log: Logger,
): Promise<number> {
  interface Pending {
    key: string;
    name: string;
    kind: string;
    mentions: number;
  }

  const unique = new Map<string, Pending>();
  for (const item of enriched) {
    for (const entity of item.entityList) {
      const mapKey = `${entity.key}|${entity.kind}`;
      const existing = unique.get(mapKey);
      if (existing) {
        existing.mentions += entity.mentions;
      } else {
        unique.set(mapKey, {
          key: entity.key,
          name: entity.surface,
          kind: entity.kind,
          mentions: entity.mentions,
        });
      }
    }
  }

  if (unique.size === 0) return 0;

  const now = new Date();
  const entityRows = [...unique.values()];
  const idByMapKey = new Map<string, string>();

  const CHUNK = 200;
  for (let start = 0; start < entityRows.length; start += CHUNK) {
    const chunk = entityRows.slice(start, start + CHUNK);
    const returned = await db
      .insert(entities)
      .values(
        chunk.map((entity) => ({
          key: entity.key,
          name: entity.name,
          kind: entity.kind,
          mentionCount: entity.mentions,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [entities.key, entities.kind],
        set: {
          mentionCount: sql`${entities.mentionCount} + excluded.mention_count`,
          lastSeenAt: now,
        },
      })
      .returning({ id: entities.id, key: entities.key, kind: entities.kind });

    for (const row of returned) {
      idByMapKey.set(`${row.key}|${row.kind}`, row.id);
    }
  }

  // Any key we somehow did not get back (shouldn't happen, but a missing id
  // would silently drop links) — fetch it explicitly.
  const missing = entityRows.filter((e) => !idByMapKey.has(`${e.key}|${e.kind}`));
  if (missing.length > 0) {
    const found = await db
      .select({ id: entities.id, key: entities.key, kind: entities.kind })
      .from(entities)
      .where(
        inArray(
          entities.key,
          missing.map((m) => m.key),
        ),
      );
    for (const row of found) idByMapKey.set(`${row.key}|${row.kind}`, row.id);
  }

  // Observation ↔ entity links.
  const links: { observationId: string; entityId: string; mentions: number; confidence: number }[] =
    [];

  for (const item of enriched) {
    const seen = new Set<string>();
    for (const entity of item.entityList) {
      const entityId = idByMapKey.get(`${entity.key}|${entity.kind}`);
      if (!entityId || seen.has(entityId)) continue;
      seen.add(entityId);
      links.push({
        observationId: item.row.id,
        entityId,
        mentions: entity.mentions,
        confidence: entity.confidence,
      });
    }
  }

  for (let start = 0; start < links.length; start += CHUNK) {
    await db
      .insert(observationEntities)
      .values(links.slice(start, start + CHUNK))
      .onConflictDoNothing();
  }

  log.debug({ entities: unique.size, links: links.length }, 'entities linked');
  return links.length;
}

/** Count observations still awaiting enrichment. */
export async function pendingEnrichmentCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(observations)
    .where(and(eq(observations.pipelineStage, 0)));
  return row?.count ?? 0;
}
