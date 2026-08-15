# Elessar — Architecture

> An open-source situational awareness platform. Ingests free, public event and
> news streams; geolocates, classifies and correlates them with local machine
> learning; and presents the result as a live global dashboard.

This document is the map of the system: what the pieces are, why they are shaped
that way, and which decisions are load-bearing. Read it before making a change
that crosses a package boundary.

---

## 1. Design principles

These are the commitments the rest of the system is derived from. When a tradeoff
comes up, resolve it in favour of these.

**1. Every pin is traceable to primary sources.**
The dashboard shows derived, machine-clustered, machine-scored objects. That is
only trustworthy if an analyst can open any event and see the exact reports that
produced it, each with its source, timestamp, similarity score and a link to the
original. This is why observations are append-only and why the detail panel leads
with evidence rather than a summary.

**2. Uncertainty is displayed, never hidden.**
A country-centroid guess must not render as a confident city pin. `GeoPrecision`
travels with every location, severity and confidence are separate orthogonal
scores, and clustering similarity is surfaced in the UI. A system that looks
certain when it is not is worse than one that admits doubt.

**3. Free means free.**
Every source ships keyless or with a free key. Embeddings run locally. Geocoding
runs locally. There is no paid dependency anywhere in the pipeline, and no
observation text leaves the operator's machine.

**4. Derived state is disposable.**
`events`, `entities`, `entity_edges` and `baselines` can all be rebuilt from
`observations`. This is what makes it safe to retune clustering thresholds or the
scoring model: drop and re-derive rather than migrate. It is used constantly
during development.

**5. Silence must be visible.**
If a connector is failing, the globe is quietly missing part of the world. An
operator reading an empty globe as a calm world is the most dangerous failure this
system can have, so source health is a first-class panel.

---

## 2. System overview

```
┌─────────────────── EXTERNAL SOURCES (all free) ───────────────────┐
│ GDELT firehose · USGS · GDACS · NASA EONET · NOAA/NWS · FIRMS*    │
│ BBC · Al Jazeera · DW · France 24 · UN News        (* free key)   │
└─────────────────────────────┬─────────────────────────────────────┘
                              │  HTTP: rate-limited, ETag-cached,
                              │  exponential backoff, real User-Agent
                    ┌─────────▼──────────┐
                    │  @elessar/         │
                    │  connectors        │   One SourceDefinition per feed.
                    │                    │   Output: ObservationDraft[]
                    └─────────┬──────────┘   No enrichment, no I/O beyond fetch.
                              │
              ╔═══════════════▼═══════════════════════════════════╗
              ║          apps/ingest  (single worker loop)        ║
              ║                                                   ║
              ║  1 COLLECT    drafts → observations (stage 0)      ║
              ║               idempotent on (source_id,           ║
              ║               external_id)                        ║
              ║                                                   ║
              ║  2 ENRICH     stage 0 → 1                         ║
              ║               geocode · embed · classify ·         ║
              ║               extract entities · score            ║
              ║                                                   ║
              ║  3 CORRELATE  stage 1 → 2                         ║
              ║               cluster into events · entity graph   ║
              ║                                                   ║
              ║  4 DETECT     hourly baselines → anomaly alerts    ║
              ║                                                   ║
              ║  5 AGE        retire events that went quiet        ║
              ╚═══════════════╦═══════════════════════════════════╝
                              │ uses
                    ┌─────────▼──────────┐        ┌──────────────────┐
                    │  @elessar/ml       │        │  @elessar/core   │
                    │  embeddings (ONNX) │        │  domain model    │
                    │  gazetteer         │        │  taxonomy        │
                    │  classifier        │◄───────┤  scoring         │
                    │  clustering        │        │  geo maths       │
                    │  anomaly detection │        │  (pure, no I/O)  │
                    └─────────┬──────────┘        └──────────────────┘
                              │
                    ┌─────────▼──────────────────────────────────┐
                    │  PostgreSQL 17 + pgvector + pg_trgm        │
                    │  observations (append-only evidence log)   │
                    │  events (derived clusters, HNSW centroids) │
                    │  entities · entity_edges · baselines       │
                    └─────────┬──────────────────────────────────┘
                              │ @elessar/db (Drizzle, typed queries)
                    ┌─────────▼──────────┐
                    │  apps/web          │  Next.js 16 App Router
                    │  SSR first paint   │  route handlers → DTOs
                    │  20s client poll   │  globe · feed · timeline
                    └────────────────────┘  alerts · sources · detail
```

---

