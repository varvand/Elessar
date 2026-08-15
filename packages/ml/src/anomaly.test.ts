import { describe, expect, it } from 'vitest';
import {
  DEFAULT_Z_THRESHOLD,
  alertDedupKey,
  describeAnomaly,
  detectAnomaly,
  standardDeviation,
  updateBaseline,
  type BaselineState,
} from './anomaly';

const EMPTY: BaselineState = { sampleCount: 0, mean: 0, m2: 0 };

/** Fold a series through the online updater, returning the final state. */
function foldAll(values: number[], from: BaselineState = EMPTY): BaselineState {
  let state = from;
  for (const value of values) {
    const next = updateBaseline(state, value);
    state = { sampleCount: next.sampleCount, mean: next.mean, m2: next.m2 };
  }
  return state;
}

describe("Welford's online algorithm", () => {
  it('REGRESSION: matches the naive mean and sample variance', () => {
    // Baselines update in O(1) per bucket with no history scan, which is what
    // makes anomaly detection affordable to run forever. If the incremental
    // maths drifts, "normal" drifts with it and the detector goes quietly blind.
    const values = [4, 8, 15, 16, 23, 42, 7, 9, 12, 3];
    const state = foldAll(values);

    const naiveMean = values.reduce((a, b) => a + b, 0) / values.length;
    const naiveVariance =
      values.reduce((sum, v) => sum + (v - naiveMean) ** 2, 0) / (values.length - 1);

    expect(state.sampleCount).toBe(values.length);
    expect(state.mean).toBeCloseTo(naiveMean, 6);
    expect(standardDeviation(state)).toBeCloseTo(Math.sqrt(naiveVariance), 6);
  });

  it('reports zero deviation for constant input', () => {
    expect(standardDeviation(foldAll([5, 5, 5, 5, 5]))).toBeCloseTo(0, 10);
  });

  it('reports zero deviation with fewer than two samples', () => {
    expect(standardDeviation(EMPTY)).toBe(0);
    expect(standardDeviation(foldAll([7]))).toBe(0);
  });

  it('is numerically stable for large values', () => {
    // The naive "sum of squares minus square of sum" formula loses all precision
    // here; Welford does not.
    const state = foldAll([1e6 + 4, 1e6 + 7, 1e6 + 13, 1e6 + 16]);
    expect(standardDeviation(state)).toBeGreaterThan(0);
    expect(Number.isFinite(standardDeviation(state))).toBe(true);
  });
});

describe('z-score', () => {
  it('REGRESSION: is computed against the PRIOR distribution', () => {
    // Including the new observation in its own baseline dilutes exactly the spike
    // being detected — a large value drags the mean toward itself and understates
    // its own deviation.
    const prior = foldAll(Array.from({ length: 20 }, () => 5));
    const spike = updateBaseline({ ...prior }, 50);

    // Against the prior (mean 5, sd 0) this is a clear excursion. The updated
    // state must differ from the prior, proving the new value was not used.
    expect(spike.mean).toBeGreaterThan(prior.mean);
    expect(spike.sampleCount).toBe(prior.sampleCount + 1);

    // With variance, the z-score reflects the prior spread, not the post spread.
    const varied = foldAll([4, 5, 6, 5, 4, 6, 5, 5, 4, 6, 5, 5, 6, 4]);
    const priorSd = standardDeviation(varied);
    const result = updateBaseline(varied, 30);
    expect(result.zScore).toBeCloseTo((30 - varied.mean) / priorSd, 6);
  });

  it('is zero when there is not enough history to have a spread', () => {
    expect(updateBaseline(EMPTY, 100).zScore).toBe(0);
    expect(updateBaseline(foldAll([5]), 100).zScore).toBe(0);
  });

  it('is negative for an unusually quiet bucket', () => {
    const state = foldAll([10, 12, 11, 9, 10, 11, 10, 12, 9, 11]);
    expect(updateBaseline(state, 1).zScore).toBeLessThan(0);
  });
});

