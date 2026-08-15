import {
  loadEnv,
  normalizePoint,
  parseDate,
  type FetchContext,
  type FetchResult,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/**
 * NASA FIRMS — active fire detections from VIIRS.
 *
 * The one connector requiring a key, and the pattern for any future keyed
 * source: it declares `requiresEnv`, and the scheduler skips it entirely when
 * the key is absent rather than failing on every cycle. A free key takes a
 * minute to obtain: https://firms.modaps.eosdis.nasa.gov/api/map_key/
 *
 * Volume is the whole design problem here. Worldwide VIIRS returns roughly
 * 50k–200k detections per day, one row per 375 m pixel. A wildfire is hundreds
 * of adjacent rows, none of which is individually an "event". So this connector
 * does something the others do not: it spatially aggregates before emitting.
 *
 * Detections are binned into a ~0.25° grid (~25 km) and each populated cell
 * becomes one observation carrying the cell's total fire radiative power and
 * detection count. That turns a pixel firehose into a manageable number of
 * meaningful fire-complex observations, and FRP-summed cells are a decent proxy
 * for fire intensity.
 */

const GRID_DEG = 0.25;
/** Cells below this total FRP are ordinary agricultural burning, not incidents. */
const MIN_CELL_FRP = 50;
/** VIIRS confidence classes worth keeping. */
const ACCEPTED_CONFIDENCE = new Set(['n', 'h', 'nominal', 'high']);

interface Detection {
  lat: number;
  lon: number;
  frp: number;
  acquiredAt: Date;
  daynight: string;
}

interface Cell {
  latSum: number;
  lonSum: number;
  frpSum: number;
  count: number;
  latest: Date;
  weightSum: number;
}

function feedUrl(mapKey: string): string {
  // VIIRS S-NPP near-real-time, worldwide, last 1 day.
  return `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/VIIRS_SNPP_NRT/world/1`;
}

/** Parse the CSV using its header row rather than fixed offsets — FIRMS has
 *  added columns before, and positional parsing would break silently. */
function parseCsv(csv: string): Detection[] {
  const lines = csv.split('\n');
  const header = lines[0]?.trim().split(',');
  if (!header) return [];

  const idx = (name: string) => header.indexOf(name);
  const latIdx = idx('latitude');
  const lonIdx = idx('longitude');
  const frpIdx = idx('frp');
  const dateIdx = idx('acq_date');
  const timeIdx = idx('acq_time');
  const confIdx = idx('confidence');
  const dnIdx = idx('daynight');

  if (latIdx < 0 || lonIdx < 0 || frpIdx < 0) return [];

  const detections: Detection[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    const fields = line.split(',');

    const confidence = (fields[confIdx] ?? '').trim().toLowerCase();
    if (confIdx >= 0 && confidence !== '' && !ACCEPTED_CONFIDENCE.has(confidence)) continue;

    const point = normalizePoint(fields[latIdx], fields[lonIdx]);
    if (!point) continue;

    const frp = Number.parseFloat(fields[frpIdx] ?? '0');
    if (!Number.isFinite(frp) || frp <= 0) continue;

    // acq_time is "HHMM" (sometimes "HMM"), acq_date is "YYYY-MM-DD".
    const rawTime = (fields[timeIdx] ?? '0000').trim().padStart(4, '0');
    const acquiredAt =
      parseDate(`${fields[dateIdx] ?? ''}T${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}:00Z`) ??
      new Date();

    detections.push({
      lat: point.lat,
      lon: point.lon,
      frp,
      acquiredAt,
      daynight: (fields[dnIdx] ?? '').trim(),
    });
  }

  return detections;
}

function aggregate(detections: Detection[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();

  for (const detection of detections) {
    const latBin = Math.floor(detection.lat / GRID_DEG);
    const lonBin = Math.floor(detection.lon / GRID_DEG);
    const key = `${latBin}:${lonBin}`;

    const cell = cells.get(key);
    if (cell) {
      // FRP-weighted centroid: the hot core matters more than the smoky edges.
      cell.latSum += detection.lat * detection.frp;
      cell.lonSum += detection.lon * detection.frp;
      cell.weightSum += detection.frp;
      cell.frpSum += detection.frp;
      cell.count += 1;
      if (detection.acquiredAt > cell.latest) cell.latest = detection.acquiredAt;
    } else {
      cells.set(key, {
        latSum: detection.lat * detection.frp,
        lonSum: detection.lon * detection.frp,
        weightSum: detection.frp,
        frpSum: detection.frp,
        count: 1,
        latest: detection.acquiredAt,
      });
    }
  }

  return cells;
}

export const firmsConnector: SourceDefinition = {
  id: 'firms.fires',
  name: 'NASA FIRMS Active Fires (VIIRS)',
  homepage: 'https://firms.modaps.eosdis.nasa.gov/',
  license: 'NASA FIRMS — free with attribution; requires a free map key',
  intervalSeconds: 3600,
  minRequestIntervalMs: 5000,
  requiresEnv: ['FIRMS_MAP_KEY'],
  emits: ['wildfire'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const mapKey = loadEnv().FIRMS_MAP_KEY;
    if (!mapKey) {
      // Defence in depth: the scheduler should already have skipped us.
      ctx.log.warn('FIRMS_MAP_KEY absent; skipping');
      return { observations: [], cursor: null, notModified: true };
    }

    const response = await ctx.http.get(feedUrl(mapKey), { signal: ctx.signal });
    const csv = await response.text();

    // FIRMS answers an invalid or exhausted key with a plain-text message and
    // HTTP 200, so a body that is not CSV has to be detected explicitly.
    if (!csv.startsWith('country_id') && !csv.includes('latitude')) {
      throw new Error(`FIRMS returned a non-CSV body: ${csv.slice(0, 200)}`);
    }

    const detections = parseCsv(csv);
    const cells = aggregate(detections);
    const observations: ObservationDraft[] = [];

    for (const [key, cell] of cells) {
      if (cell.frpSum < MIN_CELL_FRP) continue;

      const point = normalizePoint(
        cell.latSum / cell.weightSum,
        cell.lonSum / cell.weightSum,
      );
      if (!point) continue;

      // Cell key plus day keeps one observation per fire complex per day, so a
      // multi-day fire accumulates observations rather than being replaced.
      const day = cell.latest.toISOString().slice(0, 10);

      observations.push({
        sourceId: 'firms.fires',
        externalId: `${key}:${day}`,
        // Phrased as prose for the same reason as the USGS connector: the
        // embedding model bridges instrument data to news reporting only when
        // the instrument data is written in natural language.
        title: `Active wildfire detected burning near ${point.lat.toFixed(2)}, ${point.lon.toFixed(2)}`,
        body:
          `Satellite monitoring detected ${cell.count} active fire hotspots burning within a ` +
          `25 km area centred on ${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}. ` +
          `The fire is releasing a total radiative power of ${Math.round(cell.frpSum)} megawatts, ` +
          `indicating ${cell.frpSum > 500 ? 'an intense, large-scale blaze' : 'active burning'}. ` +
          `The most recent detection was at ${cell.latest.toISOString()}.`,
        url: 'https://firms.modaps.eosdis.nasa.gov/map/',
        occurredAt: cell.latest,
        publishedAt: cell.latest,
        geo: {
          point,
          precision: 'exact',
          placeName: null,
          countryCode: null,
          admin1: null,
        },
        placeHint: null,
        category: 'wildfire',
        magnitude: cell.frpSum,
        tone: -0.5,
        reportCount: 1,
        actors: [],
        raw: {
          cell: key,
          detections: cell.count,
          frpTotal: cell.frpSum,
          gridDeg: GRID_DEG,
          latest: cell.latest.toISOString(),
        },
      });
    }

    ctx.log.info(
      { detections: detections.length, cells: cells.size, emitted: observations.length },
      'FIRMS detections aggregated',
    );

    return { observations, cursor: { lastRunAt: new Date().toISOString() } };
  },
};