## 3. Repository layout

```
elessar/
├── apps/
│   ├── ingest/            Long-running worker. Owns the pipeline loop.
│   │   └── src/stages/    collect · enrich · correlate · detect
│   └── web/               Next.js dashboard (SSR + client polling)
│       └── src/
│           ├── app/       routes + API handlers
│           ├── components/globe · feed · charts · panels
│           └── lib/       presentation tokens, DTOs, server queries
├── packages/
│   ├── core/              Domain model, taxonomy, scoring, geo. Pure.
│   ├── db/                Drizzle schema, migrations, read queries
│   ├── connectors/        One module per source + shared HTTP client
│   └── ml/                Embeddings, gazetteer, classifier, clustering
├── infra/
│   ├── docker-compose.yml Postgres 17 + pgvector
│   └── postgres/init/     extension bootstrap
└── docs/                  ADRs, source catalogue, design notes
```

### Why a monorepo with source-only packages

Packages export TypeScript source (`"exports": { ".": "./src/index.ts" }`) rather
than compiled `dist/`. Next.js compiles them via `transpilePackages`; the worker
runs them through `tsx`. Consequences:

- No build-order graph, no stale `dist/`, no watch-mode orchestration.
- Editing `@elessar/core` hot-reloads the dashboard immediately.
- Typechecking is a separate task (`pnpm typecheck`) rather than a build gate.

The cost is that packages cannot be published as-is. That is an acceptable trade
for an application monorepo, and reversible by adding a build step later.

### The client/server boundary is enforced by module structure

`@elessar/core`'s barrel re-exports the env loader (`node:fs`) and text utilities
(`node:crypto`). Client components must therefore import the pure subpath:

```ts
import { CATEGORY_LABELS } from '@elessar/core/taxonomy';  // browser-safe
import { loadEnv } from '@elessar/core';                    // server only
```

Getting this wrong is not a subtle bug — Turbopack fails the build with *"the
chunking context does not support external modules (request: node:fs)"*. The
subpath exports make the boundary structural rather than a convention.

---

## 4. Data model

Two tiers, and keeping it at two is a deliberate constraint.

### `observations` — the evidence log

One atomic, normalized report from one source at one time and place. **Append-only**:
the pipeline fills in enrichment columns but never rewrites content. This makes
the table a genuine audit trail.

| Concern | Columns |
|---|---|
| Identity | `source_id` + `external_id` (unique), `content_hash` |
| Content | `title`, `body`, `url`, `raw` (verbatim source payload) |
| Time | `occurred_at`, `published_at`, `ingested_at` |
| Place | `lat`, `lon`, `geo_precision`, `place_name`, `country_code`, `grid_cell` |
| Meaning | `category`, `category_confidence`, `embedding vector(384)` |
| Scores | `severity`, `confidence`, `magnitude`, `tone`, `report_count` |
| Progress | `pipeline_stage` (0 inserted → 1 enriched → 2 correlated) |

`pipeline_stage` is what gives crash recovery without a job queue: a worker killed
mid-batch resumes exactly where it stopped.

### `events` — derived clusters

A real-world happening, materialized as a cluster of observations. Mutable: it
accretes observations and its aggregates are recomputed each time.

Key columns: `centroid vector(384)` (running mean of members), `severity`,
`confidence`, `velocity`, weighted `lat`/`lon`, `status`, `observation_count`,
`source_count`.

`event_observations` is the provenance join, carrying the `similarity` score at
assignment time — which is what makes a clustering decision auditable.

### Supporting tables

- `entities` / `observation_entities` / `entity_edges` — the co-occurrence graph.
  Edges store both raw counts and normalized PMI.
- `baselines` — per `(category, grid_cell)` rolling statistics via Welford's
  algorithm. Stores `m2`, not variance, because M2 is the quantity that updates
  incrementally without precision loss.
- `alerts` — anomaly detections, with an explicit `dedup_key`.
- `sources` / `ingest_runs` — connector state, cursors, health, run log.

### Indexes that matter

```sql
-- Clustering hot path: nearest neighbours among recent observations
CREATE INDEX observations_embedding_idx ON observations
  USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);

-- Candidate retrieval for event assignment
CREATE INDEX events_centroid_idx ON events
  USING hnsw (centroid vector_cosine_ops) WITH (m=16, ef_construction=64);

-- Fuzzy entity/title matching
CREATE INDEX entities_name_trgm_idx ON entities USING gin (name gin_trgm_ops);
```

