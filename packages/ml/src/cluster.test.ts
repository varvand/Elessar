import { describe, expect, it } from 'vitest';
import {
  BASE_SIMILARITY_THRESHOLD,
  computeVelocity,
  deriveStatus,
  findBestCluster,
  type ClusterCandidate,
  type ClusterSubject,
} from './cluster';

/**
 * Clustering is the feature that distinguishes this from a news reader, and the
 * gates below are the highest-leverage tuning in the whole system: too tight and
 * events fragment into hundreds of near-duplicates, too loose and unrelated
 * events merge into nonsense.
 *
 * Synthetic unit vectors are used rather than real embeddings, so these tests are
 * fast, deterministic, and independent of the model.
 */

const DIM = 8;

/** Unit vector whose cosine to `unit(0)` is controllable. */
function unit(angleRadians: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = Math.cos(angleRadians);
  v[1] = Math.sin(angleRadians);
  return v;
}

/** A vector at a known cosine similarity to `unit(0)`. */
function atSimilarity(cos: number): number[] {
  return unit(Math.acos(Math.min(1, Math.max(-1, cos))));
}

const NOW = new Date('2026-08-15T12:00:00Z');

function subject(overrides: Partial<ClusterSubject> = {}): ClusterSubject {
  return {
    embedding: unit(0),
    category: 'seismic',
    point: { lat: -8.31, lon: 121.35 },
    geoPrecision: 'exact',
    countryCode: 'ID',
    occurredAt: NOW,
    ...overrides,
  };
}

function candidate(overrides: Partial<ClusterCandidate> = {}): ClusterCandidate {
  return {
    eventId: 'event-1',
    centroid: unit(0),
    category: 'seismic',
    lat: -8.31,
    lon: 121.35,
    geoPrecision: 'exact',
    countryCode: 'ID',
    lastSeenAt: NOW,
    firstSeenAt: NOW,
    observationCount: 1,
    ...overrides,
  };
}

describe('semantic gate', () => {
  it('matches a near-identical observation', () => {
    expect(findBestCluster(subject(), [candidate()])).not.toBeNull();
  });

  it('rejects an unrelated observation', () => {
    const match = findBestCluster(
      subject({ embedding: atSimilarity(0.05) }),
      [candidate()],
    );
    expect(match).toBeNull();
  });

  it('rejects just below the threshold and accepts comfortably above it', () => {
    expect(
      findBestCluster(subject({ embedding: atSimilarity(BASE_SIMILARITY_THRESHOLD - 0.1) }), [
        candidate(),
      ]),
    ).toBeNull();
    expect(
      findBestCluster(subject({ embedding: atSimilarity(0.95) }), [candidate()]),
    ).not.toBeNull();
  });

  it('reports the raw similarity alongside the adjusted score', () => {
    // The UI shows `similarity` so a clustering decision is auditable; it must be
    // the unmodified cosine, not the score after time and space adjustment.
    const match = findBestCluster(subject({ embedding: atSimilarity(0.9) }), [candidate()]);
    expect(match!.similarity).toBeCloseTo(0.9, 5);
    expect(match!.score).toBeLessThanOrEqual(match!.similarity);
  });

  it('picks the best candidate when several qualify', () => {
    const match = findBestCluster(subject(), [
      candidate({ eventId: 'weak', centroid: atSimilarity(0.6) }),
      candidate({ eventId: 'strong', centroid: atSimilarity(0.99) }),
    ]);
    expect(match!.eventId).toBe('strong');
  });

  it('returns null when there are no candidates', () => {
    expect(findBestCluster(subject(), [])).toBeNull();
  });
});

describe('temporal gate', () => {
  it('accepts reports trickling in over hours', () => {
    // Outlets pick a story up over a whole day; penalizing that splits coverage.
    const sixHoursLater = new Date(NOW.getTime() + 6 * 3600_000);
    expect(
      findBestCluster(subject({ occurredAt: sixHoursLater }), [candidate()]),
    ).not.toBeNull();
  });

  it('rejects anything beyond the 72-hour window outright', () => {
    const wayLater = new Date(NOW.getTime() + 100 * 3600_000);
    expect(findBestCluster(subject({ occurredAt: wayLater }), [candidate()])).toBeNull();
  });

  it('is symmetric about which side is older', () => {
    const earlier = new Date(NOW.getTime() - 100 * 3600_000);
    expect(findBestCluster(subject({ occurredAt: earlier }), [candidate()])).toBeNull();
  });
});

