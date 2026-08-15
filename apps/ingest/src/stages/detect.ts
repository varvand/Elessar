import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { floorTo, HOUR, isEventCategory, type Logger } from '@elessar/core';
import { alerts, baselines, observations, type Database } from '@elessar/db';
import {
  alertDedupKey,
  describeAnomaly,
  detectAnomaly,
  findNearestPlace,
  updateBaseline,
} from '@elessar/ml';

/**
 * Stage 4 — Detect.
 *
 * Aggregates the last completed hour into (category, grid cell) buckets, folds
 * each into its rolling baseline, and raises an alert where volume is
 * statistically unusual for that pairing.
 *
 * Only *completed* hours are processed. Bucketing the current, partial hour
 * would compare a half-full bucket against full-hour baselines and both miss
 * real spikes and corrupt the baseline with systematically low samples.
 */

export interface DetectResult {
  bucketsProcessed: number;
  alertsRaised: number;
  bucketAt: Date | null;
}

export async function detectAnomalies(db: Database, log: Logger): Promise<DetectResult> {
  const now = new Date();
  const currentHour = floorTo(now, HOUR);
  // The most recently completed hour.
  const bucketAt = new Date(currentHour.getTime() - HOUR);
  const bucketEnd = currentHour;

  const buckets = await db
    .select({
      category: observations.category,
      gridCell: observations.gridCell,
      count: sql<number>`count(*)::int`,
      maxSeverity: sql<number>`max(${observations.severity})::int`,
    })
    .from(observations)
    .where(
      and(
        gte(observations.occurredAt, bucketAt),
        lt(observations.occurredAt, bucketEnd),
        isNotNull(observations.gridCell),
      ),
    )
    .groupBy(observations.category, observations.gridCell);

  if (buckets.length === 0) {
    return { bucketsProcessed: 0, alertsRaised: 0, bucketAt };
  }

  let alertsRaised = 0;

  for (const bucket of buckets) {
    if (!bucket.gridCell || !isEventCategory(bucket.category)) continue;

    const [existing] = await db
      .select()
      .from(baselines)
      .where(
        and(eq(baselines.category, bucket.category), eq(baselines.gridCell, bucket.gridCell)),
      )
      .limit(1);

    // Skip a bucket already folded in — otherwise a re-run inflates the sample
    // count and drags the mean toward the value being tested.
    if (existing?.lastBucketAt && existing.lastBucketAt.getTime() >= bucketAt.getTime()) {
      continue;
    }

    const prior = {
      sampleCount: existing?.sampleCount ?? 0,
      mean: existing?.mean ?? 0,
      m2: existing?.m2 ?? 0,
    };

    const update = updateBaseline(prior, bucket.count);

    await db
      .insert(baselines)
      .values({
        category: bucket.category,
        gridCell: bucket.gridCell,
        sampleCount: update.sampleCount,
        mean: update.mean,
        m2: update.m2,
        lastBucketAt: bucketAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [baselines.category, baselines.gridCell],
        set: {
          sampleCount: update.sampleCount,
          mean: update.mean,
          m2: update.m2,
          lastBucketAt: bucketAt,
          updatedAt: new Date(),
        },
      });

    const signal = detectAnomaly(bucket.category, bucket.gridCell, bucket.count, update);
    if (!signal) continue;

    // Name the location for the alert text. The cell centre is derived from the
    // grid key, which is enough for a nearest-place lookup.
    const placeName = describeCell(bucket.gridCell);
    const { title, detail } = describeAnomaly(signal, placeName?.name ?? null);

    const inserted = await db
      .insert(alerts)
      .values({
        kind: 'volume_spike',
        dedupKey: alertDedupKey('volume_spike', bucket.category, bucket.gridCell, bucketAt),
        bucketAt,
        title,
        detail,
        category: bucket.category,
        gridCell: bucket.gridCell,
        countryCode: placeName?.countryCode ?? null,
        placeName: placeName?.name ?? null,
        lat: placeName?.lat ?? null,
        lon: placeName?.lon ?? null,
        zScore: signal.zScore,
        observed: signal.observed,
        expected: signal.expected,
        severity: Math.max(signal.severity, bucket.maxSeverity),
      })
      .onConflictDoNothing({ target: alerts.dedupKey })
      .returning({ id: alerts.id });

    if (inserted.length > 0) {
      alertsRaised += 1;
      log.warn(
        {
          category: bucket.category,
          cell: bucket.gridCell,
          observed: signal.observed,
          expected: signal.expected.toFixed(1),
          z: signal.zScore.toFixed(1),
        },
        'anomaly detected',
      );
    }
  }

  log.info({ buckets: buckets.length, alertsRaised, bucketAt }, 'anomaly pass complete');
  return { bucketsProcessed: buckets.length, alertsRaised, bucketAt };
}

/**
 * Recover an approximate place from a grid cell key ("5:24:38").
 *
 * The key encodes the cell's south-west corner; we look up the nearest populated
 * place to its centre so an alert can say "near Aleppo" rather than "cell 5:24:38".
 */
function describeCell(
  cellKey: string,
): { name: string; countryCode: string | null; lat: number; lon: number } | null {
  const parts = cellKey.split(':');
  if (parts.length !== 3) return null;

  const sizeDeg = Number.parseFloat(parts[0]!);
  const latBin = Number.parseInt(parts[1]!, 10);
  const lonBin = Number.parseInt(parts[2]!, 10);
  if (!Number.isFinite(sizeDeg) || !Number.isFinite(latBin) || !Number.isFinite(lonBin)) {
    return null;
  }

  // Invert `gridCell`: bins were floor((lat + 90) / size).
  const lat = latBin * sizeDeg - 90 + sizeDeg / 2;
  const lon = lonBin * sizeDeg - 180 + sizeDeg / 2;

  try {
    // Half the cell diagonal, so the search covers the whole cell.
    const radiusKm = sizeDeg * 111;
    const place = findNearestPlace({ lat, lon }, radiusKm);
    if (!place) return null;
    return {
      name: place.name,
      countryCode: place.countryCode || null,
      lat: place.lat,
      lon: place.lon,
    };
  } catch {
    return null;
  }
}