The HNSW indexes are why correlation cost per observation stays roughly constant
as history grows — the index prunes, rather than a sequential scan.

---

## 5. The pipeline

### Stage 1 — Collect

Each connector implements one interface:

```ts
interface SourceDefinition {
  id: string;                     // "gdelt.events"
  name: string; homepage: string; license: string;
  intervalSeconds: number;        // scheduler floor
  minRequestIntervalMs: number;   // per-host rate limit
  requiresEnv?: string[];         // skipped when absent
  emits: EventCategory[];
  fetch(ctx: FetchContext): Promise<FetchResult>;
}
```

Connectors do fetching and normalization only — no geocoding, embedding or
scoring. That separation is what lets enrichment be retuned and replayed without
re-fetching from rate-limited public APIs, and it makes a connector about 150
readable lines.

Adding a source is: write the module, add it to `ALL_CONNECTORS`. No schema
change, no UI change — the sources panel and category matrix are generated from
that array.

**Politeness is in the transport, not each connector.** The shared HTTP client
enforces a per-host serialized queue with a minimum gap, exponential backoff with
jitter, `Retry-After`, conditional requests (`ETag`/`If-Modified-Since` surfacing
304 as data), and a real User-Agent. This matters: GDELT returns HTTP 429 above
one request per five seconds, and `api.weather.gov` rejects generic agents.

### Stage 2 — Enrich

Batched, because the embedding model is far more efficient on batches of 32 than
on 32 single calls, and it dominates pipeline cost.

**Geocoding** runs a strict precedence ladder, recording honestly which rung
answered:

1. Source-supplied coordinates → keep, enrich names by reverse lookup
2. Source `placeHint` → gazetteer forward lookup
3. Place named in the **title** → text scan
4. Place named in the **body lead** → text scan
5. Country name anywhere → country centroid (`precision: 'country'`)
6. Nothing → unlocated

**Classification** is a hybrid: a weighted keyword lexicon (55%) plus cosine
similarity to embedded prototype sentences (45%). Neither alone works — pure
lexicon misses paraphrase, pure embedding scores football reports as
`armed_conflict` because sports writing borrows military vocabulary. The lexical
half is fully inspectable, which matters when a classification looks wrong.

Confidence reflects **margin**, not absolute score: a text scoring 0.6 for both
`armed_conflict` and `terrorism` is genuinely ambiguous and reported as such.

### Stage 3 — Correlate

Online single-pass clustering. A match requires agreement on three axes at once:

| Axis | Gate |
|---|---|
| Semantic | cosine ≥ **0.52** against the event centroid |
| Temporal | ≤ 72 h gap; free inside 6 h, then decaying |
| Spatial | precision-aware distance budget, or same-country when either side is coarse |

Any one axis alone produces obvious errors: semantic-only merges every earthquake
on Earth; temporal-only merges everything that happened on Tuesday.

**Why online rather than DBSCAN/HDBSCAN:** observations arrive continuously and
must appear within seconds; re-clustering the corpus each cycle is quadratic and
cannot hold a 15-minute cadence; and events must keep a **stable identity** — an
analyst watching a crisis cannot have the event id change because a re-clustering
pass redrew boundaries. The cost is order dependence, which is acceptable because
events *are* temporal, and mitigated by principle 4 (rebuild when thresholds
change).

Aggregates are recomputed wholesale per touched event rather than patched
incrementally. Incremental updates to severity, centroid geography and title would
each need their own correctness argument, and any bug would accumulate silently
across an event's life.

### Stage 4 — Detect

Aggregates the last **completed** hour into `(category, grid_cell)` buckets, folds
each into its baseline, and alerts where volume is statistically unusual.

Three conditions must all hold — a reliable baseline (≥12 samples), a z-score
above 3.0, and an absolute volume floor. Each guards a different failure mode of
the other two: without the sample floor the detector fires constantly on startup;
without the volume floor a cell whose baseline is 0.1/hour alerts on one routine
report.

The z-score is computed against the **prior** distribution, before the new value
is folded in — including an observation in its own baseline dilutes exactly the
spike being detected.

---

## 6. Machine learning

Everything runs locally. No API calls, no keys, no data leaving the machine.

