import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/**
 * Elessar's store.
 *
 * Design commitments worth knowing before changing anything here:
 *
 * 1. Observations are append-only. Nothing in the pipeline updates an
 *    observation's content after insert — only its enrichment columns get
 *    filled in. This makes the table a genuine audit log, so any pin on the
 *    globe can be traced back to the exact bytes a source served.
 *
 * 2. Events are derived state. Every event could, in principle, be rebuilt
 *    from observations alone. That is what makes it safe to retune the
 *    clustering thresholds: drop and rebuild rather than migrate.
 *
 * 3. Embeddings live in `vector(384)` columns with HNSW indexes. 384 is
 *    all-MiniLM-L6-v2's output width; changing models means a migration and a
 *    re-embed, so the dimension is asserted in `@elessar/ml` at load time.
 *
 * 4. Timestamps are all `timestamptz`. Feeds arrive in a dozen timezones and
 *    the one thing worse than a wrong pin is a pin at the wrong time.
 */

export const EMBEDDING_DIMENSIONS = 384;

// ---------------------------------------------------------------------------
// Source registry and health
// ---------------------------------------------------------------------------

/**
 * One row per connector. Holds the polling cursor and the HTTP cache validators
 * so restarts are cheap and we stay a polite client of free public APIs.
 */
export const sources = pgTable(
  'sources',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    homepage: text('homepage').notNull(),
    license: text('license').notNull(),
    enabled: boolean('enabled').notNull().default(true),

    /** Connector-defined checkpoint; opaque to the framework. */
    cursor: jsonb('cursor'),
    etag: text('etag'),
    lastModified: text('last_modified'),

    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),

    /**
     * Consecutive failures. The scheduler backs off exponentially on this so a
     * dead source stops hammering both us and them.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    observationsIngested: integer('observations_ingested').notNull().default(0),
    lastRunDurationMs: integer('last_run_duration_ms'),
    lastRunObservations: integer('last_run_observations'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sources_enabled_idx').on(t.enabled)],
);

// ---------------------------------------------------------------------------
// Observations — the append-only evidence log
// ---------------------------------------------------------------------------

export const observations = pgTable(
  'observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),

    /** The source's own id. (source_id, external_id) is the idempotency key. */
    externalId: text('external_id').notNull(),

    /**
     * SHA-256 over normalized title+body. Catches the same story republished
     * under different ids by the same outlet, which `external_id` alone misses.
     */
    contentHash: text('content_hash').notNull(),

    title: text('title').notNull(),
    body: text('body'),
    url: text('url'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),

    // --- Geography (filled by the enrichment stage) ---
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    geoPrecision: text('geo_precision').notNull().default('unknown'),
    placeName: text('place_name'),
    countryCode: text('country_code'),
    admin1: text('admin1'),
    /** Coarse grid cell id, denormalized for fast anomaly-baseline grouping. */
    gridCell: text('grid_cell'),

    // --- Classification and scoring ---
    category: text('category').notNull().default('other'),
    categoryConfidence: real('category_confidence').notNull().default(0),
    severity: smallint('severity').notNull().default(0),
    confidence: smallint('confidence').notNull().default(0),

    /** Source-native magnitude, on the source's own scale. */
    magnitude: doublePrecision('magnitude'),
    /** -1..+1 sentiment/tone where the source supplies it. */
    tone: real('tone'),
    reportCount: integer('report_count'),

    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),

    /** Verbatim source payload, for provenance and reprocessing. */
    raw: jsonb('raw'),

    /**
     * Pipeline progress marker, so a crash mid-run resumes rather than
     * reprocessing or silently dropping rows.
     * 0 = inserted, 1 = enriched, 2 = correlated.
     */
    pipelineStage: smallint('pipeline_stage').notNull().default(0),
  },
  (t) => [
    // Idempotent ingest: a replayed fetch window updates rather than duplicates.
    uniqueIndex('observations_source_external_idx').on(t.sourceId, t.externalId),
    // Near-duplicate detection across ids within a source.
    index('observations_content_hash_idx').on(t.sourceId, t.contentHash),
    index('observations_occurred_at_idx').on(t.occurredAt.desc()),
    index('observations_stage_idx').on(t.pipelineStage, t.ingestedAt),
    index('observations_category_idx').on(t.category, t.occurredAt.desc()),
    index('observations_country_idx').on(t.countryCode, t.occurredAt.desc()),
    index('observations_grid_idx').on(t.gridCell, t.occurredAt.desc()),
    // HNSW over cosine distance: the clustering hot path is "nearest neighbours
    // of this new observation among the last N hours".
    index('observations_embedding_idx')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
    index('observations_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
  ],
);

