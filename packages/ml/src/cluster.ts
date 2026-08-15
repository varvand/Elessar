import {
  PRECISION_RADIUS_KM,
  cosineSimilarity,
  haversineKm,
  hoursBetween,
  type EventCategory,
  type GeoPoint,
  type GeoPrecision,
} from '@elessar/core';

/**
 * Incremental story clustering.
 *
 * This is the step that turns a firehose of observations into events — the
 * difference between a news reader and a situational-awareness tool. Eighty
 * separate reports of one earthquake should be one pin on the globe with eighty
 * sources behind it, not eighty pins.
 *
 * Why online single-pass clustering rather than DBSCAN/HDBSCAN:
 *
 *   - Observations arrive continuously and must appear on the globe within
 *     seconds. Re-clustering the whole corpus every cycle is O(n²) in distance
 *     computations and cannot hold a 15-minute cadence as history accumulates.
 *   - Events are long-lived and must keep a stable identity. An analyst watching
 *     an unfolding crisis cannot have the event's id change because a
 *     re-clustering pass redrew the boundaries.
 *   - Candidate retrieval is a pgvector HNSW query over a bounded time window,
 *     so the cost per observation is roughly constant regardless of total volume.
 *
 * The tradeoff is order dependence: the clusters you get depend on arrival order,
 * and a genuinely better global partition may exist. That is acceptable because
 * events *are* temporal — and it is why `events` is treated as derived state that
 * can be dropped and rebuilt when thresholds change.
 *
 * A match requires agreement on three axes at once — semantic, temporal and
 * spatial. Any one alone produces obvious errors: semantic-only merges every
 * earthquake on earth into one event; temporal-only merges everything that
 * happened on Tuesday.
 */

/**
 * Similarity floor for joining an event.
 *
 * Calibrated empirically rather than guessed: with all-MiniLM-L6-v2, two
 * independently written headlines about the *same* earthquake score ≈0.61, while
 * an unrelated finance headline scores ≈0.01. 0.52 sits below the same-event
 * figure with margin for terser or noisier headlines, and far above the
 * unrelated-topic floor.
 *
 * Raising this fragments events; lowering it merges distinct ones. It is the
 * single most consequential number in the pipeline.
 */
export const BASE_SIMILARITY_THRESHOLD = 0.52;

/** Observations further apart in time than this never join, whatever else matches. */
const MAX_TIME_GAP_HOURS = 72;

/**
 * Precisions too coarse for distance between two points to carry real meaning.
 * For these, country identity is the better spatial signal (see `spatialFactor`).
 */
const COARSE_PRECISIONS = new Set<GeoPrecision>(['country', 'admin1', 'unknown']);

/**
 * Within this window, time is treated as free. Reports of one event trickle in
 * over hours as outlets pick it up, so penalizing a 4-hour gap would split the
 * coverage of a single incident.
 */
const FREE_TIME_WINDOW_HOURS = 6;

export interface ClusterCandidate {
  eventId: string;
  centroid: readonly number[];
  category: EventCategory;
  lat: number | null;
  lon: number | null;
  geoPrecision: GeoPrecision;
  countryCode: string | null;
  lastSeenAt: Date;
  firstSeenAt: Date;
  observationCount: number;
}

export interface ClusterSubject {
  embedding: readonly number[];
  category: EventCategory;
  point: GeoPoint | null;
  geoPrecision: GeoPrecision;
  countryCode: string | null;
  occurredAt: Date;
}

export interface MatchResult {
  eventId: string;
  similarity: number;
  /** Score after temporal and spatial adjustment; what the decision used. */
  score: number;
}

/**
 * Time penalty, applied multiplicatively.
 *
 * Flat inside the free window, then decaying smoothly. Smooth rather than
 * stepped so a report arriving at hour 6.1 is not treated categorically
 * differently from one at hour 5.9.
 */
function timeFactor(gapHours: number): number {
  if (gapHours <= FREE_TIME_WINDOW_HOURS) return 1;
  const excess = gapHours - FREE_TIME_WINDOW_HOURS;
  const span = MAX_TIME_GAP_HOURS - FREE_TIME_WINDOW_HOURS;
  return Math.max(0, 1 - 0.45 * (excess / span));
}

/**
 * Spatial compatibility, applied multiplicatively.
 *
 * The distance budget is the sum of both parties' precision radii, so a
 * country-centroid observation can still join a city-precision event — they may
 * genuinely describe the same place, and refusing the merge would strand coarse
 * GDELT rows as singleton events.
 *
 * Unlocated observations are neither rewarded nor blocked: they get a mild
 * penalty, since without geography we have less evidence, not contrary evidence.
 */
