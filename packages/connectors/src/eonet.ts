import {
  normalizePoint,
  parseDate,
  type EventCategory,
  type FetchContext,
  type FetchResult,
  type GeoPoint,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/**
 * NASA EONET — Earth Observatory Natural Event Tracker.
 *
 * Curated natural events (storms, volcanoes, wildfires, icebergs, dust plumes)
 * cross-referenced to satellite imagery. Lower volume than GDACS but higher
 * curation, and it covers hazard types the others miss entirely — sea ice,
 * dust and haze, iceberg calving.
 *
 * Schema note: EONET events carry a *series* of geometries over time (a
 * hurricane track). We take the most recent point, since situational awareness
 * cares where it is now, and keep the full track in `raw` for later use.
 */

const FEED_URL = 'https://eonet.gsfc.nasa.gov/api/v2.1/events?status=open&limit=200';

interface EonetGeometry {
  date: string;
  type: string;
  coordinates: unknown;
}

interface EonetEvent {
  id: string;
  title: string;
  description?: string | null;
  link?: string;
  closed?: string | null;
  categories?: { id: number | string; title: string }[];
  sources?: { id: string; url: string }[];
  geometries?: EonetGeometry[];
}

interface EonetResponse {
  events: EonetEvent[];
}

/** EONET category titles → our taxonomy. */
const CATEGORY_MAP: Record<string, EventCategory> = {
  wildfires: 'wildfire',
  volcanoes: 'natural_disaster',
  'severe storms': 'severe_weather',
  floods: 'severe_weather',
  drought: 'natural_disaster',
  earthquakes: 'seismic',
  landslides: 'natural_disaster',
  'sea and lake ice': 'natural_disaster',
  'dust and haze': 'health',
  'snow and ice': 'severe_weather',
  'water color': 'natural_disaster',
  'temperature extremes': 'severe_weather',
  manmade: 'infrastructure',
};

/** Latest point in an event's geometry series. */
function latestPoint(geometries: EonetGeometry[] | undefined): {
  point: GeoPoint | null;
  date: Date | null;
} {
  if (!geometries?.length) return { point: null, date: null };

  const sorted = [...geometries].sort((a, b) => {
    const aTime = parseDate(a.date)?.getTime() ?? 0;
    const bTime = parseDate(b.date)?.getTime() ?? 0;
    return bTime - aTime;
  });

  for (const geometry of sorted) {
    const point = pointFromCoordinates(geometry.type, geometry.coordinates);
    if (point) return { point, date: parseDate(geometry.date) };
  }
  return { point: null, date: null };
}

function pointFromCoordinates(type: string, coordinates: unknown): GeoPoint | null {
  if (type === 'Point' && Array.isArray(coordinates)) {
    // GeoJSON [lon, lat].
    return normalizePoint(coordinates[1], coordinates[0]);
  }
  if (type === 'Polygon' && Array.isArray(coordinates)) {
    const ring = coordinates[0];
    if (Array.isArray(ring) && Array.isArray(ring[0])) {
      return normalizePoint(ring[0][1], ring[0][0]);
    }
  }
  return null;
}

export const eonetConnector: SourceDefinition = {
  id: 'nasa.eonet',
  name: 'NASA EONET Natural Events',
  homepage: 'https://eonet.gsfc.nasa.gov/',
  license: 'NASA — public domain (attribution appreciated)',
  intervalSeconds: 1800,
  minRequestIntervalMs: 2000,
  emits: ['wildfire', 'natural_disaster', 'severe_weather', 'seismic', 'health'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cursor = (ctx.cursor ?? {}) as { etag?: string };

    const response = await ctx.http.get(FEED_URL, {
      etag: cursor.etag ?? null,
      signal: ctx.signal,
    });

    if (response.notModified) {
      return { observations: [], cursor, notModified: true };
    }

    const payload = await response.json<EonetResponse>();
    const observations: ObservationDraft[] = [];

    for (const event of payload.events ?? []) {
      const { point, date } = latestPoint(event.geometries);
      if (!point) continue;

      const categoryTitle = event.categories?.[0]?.title?.toLowerCase() ?? '';
      const occurredAt = date ?? new Date();

      // Track length is a useful proxy for how long this has been developing.
      const trackLength = event.geometries?.length ?? 1;

      observations.push({
        sourceId: 'nasa.eonet',
        // Include the geometry date: a moving storm is a new observation each
        // time it is re-plotted, which is what builds its track over time.
        externalId: date ? `${event.id}:${date.toISOString()}` : event.id,
        title: event.title,
        body: [
          event.description || null,
          categoryTitle ? `EONET category: ${event.categories?.[0]?.title}.` : null,
          trackLength > 1 ? `Tracked across ${trackLength} observations.` : null,
          event.sources?.length
            ? `Satellite sources: ${event.sources.map((s) => s.id).join(', ')}.`
            : null,
        ]
          .filter(Boolean)
          .join(' '),
        url: event.sources?.[0]?.url ?? event.link ?? null,
        occurredAt,
        publishedAt: occurredAt,
        geo: {
          point,
          precision: 'exact',
          placeName: null,
          countryCode: null,
          admin1: null,
        },
        placeHint: null,
        category: CATEGORY_MAP[categoryTitle] ?? 'natural_disaster',
        magnitude: null,
        tone: -0.4,
        reportCount: 1,
        actors: [],
        raw: {
          id: event.id,
          categories: event.categories,
          sources: event.sources,
          geometryCount: trackLength,
          track: event.geometries?.slice(-20),
        },
      });
    }

    ctx.log.debug({ events: observations.length }, 'EONET parsed');

    return { observations, cursor: { etag: response.etag ?? cursor.etag } };
  },
};
