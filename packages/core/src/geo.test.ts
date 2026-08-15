import { describe, expect, it } from 'vitest';
import { centroid, geoCompatible, gridCell, haversineKm, normalizePoint } from './geo';

describe('normalizePoint', () => {
  it('accepts numbers and numeric strings alike', () => {
    // Feeds supply coordinates as both; JSON APIs give numbers, CSV gives strings.
    expect(normalizePoint(52.52, 13.405)).toEqual({ lat: 52.52, lon: 13.405 });
    expect(normalizePoint('52.52', '13.405')).toEqual({ lat: 52.52, lon: 13.405 });
  });

  it('REGRESSION: rejects exactly 0,0', () => {
    // GDELT and several RSS geotags emit 0,0 to mean "unknown". Taken literally
    // it is a real point in the Gulf of Guinea, and every unlocated event in the
    // feed piles up there as a phantom cluster off the coast of Africa.
    expect(normalizePoint(0, 0)).toBeNull();
  });

  it('keeps genuine points that have one zero component', () => {
    // Only the exact pair is the sentinel; the equator and prime meridian are real.
    expect(normalizePoint(0, 12.5)).toEqual({ lat: 0, lon: 12.5 });
    expect(normalizePoint(51.5, 0)).toEqual({ lat: 51.5, lon: 0 });
  });

  it('rejects out-of-range latitude rather than clamping it', () => {
    // A latitude of 91 means the source is wrong or the columns are transposed.
    // Clamping would invent a plausible-looking pole pin and hide the bug.
    expect(normalizePoint(91, 0)).toBeNull();
    expect(normalizePoint(-90.1, 0)).toBeNull();
  });

  it('wraps longitude instead of rejecting it', () => {
    // Longitude is genuinely cyclic, so 181 is unambiguous where latitude 91 is not.
    expect(normalizePoint(0, 181)?.lon).toBeCloseTo(-179, 6);
    expect(normalizePoint(0, -181)?.lon).toBeCloseTo(179, 6);
  });

  it('rejects non-finite and non-numeric input', () => {
    expect(normalizePoint(Number.NaN, 5)).toBeNull();
    expect(normalizePoint(Number.POSITIVE_INFINITY, 5)).toBeNull();
    expect(normalizePoint(undefined, 5)).toBeNull();
    expect(normalizePoint('not-a-number', '5')).toBeNull();
  });
});

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm({ lat: 10, lon: 20 }, { lat: 10, lon: 20 })).toBe(0);
  });

  it('matches known great-circle distances', () => {
    // London → Paris is ~344 km; Berlin → Tokyo ~8,900 km.
    expect(haversineKm({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 })).toBeCloseTo(
      344,
      -1,
    );
    expect(haversineKm({ lat: 52.52, lon: 13.405 }, { lat: 35.6762, lon: 139.6503 })).toBeCloseTo(
      8918,
      -2,
    );
  });

  it('is symmetric', () => {
    const a = { lat: -33.87, lon: 151.21 };
    const b = { lat: 55.75, lon: 37.62 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });

  it('measures across the antimeridian the short way', () => {
    // 179°E to 179°W is 2° apart, not 358°.
    const km = haversineKm({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
    expect(km).toBeGreaterThan(200);
    expect(km).toBeLessThan(250);
  });
});

describe('centroid', () => {
  it('averages simple clusters', () => {
    const result = centroid([
      { point: { lat: 0, lon: 0.0001 } },
      { point: { lat: 10, lon: 10 } },
    ]);
    expect(result!.lat).toBeCloseTo(5, 1);
    expect(result!.lon).toBeCloseTo(5, 1);
  });

  it('REGRESSION: does not land on the wrong side of the planet across the antimeridian', () => {
    // Averaging lat/lon arithmetically puts the centroid of (179, -179) at 0° —
    // the Gulf of Guinea instead of the Pacific. Computing in 3-D Cartesian space
    // is what keeps Pacific and Bering Strait events where they belong.
    const result = centroid([
      { point: { lat: 0, lon: 179 } },
      { point: { lat: 0, lon: -179 } },
    ]);
    expect(Math.abs(result!.lon)).toBeGreaterThan(178);
    expect(result!.lat).toBeCloseTo(0, 5);
  });

  it('respects weights', () => {
    // A heavily-weighted point should pull the centroid toward itself.
    const result = centroid([
      { point: { lat: 0, lon: 0.0001 }, weight: 9 },
      { point: { lat: 10, lon: 0.0001 }, weight: 1 },
    ]);
    expect(result!.lat).toBeCloseTo(1, 0);
  });

  it('returns null for an empty set or zero total weight', () => {
    expect(centroid([])).toBeNull();
    expect(centroid([{ point: { lat: 5, lon: 5 }, weight: 0 }])).toBeNull();
  });

  it('returns null for antipodal points that cancel out', () => {
    // There is no meaningful centroid; null is honest where 0,0 would be a lie.
    expect(centroid([{ point: { lat: 90, lon: 0 } }, { point: { lat: -90, lon: 0 } }])).toBeNull();
  });
});

describe('geoCompatible', () => {
  it('allows a coarse observation to match a precise one', () => {
    // A country-precision report and an exact fix 400 km apart may genuinely
    // describe the same event; refusing this strands every coarse GDELT row.
    expect(
      geoCompatible(
        { point: { lat: 52, lon: 13 }, precision: 'country' },
        { point: { lat: 50, lon: 8 }, precision: 'exact' },
      ),
    ).toBe(true);
  });

  it('separates two precise observations that are far apart', () => {
    expect(
      geoCompatible(
        { point: { lat: 52, lon: 13 }, precision: 'exact' },
        { point: { lat: 35, lon: 139 }, precision: 'exact' },
      ),
    ).toBe(false);
  });

  it('treats two exact points a few km apart as the same place', () => {
    expect(
      geoCompatible(
        { point: { lat: 52.52, lon: 13.405 }, precision: 'exact' },
        { point: { lat: 52.53, lon: 13.41 }, precision: 'exact' },
      ),
    ).toBe(true);
  });
});

describe('gridCell', () => {
  it('is stable for the same point and encodes its cell size', () => {
    expect(gridCell({ lat: 52.52, lon: 13.405 })).toBe(gridCell({ lat: 52.52, lon: 13.405 }));
    expect(gridCell({ lat: 52.52, lon: 13.405 }, 5).startsWith('5:')).toBe(true);
  });

  it('groups nearby points and separates distant ones', () => {
    expect(gridCell({ lat: 52.1, lon: 13.1 })).toBe(gridCell({ lat: 52.9, lon: 13.9 }));
    expect(gridCell({ lat: 52.1, lon: 13.1 })).not.toBe(gridCell({ lat: 35.6, lon: 139.7 }));
  });

  it('never collides across hemispheres', () => {
    // The +90/+180 offsets exist so negative coordinates cannot produce a cell id
    // that a positive coordinate also produces.
    const cells = new Set([
      gridCell({ lat: 10, lon: 10 }),
      gridCell({ lat: -10, lon: 10 }),
      gridCell({ lat: 10, lon: -10 }),
      gridCell({ lat: -10, lon: -10 }),
    ]);
    expect(cells.size).toBe(4);
  });
});
