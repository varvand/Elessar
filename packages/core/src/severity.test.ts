import { describe, expect, it } from 'vitest';
import {
  computeConfidence,
  computeSeverity,
  corroborationFactor,
  halfLifeHours,
  intensityFor,
  recencyWeight,
  type ScoreInput,
} from './severity';
import { EVENT_CATEGORIES } from './taxonomy';

const base: ScoreInput = {
  sourceId: 'usgs.quakes',
  category: 'seismic',
  categoryConfidence: 0.9,
  magnitude: 5,
  tone: -0.5,
  reportCount: 1,
  geoPrecision: 'exact',
  sourceCount: 1,
};

describe('intensityFor', () => {
  it('is monotonic in earthquake magnitude', () => {
    const m4 = intensityFor('usgs.quakes', 4);
    const m6 = intensityFor('usgs.quakes', 6);
    const m8 = intensityFor('usgs.quakes', 8);
    expect(m4).toBeLessThan(m6);
    expect(m6).toBeLessThan(m8);
  });

  it('stays within 0..1 at the extremes of every registered curve', () => {
    for (const sourceId of [
      'usgs.quakes',
      'gdelt.events',
      'gdacs.alerts',
      'nws.alerts',
      'firms.fires',
      'nasa.eonet',
    ]) {
      for (const magnitude of [-1000, -10, 0, 1, 10, 1e6]) {
        const value = intensityFor(sourceId, magnitude);
        expect(value, `${sourceId} @ ${magnitude}`).toBeGreaterThanOrEqual(0);
        expect(value, `${sourceId} @ ${magnitude}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reads the Goldstein scale as inverted — conflict is negative', () => {
    // GDELT: -10 is maximally conflictual, +10 maximally cooperative.
    expect(intensityFor('gdelt.events', -10)).toBeGreaterThan(intensityFor('gdelt.events', 0));
    expect(intensityFor('gdelt.events', -10)).toBeGreaterThan(intensityFor('gdelt.events', 10));
  });

  it('does not treat cooperation as nil intensity', () => {
    // A peace treaty is significant even though it is not conflict.
    expect(intensityFor('gdelt.events', 10)).toBeGreaterThan(intensityFor('gdelt.events', 0));
  });

  it('falls back for unknown sources and null magnitudes', () => {
    expect(intensityFor('brand.new.source', 42)).toBeCloseTo(0.4, 5);
    expect(intensityFor('usgs.quakes', null)).toBeCloseTo(0.4, 5);
    expect(intensityFor('usgs.quakes', Number.NaN)).toBeCloseTo(0.4, 5);
  });
});

describe('corroborationFactor', () => {
  it('saturates rather than growing linearly', () => {
    // The jump from 1 source to 5 is far more informative than 50 to 100. A
    // linear term would let one viral story dominate the entire globe.
    expect(corroborationFactor(1)).toBeCloseTo(0, 5);
    expect(corroborationFactor(10)).toBeCloseTo(0.5, 5);
    expect(corroborationFactor(100)).toBeCloseTo(1, 5);
    expect(corroborationFactor(10_000)).toBeLessThanOrEqual(1);
  });

  it('treats null and zero as a single report', () => {
    expect(corroborationFactor(null)).toBe(corroborationFactor(1));
    expect(corroborationFactor(0)).toBe(corroborationFactor(1));
  });
});

describe('computeSeverity', () => {
  it('returns an integer within 0..100 across wildly varied inputs', () => {
    for (const category of EVENT_CATEGORIES) {
      for (const magnitude of [null, -10, 0, 5, 9.5, 1e6]) {
        for (const tone of [null, -1, 0, 1]) {
          const value = computeSeverity({ ...base, category, magnitude, tone });
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('rises with magnitude and with corroboration', () => {
    expect(computeSeverity({ ...base, magnitude: 7.5 })).toBeGreaterThan(
      computeSeverity({ ...base, magnitude: 4 }),
    );
    expect(computeSeverity({ ...base, sourceCount: 20, reportCount: 20 })).toBeGreaterThan(
      computeSeverity(base),
    );
  });

  it('uses only the negative half of tone', () => {
    // Strongly negative coverage is evidence something bad is happening.
    // Strongly positive coverage is not evidence of severity, so it must not
    // inflate the score above the neutral case.
    const negative = computeSeverity({ ...base, tone: -1 });
    const neutral = computeSeverity({ ...base, tone: 0 });
    const positive = computeSeverity({ ...base, tone: 1 });
    expect(negative).toBeGreaterThan(neutral);
    expect(positive).toBeLessThanOrEqual(neutral);
  });

  it('ranks mass-casualty categories above routine ones at equal magnitude', () => {
    const terror = computeSeverity({ ...base, category: 'terrorism' });
    const summit = computeSeverity({ ...base, category: 'diplomacy' });
    expect(terror).toBeGreaterThan(summit);
  });
});

describe('computeConfidence', () => {
  it('falls as geographic precision coarsens', () => {
    const exact = computeConfidence({ ...base, geoPrecision: 'exact' });
    const city = computeConfidence({ ...base, geoPrecision: 'city' });
    const country = computeConfidence({ ...base, geoPrecision: 'country' });
    const unknown = computeConfidence({ ...base, geoPrecision: 'unknown' });
    expect(exact).toBeGreaterThan(city);
    expect(city).toBeGreaterThan(country);
    expect(country).toBeGreaterThan(unknown);
  });

  it('rises with independent corroboration', () => {
    expect(computeConfidence({ ...base, sourceCount: 8 })).toBeGreaterThan(
      computeConfidence({ ...base, sourceCount: 1 }),
    );
  });

  it('stays orthogonal to severity', () => {
    // The whole point of two axes: "high severity, low confidence" must be
    // representable, because it is the most operationally interesting quadrant.
    const scary = { ...base, category: 'terrorism' as const, magnitude: 9 };
    const highSevLowConf = {
      ...scary,
      geoPrecision: 'unknown' as const,
      categoryConfidence: 0.1,
    };
    expect(computeSeverity(highSevLowConf)).toBeGreaterThan(40);
    expect(computeConfidence(highSevLowConf)).toBeLessThan(40);
  });

  it('returns an integer within 0..100', () => {
    for (const precision of ['exact', 'city', 'admin1', 'country', 'unknown'] as const) {
      const value = computeConfidence({ ...base, geoPrecision: precision });
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe('recencyWeight', () => {
  it('is 1 at age zero and halves each half-life', () => {
    expect(recencyWeight('seismic', 0)).toBeCloseTo(1, 6);
    const hl = halfLifeHours('seismic');
    expect(recencyWeight('seismic', hl)).toBeCloseTo(0.5, 6);
    expect(recencyWeight('seismic', hl * 2)).toBeCloseTo(0.25, 6);
  });

  it('REGRESSION: never exceeds 1 for a future timestamp', () => {
    // NWS flood warnings carry a forecast onset up to three days ahead. With a
    // negative age, 0.5^negative AMPLIFIES the score without bound: routine
    // county warnings scored 239 on a 0-100 scale and buried every real event.
    // Decay must only ever reduce.
    for (const ageHours of [-1, -24, -72, -1000]) {
      expect(recencyWeight('severe_weather', ageHours)).toBeLessThanOrEqual(1);
    }
  });

  it('decays monotonically', () => {
    let previous = recencyWeight('armed_conflict', 0);
    for (const age of [1, 6, 24, 96, 240]) {
      const current = recencyWeight('armed_conflict', age);
      expect(current).toBeLessThan(previous);
      previous = current;
    }
  });
});

describe('halfLifeHours', () => {
  it('is positive and finite for every category', () => {
    for (const category of EVENT_CATEGORIES) {
      const hl = halfLifeHours(category);
      expect(hl, category).toBeGreaterThan(0);
      expect(Number.isFinite(hl), category).toBe(true);
    }
  });

  it('REGRESSION: keeps sudden-onset disasters relevant for at least a day', () => {
    // An initial 6-hour seismic half-life — reasoning that ground shaking ends in
    // minutes — pushed a magnitude-7.7 earthquake with 47 deaths and five
    // corroborating sources below routine flood warnings within one day. The
    // half-life measures how long the *situation* matters, not the physical event.
    expect(halfLifeHours('seismic')).toBeGreaterThanOrEqual(24);
    expect(halfLifeHours('severe_weather')).toBeGreaterThanOrEqual(12);
    expect(halfLifeHours('natural_disaster')).toBeGreaterThanOrEqual(24);
  });

  it('gives slow-burning humanitarian situations a longer life than acute hazards', () => {
    expect(halfLifeHours('humanitarian')).toBeGreaterThan(halfLifeHours('seismic'));
  });
});
