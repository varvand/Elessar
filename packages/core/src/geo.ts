import type { GeoPoint, GeoPrecision } from './types';

const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Typical positional error for a precision class, in kilometres. Used as the
 * clustering distance budget: two observations that could plausibly describe
 * the same place given their precision should not be split apart just because
 * one was geocoded coarsely.
 */
export const PRECISION_RADIUS_KM: Record<GeoPrecision, number> = {
  exact: 5,
  city: 25,
  admin1: 150,
  country: 600,
  unknown: 2000,
};

/**
 * Whether two located observations are close enough to belong to one event,
 * accounting for how coarsely each was geocoded.
 */
export function geoCompatible(
  a: { point: GeoPoint; precision: GeoPrecision },
  b: { point: GeoPoint; precision: GeoPrecision },
): boolean {
  const budget = PRECISION_RADIUS_KM[a.precision] + PRECISION_RADIUS_KM[b.precision];
  return haversineKm(a.point, b.point) <= budget;
}

/**
 * Weighted centroid of a set of points, computed in 3-D Cartesian space so it
 * behaves correctly across the antimeridian and near the poles. Averaging
 * lat/lon directly puts the centroid of (179°, -179°) at 0° — the wrong side
 * of the planet — which matters for Pacific and Bering Strait events.
 */
export function centroid(points: { point: GeoPoint; weight?: number }[]): GeoPoint | null {
  if (points.length === 0) return null;

  let x = 0;
  let y = 0;
  let z = 0;
  let totalWeight = 0;

  for (const { point, weight = 1 } of points) {
    const lat = toRad(point.lat);
    const lon = toRad(point.lon);
    const cosLat = Math.cos(lat);
    x += cosLat * Math.cos(lon) * weight;
    y += cosLat * Math.sin(lon) * weight;
    z += Math.sin(lat) * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;
  x /= totalWeight;
  y /= totalWeight;
  z /= totalWeight;

  const hyp = Math.hypot(x, y);
  // All points cancelled out (antipodal pairs) — no meaningful centroid.
  if (hyp < 1e-12 && Math.abs(z) < 1e-12) return null;

  return {
    lat: (Math.atan2(z, hyp) * 180) / Math.PI,
    lon: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

/**
 * Quantize a point into a grid cell id. Used by the anomaly detector to build
 * per-region baselines without needing real administrative geometry.
 *
 * `sizeDeg` of 5 gives 2592 cells worldwide — coarse enough that a cell sees
 * enough traffic for a stable baseline, fine enough to localize a spike.
 */
export function gridCell(point: GeoPoint, sizeDeg = 5): string {
  const lat = Math.floor((point.lat + 90) / sizeDeg);
  const lon = Math.floor((point.lon + 180) / sizeDeg);
  return `${sizeDeg}:${lat}:${lon}`;
}

/** Clamp to valid WGS84 ranges, wrapping longitude. Returns null if unusable. */
export function normalizePoint(lat: unknown, lon: unknown): GeoPoint | null {
  const latNum = typeof lat === 'string' ? Number.parseFloat(lat) : lat;
  const lonNum = typeof lon === 'string' ? Number.parseFloat(lon) : lon;
  if (typeof latNum !== 'number' || typeof lonNum !== 'number') return null;
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;
  if (Math.abs(latNum) > 90) return null;

  // GDELT and some RSS geotags emit exactly 0,0 for "unknown".
  if (latNum === 0 && lonNum === 0) return null;

  let wrapped = lonNum;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;

  return { lat: latNum, lon: wrapped };
}
