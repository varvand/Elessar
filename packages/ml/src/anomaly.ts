import type { EventCategory } from '@elessar/core';

/**
 * Volume anomaly detection.
 *
 * The point: "a lot is happening in region X" is not interesting on its own —
 * a lot always happens in populated, heavily-reported regions. What is
 * interesting is *more than usual for that region and that category*. Detecting
 * that requires a per-(category, cell) baseline of what normal looks like.
 *
 * Baselines are maintained with Welford's online algorithm, so mean and variance
 * update in O(1) per bucket from the stored accumulator alone — no history scan,
 * no re-aggregation. That is what makes this affordable to run every cycle
 * forever, and it is why `baselines` stores `m2` rather than a variance: variance
 * cannot be updated incrementally without losing precision, but M2 can.
 */

export interface BaselineState {
  sampleCount: number;
  mean: number;
  /** Welford's sum of squared deviations from the running mean. */
  m2: number;
}

export interface BaselineUpdate extends BaselineState {
  /** Standard deviations above the mean this observation was. */
  zScore: number;
  /** Whether the baseline had enough samples for the z-score to mean anything. */
  reliable: boolean;
}

/**
 * Minimum buckets before a z-score is trusted.
 *
 * With fewer than this, the variance estimate is dominated by noise and the
 * detector fires constantly on startup — which would train an operator to ignore
 * it, the worst possible outcome for an alerting system.
 */
const MIN_SAMPLES_FOR_ALERT = 12;

/** Alert threshold in standard deviations. */
export const DEFAULT_Z_THRESHOLD = 3.0;

/**
 * Fold one bucket's observed count into a baseline.
 *
 * Note the ordering: the z-score is computed against the *prior* distribution,
 * before the new value is folded in. Including the observation in its own
 * baseline dilutes exactly the spike we are trying to detect.
 */
export function updateBaseline(state: BaselineState, observed: number): BaselineUpdate {
  const priorStdDev = standardDeviation(state);
  const zScore =
    state.sampleCount >= 2 && priorStdDev > 0
      ? (observed - state.mean) / priorStdDev
      : 0;

  // Welford's online update.
  const count = state.sampleCount + 1;
  const delta = observed - state.mean;
  const mean = state.mean + delta / count;
  const m2 = state.m2 + delta * (observed - mean);

  return {
    sampleCount: count,
    mean,
    m2,
    zScore,
    reliable: state.sampleCount >= MIN_SAMPLES_FOR_ALERT,
  };
}

export function standardDeviation(state: BaselineState): number {
  if (state.sampleCount < 2) return 0;
  const variance = state.m2 / (state.sampleCount - 1);
  return variance > 0 ? Math.sqrt(variance) : 0;
}

export interface AnomalySignal {
  category: EventCategory;
  gridCell: string;
  observed: number;
  expected: number;
  zScore: number;
  /** 0..100, for ranking alerts against events. */
  severity: number;
}

export interface DetectOptions {
  zThreshold?: number;
  /**
   * Absolute floor on observed count. Without it, a cell whose baseline is 0.1
   * observations per bucket fires an alert on a single routine report — the
   * z-score is enormous but the event is meaningless.
   */
  minObserved?: number;
}

/**
 * Decide whether a bucket's count is anomalous.
 *
 * Requires all three: a reliable baseline, a z-score above threshold, and an
 * absolute volume worth an analyst's attention. Each guards a different failure
 * mode of the other two.
 */
export function detectAnomaly(
  category: EventCategory,
  gridCell: string,
  observed: number,
  update: BaselineUpdate,
  options: DetectOptions = {},
): AnomalySignal | null {
  const zThreshold = options.zThreshold ?? DEFAULT_Z_THRESHOLD;
  const minObserved = options.minObserved ?? 4;

  if (!update.reliable) return null;
  if (observed < minObserved) return null;
  if (update.zScore < zThreshold) return null;

  // Severity climbs with the z-score but saturates: 3σ and 30σ are both
  // "unusual", and a linear scale would let one freak bucket dominate the board.
  const severity = Math.round(
    Math.min(100, 45 + 55 * (1 - Math.exp(-(update.zScore - zThreshold) / 4))),
  );

  return {
    category,
    gridCell,
    observed,
    expected: update.mean,
    zScore: update.zScore,
    severity,
  };
}

/**
 * Stable idempotency key for an alert.
 *
 * Matches `alerts.dedup_key`, so re-running a bucket after a crash updates
 * rather than duplicating. The bucket timestamp is truncated to the hour because
 * that is the aggregation granularity — a finer key would let the same spike
 * alert twice.
 */
export function alertDedupKey(
  kind: string,
  category: string,
  gridCell: string,
  bucketAt: Date,
): string {
  const hour = new Date(bucketAt);
  hour.setUTCMinutes(0, 0, 0);
  return `${kind}:${category}:${gridCell}:${hour.toISOString()}`;
}

/** Human-readable alert text. */
export function describeAnomaly(signal: AnomalySignal, placeName: string | null): {
  title: string;
  detail: string;
} {
  const where = placeName ?? `grid cell ${signal.gridCell}`;
  const multiple = signal.expected > 0 ? (signal.observed / signal.expected).toFixed(1) : '∞';

  return {
    title: `Unusual ${signal.category.replace(/_/g, ' ')} activity — ${where}`,
    detail:
      `${signal.observed} observations in the last hour against a baseline of ` +
      `${signal.expected.toFixed(1)} (${multiple}×, ${signal.zScore.toFixed(1)}σ above normal).`,
  };
}