| Component | Approach | Why |
|---|---|---|
| Embeddings | `all-MiniLM-L6-v2`, ONNX int8, 384-dim | ~90 MB, thousands of short texts/sec on laptop CPU, mean-pooled + L2-normalized so cosine = dot product |
| Geocoding | GeoNames `cities15000` (34k places) in-process | A hosted geocoder would be the rate limit, the cost centre and a privacy leak at once |
| NER | wink-nlp lite English model | ~1 ms/doc pure JS; a transformer NER is ~100× slower and the pipeline must keep a 15-min cadence |
| Classification | Zero-shot: lexicon + prototype embeddings | No labelled data, no training step, nothing to retrain when the taxonomy changes |
| Clustering | Online, embedding + time + geo gates | See §5 |
| Anomalies | Welford + z-score per (category, cell) | O(1) update, no history scan |
| Summarization | Extractive (MMR over centroid similarity) | An event summary is *evidence*; a generated paraphrase can smooth over source contradictions or invent casualty figures |

### Two findings worth knowing

**Connectors should emit natural language.** The embedding model is trained on
prose, so terse instrument notation lands far from the journalism describing the
same event. Measured against a real BBC report of one earthquake:

| USGS phrasing | cosine to news report |
|---|---|
| `M 7.7 - 68 km NNW of Ende, Indonesia` (native) | **0.387** — below threshold |
| `Magnitude 7.7 earthquake strikes 68 km NNW of Ende, Indonesia` | **0.613** — passes |

That single rewording is the difference between an analyst seeing the seismograph
reading and the casualty report as one event or as two. The USGS and FIRMS
connectors therefore synthesize prose titles and keep the native string in `raw`.

**Country identity beats centroid distance — but only for coarse data.** News
geocodes to a country centroid; instruments give exact coordinates ~1,400 km away.
Distance rejects the pair; "both in Indonesia" is the evidence a human would use.
So same-country short-circuits the distance gate — *but only when at least one
side is coarsely located*. Applied unconditionally it merged seven distinct
Indonesian earthquakes, including one 2,600 km away in Sumatra, because both were
"in ID" and templated GDACS titles embed at cosine 0.99. When both sides are
precise, distance is real information and must win.

---

## 7. The dashboard

### Layout

The globe takes the largest area because spatial pattern is what a globe uniquely
provides. The feed sits immediately right in a fixed column, so one event can be
read as a position *and* as a labelled row without scrolling. The timeline spans
the bottom because time is the axis both others share. The detail panel **overlays**
the rail rather than adding a third column — a third column would shrink the globe
every time an operator opened an event, punishing the primary interaction.

### Colour is computed, not chosen

The palette was machine-validated with a colourblind-separation checker, not
picked by eye. The first attempt **failed**: red↔orange at ΔE 7.1 (normal vision
floor is 15) and violet↔blue at protanopia ΔE 1.9.

**18 categories fold into 5 groups for colour.** No palette gives 18
distinguishable hues; past ~8 colourblind separation collapses entirely. Category
identity is carried by the text label everywhere it appears.

Validated stack order — **this sequence is the safety mechanism, reordering
invalidates it**:

| Slot | Group | Dark | Light |
|---|---|---|---|
| 1 | Governance | `#3987e5` | `#2a78d6` |
| 2 | Security | `#d95926` | `#eb6834` |
| 3 | Human | `#199e70` | `#1baf7a` |
| 4 | Domain | `#9085e9` | `#4a3aa7` |
| 5 | Hazard | `#c98500` | `#eda100` |

Dark: worst adjacent CVD ΔE 9.4, normal-vision ΔE 24.6, all ≥3:1 contrast — all
checks pass. Light: passes, with aqua and yellow below 3:1, so the relief rule
applies (every chart carries a legend *and* direct labels; the feed is a table
view).

**Severity uses the reserved status palette**, not a sequential ramp, because
severity is a *state* rather than an arbitrary magnitude. It always ships with a
text label.

**The globe encodes severity in both colour and size, deliberately redundantly.**
A globe is a scatter plot where any pin can sit beside any other, and no palette
survives all-pairs CVD separation at 5+ hues — so encoding taxonomy in hue would
be unreadable. Encoding severity twice is robust for every viewer.

### Vector globe, not satellite imagery

Flat dark landmasses with hairline borders from a bundled ~100 kB TopoJSON. A
photographic Earth fights the data for attention and needs megabytes of external
imagery. Motion (pulsing rings) is spent only on critical events — it is the
strongest pre-attentive cue available, and ringing everything spends it on nothing.

### Polling, not SSE

The ingest worker is a separate process writing to Postgres, so a push channel
would need `LISTEN/NOTIFY` plumbed through the web tier for data whose fastest
upstream cadence is 15 minutes. A 20-second poll is simpler, survives reconnects
for free, and is never more than one cycle behind.