describe('spatial gate', () => {
  it('REGRESSION: keeps two precisely-located events 2,600 km apart separate', () => {
    // The self-inflicted bug. A same-country shortcut applied unconditionally
    // merged seven distinct Indonesian earthquakes — including one in Sumatra,
    // 2,600 km from Flores — because both were "in ID" and GDACS's templated
    // titles embed at cosine 0.99. When both sides are precisely located,
    // distance is real information and must not be overridden.
    const sumatra = subject({
      embedding: atSimilarity(0.99),
      point: { lat: 3.09, lon: 99.02 },
      geoPrecision: 'exact',
      countryCode: 'ID',
    });
    const flores = candidate({
      lat: -8.31,
      lon: 121.35,
      geoPrecision: 'exact',
      countryCode: 'ID',
    });
    expect(findBestCluster(sumatra, [flores])).toBeNull();
  });

  it('REGRESSION: lets a country-precision news report join an exact instrument reading', () => {
    // The cross-source capability. A news article headlined "…in Indonesia"
    // geocodes to the national centroid ~1,400 km from the epicentre. Judged on
    // distance alone the pair is rejected and the casualty report never joins the
    // seismograph reading — yet "both in Indonesia" is the shared evidence.
    const newsReport = subject({
      embedding: atSimilarity(0.7),
      point: { lat: -4.76, lon: 109.58 }, // Indonesia centroid
      geoPrecision: 'country',
      countryCode: 'ID',
    });
    const instrumentEvent = candidate({
      centroid: unit(0),
      lat: -8.31,
      lon: 121.35,
      geoPrecision: 'exact',
      countryCode: 'ID',
    });
    expect(findBestCluster(newsReport, [instrumentEvent])).not.toBeNull();
  });

  it('does not merge coarse observations from different countries', () => {
    const inKenya = subject({
      embedding: atSimilarity(0.8),
      point: { lat: -1.28, lon: 36.82 },
      geoPrecision: 'country',
      countryCode: 'KE',
    });
    const inIndonesia = candidate({ geoPrecision: 'country', countryCode: 'ID' });
    expect(findBestCluster(inKenya, [inIndonesia])).toBeNull();
  });

  it('merges two exact observations at essentially the same spot', () => {
    const nearby = subject({ point: { lat: -8.315, lon: 121.36 } });
    expect(findBestCluster(nearby, [candidate()])).not.toBeNull();
  });

  it('tolerates an unlocated observation without rewarding it', () => {
    // Missing geography is less evidence, not contrary evidence.
    const unlocated = subject({ point: null, geoPrecision: 'unknown', countryCode: null });
    expect(findBestCluster(unlocated, [candidate()])).not.toBeNull();
  });
});

describe('category agreement', () => {
  it('penalizes a mismatch without vetoing it', () => {
    // The classifier is itself fallible, so disagreement is a warning not a veto.
    const strong = findBestCluster(subject({ embedding: atSimilarity(0.98) }), [
      candidate({ category: 'armed_conflict' }),
    ]);
    expect(strong).not.toBeNull();

    const marginal = findBestCluster(subject({ embedding: atSimilarity(0.6) }), [
      candidate({ category: 'armed_conflict' }),
    ]);
    const matching = findBestCluster(subject({ embedding: atSimilarity(0.6) }), [candidate()]);
    expect(matching!.score).toBeGreaterThan(marginal?.score ?? 0);
  });
});

describe('computeVelocity', () => {
  it('is above 1 when arrivals are accelerating', () => {
    const first = new Date(NOW.getTime() - 24 * 3600_000);
    // 20 observations over 24h (0.83/h), 15 of them in the last 3h (5/h).
    expect(computeVelocity(first, NOW, 20, 15)).toBeGreaterThan(1);
  });

  it('is below 1 when arrivals have tailed off', () => {
    const first = new Date(NOW.getTime() - 24 * 3600_000);
    expect(computeVelocity(first, NOW, 20, 0)).toBeLessThan(1);
  });

  it('is bounded and finite for degenerate inputs', () => {
    expect(computeVelocity(NOW, NOW, 0, 0)).toBe(0);
    expect(computeVelocity(NOW, NOW, 1, 1)).toBeLessThanOrEqual(10);
    expect(Number.isFinite(computeVelocity(NOW, NOW, 1000, 1000))).toBe(true);
  });
});

describe('deriveStatus', () => {
  it('derives the lifecycle from recency and momentum', () => {
    const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000);
    expect(deriveStatus(at(0.5), 2.0, NOW)).toBe('developing');
    expect(deriveStatus(at(0.5), 0.5, NOW)).toBe('active');
    expect(deriveStatus(at(48), 0.5, NOW)).toBe('dormant');
    expect(deriveStatus(at(200), 0.5, NOW)).toBe('closed');
  });

  it('lets an event go dormant by the passage of time alone', () => {
    // Status is derived rather than stored, so no sweeper job is needed and it
    // can never go stale.
    const lastSeen = new Date(NOW.getTime() - 1 * 3600_000);
    expect(deriveStatus(lastSeen, 0.5, NOW)).toBe('active');
    const muchLater = new Date(NOW.getTime() + 48 * 3600_000);
    expect(deriveStatus(lastSeen, 0.5, muchLater)).toBe('dormant');
  });
});