function spatialFactor(subject: ClusterSubject, candidate: ClusterCandidate): number {
  // Agreeing on the country substitutes for distance — but only when at least
  // one side lacks precise coordinates.
  //
  // This is what makes cross-source correlation work. A news article headlined
  // "…in Indonesia" geocodes to Indonesia's centroid, while USGS reports the
  // same earthquake with exact coordinates ~1,400 km away on Flores. Judged on
  // centroid distance the pair is rejected and the story never joins the
  // instrument reading, yet "both in Indonesia" is exactly the shared evidence a
  // human would reason from.
  //
  // The precision guard is essential and was learned the hard way: applying this
  // unconditionally merged seven distinct Indonesian earthquakes — including one
  // 2,600 km away in Sumatra — into a single event, because both sides were
  // "in ID" and their templated GDACS titles embed at cosine 0.99. When both
  // sides are precisely located, distance is real information and country
  // identity adds nothing, so it must not be allowed to override it.
  const eitherSideIsCoarse =
    COARSE_PRECISIONS.has(subject.geoPrecision) || COARSE_PRECISIONS.has(candidate.geoPrecision);

  if (
    eitherSideIsCoarse &&
    subject.countryCode &&
    candidate.countryCode &&
    subject.countryCode === candidate.countryCode
  ) {
    // Below 1: same-country is good evidence, not proof of the same place.
    return 0.95;
  }

  if (!subject.point || candidate.lat === null || candidate.lon === null) {
    return 0.85;
  }

  // Different, known countries: the events are genuinely elsewhere. Distance
  // still decides, but a confirmed country mismatch is a real signal.
  const countryMismatch =
    subject.countryCode !== null &&
    candidate.countryCode !== null &&
    subject.countryCode !== candidate.countryCode;

  const budgetKm =
    PRECISION_RADIUS_KM[subject.geoPrecision] + PRECISION_RADIUS_KM[candidate.geoPrecision];

  const distanceKm = haversineKm(subject.point, {
    lat: candidate.lat,
    lon: candidate.lon,
  });

  if (distanceKm <= budgetKm) return countryMismatch ? 0.7 : 1;

  // Beyond the budget, decay rather than hard-reject: a story about a treaty
  // signed in Geneva concerning Sudan legitimately spans large distances, and
  // strong semantic agreement should be able to overcome moderate separation.
  const overshoot = distanceKm / budgetKm;
  const decayed = Math.max(0, 1 / overshoot ** 1.5);
  return countryMismatch ? decayed * 0.7 : decayed;
}

/**
 * Choose the best event for an observation, or null to start a new one.
 *
 * Candidates come from a pgvector ANN query, so this function only has to
 * re-rank a small set with the signals the vector index cannot express.
 */
export function findBestCluster(
  subject: ClusterSubject,
  candidates: ClusterCandidate[],
  threshold = BASE_SIMILARITY_THRESHOLD,
): MatchResult | null {
  let best: MatchResult | null = null;

  for (const candidate of candidates) {
    const gapHours = hoursBetween(subject.occurredAt, candidate.lastSeenAt);
    if (gapHours > MAX_TIME_GAP_HOURS) continue;

    const similarity = cosineSimilarity(subject.embedding, candidate.centroid);
    // Cheap early exit: adjustments only ever reduce the score, so anything
    // already below threshold cannot pass.
    if (similarity < threshold) continue;

    let score = similarity * timeFactor(gapHours) * spatialFactor(subject, candidate);

    // Same-category agreement is corroborating evidence; a mismatch is a mild
    // warning, not a veto, because the classifier is itself fallible.
    score *= subject.category === candidate.category ? 1 : 0.8;

    if (score >= threshold && (!best || score > best.score)) {
      best = { eventId: candidate.eventId, similarity, score };
    }
  }

  return best;
}

/**
 * Rate of change in an event's observation arrivals.
 *
 * Returns the ratio of recent arrival rate to the event's lifetime average.
 * Above 1 means accelerating — the signal an analyst most wants surfaced, since
 * a crisis intensifying is more actionable than one merely large.
 */
export function computeVelocity(
  firstSeenAt: Date,
  lastSeenAt: Date,
  observationCount: number,
  recentCount: number,
  recentWindowHours = 3,
): number {
  const lifetimeHours = Math.max(hoursBetween(firstSeenAt, lastSeenAt), 0.25);
  const lifetimeRate = observationCount / lifetimeHours;
  if (lifetimeRate <= 0) return 0;

  const recentRate = recentCount / recentWindowHours;
  return Math.min(10, recentRate / lifetimeRate);
}

/**
 * Event lifecycle status, derived from recency and momentum.
 *
 * Derived rather than stored-and-mutated so it can never go stale: an event that
 * stops receiving observations becomes dormant by the passage of time alone,
 * with no sweeper job required.
 */
export function deriveStatus(
  lastSeenAt: Date,
  velocity: number,
  now: Date = new Date(),
): 'active' | 'developing' | 'dormant' | 'closed' {
  const ageHours = hoursBetween(lastSeenAt, now);

  if (ageHours > 168) return 'closed';
  if (ageHours > 24) return 'dormant';
  if (velocity > 1.3 && ageHours < 6) return 'developing';
  return 'active';
}