// ---------------------------------------------------------------------------
// Events — derived clusters
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Representative headline, taken from the highest-severity observation. */
    title: text('title').notNull(),
    /** Extractive summary built from the cluster's member observations. */
    summary: text('summary'),

    category: text('category').notNull().default('other'),
    /** active | developing | dormant | closed */
    status: text('status').notNull().default('active'),

    severity: smallint('severity').notNull().default(0),
    confidence: smallint('confidence').notNull().default(0),

    /**
     * Observation arrival rate relative to this event's own history.
     * >1 means accelerating; the UI badges these as escalating.
     */
    velocity: real('velocity').notNull().default(0),

    // Weighted centroid of member observations.
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    geoPrecision: text('geo_precision').notNull().default('unknown'),
    placeName: text('place_name'),
    countryCode: text('country_code'),
    gridCell: text('grid_cell'),

    observationCount: integer('observation_count').notNull().default(0),
    sourceCount: integer('source_count').notNull().default(0),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Running mean of member embeddings. New observations are matched against
     * this, so it must be updated incrementally (see `updateCentroid`).
     */
    centroid: vector('centroid', { dimensions: EMBEDDING_DIMENSIONS }),
  },
  (t) => [
    index('events_severity_idx').on(t.severity.desc(), t.lastSeenAt.desc()),
    index('events_last_seen_idx').on(t.lastSeenAt.desc()),
    index('events_category_idx').on(t.category, t.lastSeenAt.desc()),
    index('events_status_idx').on(t.status, t.severity.desc()),
    index('events_country_idx').on(t.countryCode),
    // Bounding-box queries for the globe viewport.
    index('events_geo_idx').on(t.lat, t.lon),
    index('events_centroid_idx')
      .using('hnsw', t.centroid.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

/** Which observations justify which event. The provenance link. */
export const eventObservations = pgTable(
  'event_observations',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    observationId: uuid('observation_id')
      .notNull()
      .references(() => observations.id, { onDelete: 'cascade' }),
    /** Cosine similarity to the event centroid at the time of assignment. */
    similarity: real('similarity').notNull().default(0),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.observationId] }),
    index('event_observations_observation_idx').on(t.observationId),
    index('event_observations_event_added_idx').on(t.eventId, t.addedAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Entity graph
// ---------------------------------------------------------------------------

/**
 * Canonical entities. `key` is the normalized form used for dedup; `name` keeps
 * the nicest surface form seen so far for display.
 */
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** person | organization | place | group | unknown */
    kind: text('kind').notNull().default('unknown'),

    mentionCount: integer('mention_count').notNull().default(0),
    eventCount: integer('event_count').notNull().default(0),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('entities_key_kind_idx').on(t.key, t.kind),
    index('entities_mentions_idx').on(t.mentionCount.desc()),
    // Fuzzy lookup for the search box and for merging near-identical surfaces.
    index('entities_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

export const observationEntities = pgTable(
  'observation_entities',
  {
    observationId: uuid('observation_id')
      .notNull()
      .references(() => observations.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    mentions: integer('mentions').notNull().default(1),
    confidence: real('confidence').notNull().default(0.5),
  },
  (t) => [
    primaryKey({ columns: [t.observationId, t.entityId] }),
    index('observation_entities_entity_idx').on(t.entityId),
  ],
);

/**
 * Undirected co-occurrence edges between entities.
 *
 * The invariant that makes this table work: `sourceEntityId < targetEntityId`
 * as UUID strings, enforced at write time. Without a canonical ordering the same
 * pair accumulates two half-weighted rows and the graph quietly halves every
 * edge weight.
 *
 * `pmi` (pointwise mutual information) is stored alongside the raw count so the
 * graph view can rank by *surprising* co-occurrence rather than by sheer volume
 * — otherwise every edge just connects to "United States".
 */
export const entityEdges = pgTable(
  'entity_edges',
  {
    sourceEntityId: uuid('source_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    targetEntityId: uuid('target_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    coOccurrences: integer('co_occurrences').notNull().default(0),
    pmi: real('pmi').notNull().default(0),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceEntityId, t.targetEntityId] }),
    index('entity_edges_weight_idx').on(t.coOccurrences.desc()),
    index('entity_edges_pmi_idx').on(t.pmi.desc()),
    index('entity_edges_target_idx').on(t.targetEntityId),
  ],
);

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

/**
 * Rolling baselines per (category, grid cell), maintained with Welford's
 * online algorithm so we never need to re-scan history to know what "normal"
 * looks like. This is what makes "unusual activity" detectable rather than just
 * "lots of activity".
 */
export const baselines = pgTable(
  'baselines',
  {
    category: text('category').notNull(),
    gridCell: text('grid_cell').notNull(),

    /** Number of time buckets observed. */
    sampleCount: integer('sample_count').notNull().default(0),
    /** Running mean observations-per-bucket. */
    mean: real('mean').notNull().default(0),
    /** Welford's M2 accumulator; variance = m2 / (sampleCount - 1). */
    m2: real('m2').notNull().default(0),

    lastBucketAt: timestamp('last_bucket_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.category, t.gridCell] })],
);

/**
 * Fired when observed volume for a (category, cell) exceeds its baseline by
 * more than the configured z-score. These are the "something is happening"
 * signals, as opposed to individual events.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** volume_spike | severity_spike | new_cluster */
    kind: text('kind').notNull(),

    /**
     * Caller-computed idempotency key, e.g.
     * `volume_spike:armed_conflict:5:34:41:2026-08-15T19:00Z`.
     *
     * Explicit rather than a unique index over (kind, category, grid_cell,
     * bucket): those columns are nullable, and Postgres treats NULLs as
     * distinct, so such an index silently permits duplicates for exactly the
     * rows most likely to repeat.
     */
    dedupKey: text('dedup_key').notNull(),

    /** Time bucket this alert was raised for; distinct from created_at. */
    bucketAt: timestamp('bucket_at', { withTimezone: true }).notNull(),

    title: text('title').notNull(),
    detail: text('detail'),

    category: text('category'),
    gridCell: text('grid_cell'),
    countryCode: text('country_code'),
    placeName: text('place_name'),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),

    /** How many standard deviations above baseline. */
    zScore: real('z_score'),
    observed: integer('observed'),
    expected: real('expected'),

    severity: smallint('severity').notNull().default(0),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),

    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('alerts_created_idx').on(t.createdAt.desc()),
    index('alerts_open_idx').on(t.acknowledgedAt, t.severity.desc()),
    // Retrying an ingest run must not double-fire an alert.
    uniqueIndex('alerts_dedup_idx').on(t.dedupKey),
  ],
);