---

## 8. Operational notes

### Backoff and health

Consecutive failures drive exponential backoff (60 s doubling to a 2-hour ceiling),
persisted in `sources.consecutive_failures` so it survives restarts. A source that
fails never blocks the others — its observations are simply absent that cycle, and
the sources panel says so.

### Keyed sources degrade, never fail

A connector declaring `requiresEnv` is skipped entirely when its key is absent,
and the operator is told why. FIRMS is the only such source today.

### Failure modes and responses

| Symptom | Cause | Response |
|---|---|---|
| Empty globe, sources healthy | Filters too narrow | Widen window / lower severity floor |
| Empty globe, sources failing | Upstream outage or network | Check sources panel; backoff retries automatically |
| Events fragmenting | Similarity threshold too high | Lower `BASE_SIMILARITY_THRESHOLD`, re-derive |
| Unrelated events merging | Threshold too low, or a source with templated titles | Raise threshold, re-derive |
| Pins in the wrong country | Geocoder false positive | Check `geo_precision`; text-scan matches require capitalization + population floor |
| Alerts never fire | Baselines immature | Needs ~12 hourly buckets per (category, cell) |

### Re-deriving after a tuning change

```bash
psql "$DATABASE_URL" -c "TRUNCATE events, event_observations, entities,
  observation_entities, entity_edges, baselines, alerts CASCADE;
  UPDATE observations SET pipeline_stage = 0;"
pnpm ingest:once
```

Observations are preserved; everything derived is rebuilt. If a *connector's* text
changed, also truncate `observations` and reset source cursors, since the raw text
itself is different.

---

## 9. What is not built

Named explicitly so nobody assumes otherwise:

- **No authentication.** Bind to localhost or put it behind a proxy.
- **No write path.** Read-only; alerts cannot yet be acknowledged from the UI.
- **No retention policy.** `observations` grows unbounded; add partitioning by
  `occurred_at` before running this for months.
- **No tests.** The pipeline was validated empirically against live data (see
  `packages/connectors/probe.ts`), which found real bugs, but there is no
  regression suite. The highest-value first tests are: geocoder precedence,
  clustering gates, Welford baselines, and the FIPS crosswalk.
- **Entity graph is stored but not visualized.** The `/api/graph` endpoint and PMI
  ranking exist; the force-directed view does not.
- **English only.** The embedding model, lexicon and NER model are English. Other
  languages will geolocate but classify poorly.
- **GDELT noise passes through.** GDELT's own geocoding sometimes errs (a Texas
  story placed in St. Petersburg). Its synthesized CAMEO titles read like database
  rows, which is why `selectEventTitle` prefers a real news headline when one
  joined the cluster.

---

## 10. Decision log

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| 1 | Postgres + pgvector | SQLite, dedicated vector DB | One store for relational + vector + trigram; HNSW ANN is the clustering hot path |
| 2 | GDELT raw CSV firehose | GDELT DOC/GEO JSON APIs | APIs are hard-throttled (1 req/5 s, blanket 429s on shared IPs); the 15-min CSV drops are static, unlimited, keyless and complete |
| 3 | Local ONNX embeddings | Hosted embedding API | Keeps operation free, removes a hot-path dependency, keeps observation text on the operator's machine |
| 4 | Offline GeoNames gazetteer | Nominatim / hosted geocoder | Would be the rate limit and cost centre; also yields an authoritative FIPS→ISO crosswalk as a side effect |
| 5 | Online clustering | DBSCAN / HDBSCAN batch | Continuous arrival, stable event identity, constant per-observation cost |
| 6 | Single worker process | Job queue (BullMQ/Redis) | A few thousand observations/hour needs one process; `pipeline_stage` gives crash recovery without a broker |
| 7 | Extractive summaries | LLM-generated | Summaries are evidence; generation can smooth over contradictions or invent figures |
| 8 | 5 colour groups for 18 categories | A hue per category | No palette gives 18 separable hues; labels carry exact identity |
| 9 | Two-tier model | Three tiers (raw/normalized/event) | A separate raw tier adds a table and a copy for what `observations.raw` already stores |
| 10 | Source-only workspace packages | Built `dist/` per package | No build graph, no staleness, instant hot reload; reversible |
| 11 | Client polling | SSE / WebSocket | Upstream cadence is 15 min; polling survives reconnects for free |
| 12 | Derive country from coordinates | Hand-maintained FIPS→ISO table | A 250-entry table rots silently; the first version already mislabelled Senegal as Singapore |