describe('detectAnomaly', () => {
  /** A baseline with enough samples and a real spread. */
  const mature = foldAll([
    4, 6, 5, 5, 4, 6, 5, 5, 6, 4, 5, 5, 6, 4, 5, 6, 4, 5, 5, 6,
  ]);

  it('fires on a genuine spike', () => {
    const update = updateBaseline(mature, 40);
    const signal = detectAnomaly('armed_conflict', '5:24:38', 40, update);
    expect(signal).not.toBeNull();
    expect(signal!.zScore).toBeGreaterThan(DEFAULT_Z_THRESHOLD);
    expect(signal!.severity).toBeGreaterThan(0);
    expect(signal!.severity).toBeLessThanOrEqual(100);
  });

  it('REGRESSION: stays silent while the baseline is immature', () => {
    // Below ~12 samples the variance estimate is noise, and the detector fires
    // constantly on startup — which trains an operator to ignore it, the worst
    // possible outcome for an alerting system.
    const young = foldAll([5, 5, 5]);
    const update = updateBaseline(young, 500);
    expect(detectAnomaly('armed_conflict', '5:24:38', 500, update)).toBeNull();
  });

  it('REGRESSION: respects an absolute volume floor', () => {
    // A cell whose baseline is ~0.1 observations per hour produces an enormous
    // z-score from a single routine report. Statistically unusual, operationally
    // meaningless.
    const sparse = foldAll(Array.from({ length: 30 }, (_, i) => (i % 10 === 0 ? 1 : 0)));
    const update = updateBaseline(sparse, 2);
    expect(detectAnomaly('cyber', '5:10:10', 2, update)).toBeNull();
  });

  it('stays silent below the z-threshold', () => {
    const update = updateBaseline(mature, 7);
    expect(detectAnomaly('cyber', '5:10:10', 7, update)).toBeNull();
  });

  it('honours an overridden threshold', () => {
    const update = updateBaseline(mature, 8);
    expect(detectAnomaly('cyber', '5:10:10', 8, update, { zThreshold: 1 })).not.toBeNull();
    expect(detectAnomaly('cyber', '5:10:10', 8, update, { zThreshold: 50 })).toBeNull();
  });

  it('saturates severity so one freak bucket cannot dominate the board', () => {
    const modest = detectAnomaly('cyber', '5:10:10', 40, updateBaseline(mature, 40));
    const absurd = detectAnomaly('cyber', '5:10:10', 100_000, updateBaseline(mature, 100_000));
    expect(absurd!.severity).toBeLessThanOrEqual(100);
    expect(absurd!.severity - modest!.severity).toBeLessThan(60);
  });
});

describe('alertDedupKey', () => {
  it('REGRESSION: is stable within an hour, so a retried run cannot double-fire', () => {
    const a = alertDedupKey('volume_spike', 'seismic', '5:24:38', new Date('2026-08-15T19:14:00Z'));
    const b = alertDedupKey('volume_spike', 'seismic', '5:24:38', new Date('2026-08-15T19:47:00Z'));
    expect(a).toBe(b);
  });

  it('differs across hours, categories and cells', () => {
    const base = alertDedupKey('volume_spike', 'seismic', '5:24:38', new Date('2026-08-15T19:00:00Z'));
    expect(base).not.toBe(
      alertDedupKey('volume_spike', 'seismic', '5:24:38', new Date('2026-08-15T20:00:00Z')),
    );
    expect(base).not.toBe(
      alertDedupKey('volume_spike', 'cyber', '5:24:38', new Date('2026-08-15T19:00:00Z')),
    );
    expect(base).not.toBe(
      alertDedupKey('volume_spike', 'seismic', '5:24:39', new Date('2026-08-15T19:00:00Z')),
    );
    expect(base).not.toBe(
      alertDedupKey('severity_spike', 'seismic', '5:24:38', new Date('2026-08-15T19:00:00Z')),
    );
  });

  it('does not mutate the date it is given', () => {
    const bucket = new Date('2026-08-15T19:47:00Z');
    alertDedupKey('volume_spike', 'seismic', '5:24:38', bucket);
    expect(bucket.toISOString()).toBe('2026-08-15T19:47:00.000Z');
  });
});

describe('describeAnomaly', () => {
  it('states observed, expected and sigma so the alert is checkable', () => {
    const { title, detail } = describeAnomaly(
      {
        category: 'armed_conflict',
        gridCell: '5:24:38',
        observed: 40,
        expected: 5,
        zScore: 7.2,
        severity: 80,
      },
      'Beirut',
    );
    expect(title).toContain('Beirut');
    expect(title).toContain('armed conflict'); // underscores humanized
    expect(detail).toContain('40');
    expect(detail).toContain('5.0');
    expect(detail).toContain('7.2');
  });

  it('falls back to the cell id when no place name resolved', () => {
    const { title } = describeAnomaly(
      { category: 'cyber', gridCell: '5:24:38', observed: 9, expected: 1, zScore: 4, severity: 50 },
      null,
    );
    expect(title).toContain('5:24:38');
  });
});