// ---------------------------------------------------------------------------
// Ingest run log — operational visibility
// ---------------------------------------------------------------------------

export const ingestRuns = pgTable(
  'ingest_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** ok | error | skipped | not_modified */
    outcome: text('outcome'),
    fetched: integer('fetched').notNull().default(0),
    inserted: integer('inserted').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    durationMs: integer('duration_ms'),
    error: text('error'),
  },
  (t) => [index('ingest_runs_source_started_idx').on(t.sourceId, t.startedAt.desc())],
);

// ---------------------------------------------------------------------------
// Relations (for Drizzle's relational query API)
// ---------------------------------------------------------------------------

export const sourcesRelations = relations(sources, ({ many }) => ({
  observations: many(observations),
}));

export const observationsRelations = relations(observations, ({ one, many }) => ({
  source: one(sources, {
    fields: [observations.sourceId],
    references: [sources.id],
  }),
  eventLinks: many(eventObservations),
  entityLinks: many(observationEntities),
}));

export const eventsRelations = relations(events, ({ many }) => ({
  observationLinks: many(eventObservations),
  alerts: many(alerts),
}));

export const eventObservationsRelations = relations(eventObservations, ({ one }) => ({
  event: one(events, {
    fields: [eventObservations.eventId],
    references: [events.id],
  }),
  observation: one(observations, {
    fields: [eventObservations.observationId],
    references: [observations.id],
  }),
}));

export const entitiesRelations = relations(entities, ({ many }) => ({
  observationLinks: many(observationEntities),
}));

export const observationEntitiesRelations = relations(observationEntities, ({ one }) => ({
  observation: one(observations, {
    fields: [observationEntities.observationId],
    references: [observations.id],
  }),
  entity: one(entities, {
    fields: [observationEntities.entityId],
    references: [entities.id],
  }),
}));

export type SourceRow = typeof sources.$inferSelect;
export type ObservationRow = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EntityRow = typeof entities.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type BaselineRow = typeof baselines.$inferSelect;
