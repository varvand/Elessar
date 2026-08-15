import {
  normalizePoint,
  parseDate,
  type FetchContext,
  type FetchResult,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/**
 * USGS Earthquake Hazards Program — GeoJSON summary feeds.
 *
 * The gold standard for a connector: authoritative, exact coordinates, a real
 * magnitude scale, no key, no rate limit, and a documented stable schema.
 *
 * We poll the "significant + M4.5" hour/day feeds rather than the all-quakes
 * feed. The all-quakes feed carries tens of thousands of M<2 events that are
 * scientifically valuable and situationally meaningless.
 */

interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number | null;
    updated: number | null;
    url: string | null;
    title: string | null;
    type: string | null;
    alert: string | null;
    status: string | null;
    tsunami: number | null;
    /** USGS's own 0–1000+ significance score. */
    sig: number | null;
  };
  geometry: { type: string; coordinates: number[] } | null;
}

interface UsgsResponse {
  features: UsgsFeature[];
  metadata?: { generated?: number; count?: number };
}

/**
 * M4.5+ over the past day. Above ~M4.5 an event is potentially damaging and
 * newsworthy anywhere in the world; below it, only if very shallow and populated.
 */
const FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';

/** Significant events over the past week, which catches damaging M<4.5 quakes. */
const SIGNIFICANT_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson';

function toDraft(feature: UsgsFeature): ObservationDraft | null {
  const coords = feature.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;

  // GeoJSON is [lon, lat, depth] — transposing these is the single most common
  // geospatial bug, and it silently produces plausible-looking wrong pins.
  const point = normalizePoint(coords[1], coords[0]);
  if (!point) return null;

  const depthKm = coords.length > 2 ? coords[2] : null;
  const magnitude = feature.properties.mag;
  const occurredAt = parseDate(feature.properties.time) ?? new Date();
  const place = feature.properties.place;

  const tsunami = feature.properties.tsunami === 1;

  return {
    sourceId: 'usgs.quakes',
    externalId: feature.id,
    /**
     * A natural-language headline, rather than USGS's own
     * "M 7.7 - 68 km NNW of Ende, Indonesia".
     *
     * This is not cosmetic. The embedding model is trained on prose, and terse
     * instrument notation lands far away in the vector space from the
     * journalism describing the same event: measured against a real BBC report
     * of this exact earthquake, USGS's native phrasing scored cosine 0.387
     * while the wording below scored 0.613 — the difference between failing and
     * passing the clustering threshold, and therefore between an analyst seeing
     * the seismograph reading and the casualty report as one event or two.
     *
     * The verbatim USGS title is preserved in `raw` for provenance.
     */
    title: magnitude !== null
      ? `Magnitude ${magnitude.toFixed(1)} earthquake strikes ${place ?? 'unknown location'}`
      : `Earthquake reported ${place ? `near ${place}` : 'at an unknown location'}`,
    body: [
      magnitude !== null
        ? `A magnitude ${magnitude.toFixed(1)} earthquake struck${
            depthKm !== null && depthKm !== undefined
              ? ` at a depth of ${depthKm.toFixed(1)} km`
              : ''
          }${place ? `, ${place}` : ''}.`
        : null,
      feature.properties.sig !== null
        ? `USGS significance score ${feature.properties.sig}.`
        : null,
      tsunami ? 'A tsunami evaluation was flagged for this earthquake.' : null,
      feature.properties.alert
        ? `PAGER shaking alert level: ${feature.properties.alert}.`
        : null,
      `Review status: ${feature.properties.status ?? 'unknown'}.`,
    ]
      .filter(Boolean)
      .join(' '),
    url: feature.properties.url,
    occurredAt,
    publishedAt: parseDate(feature.properties.updated) ?? occurredAt,
    geo: {
      point,
      precision: 'exact',
      placeName: place,
      countryCode: null, // resolved by the gazetteer during enrichment
      admin1: null,
    },
    placeHint: place,
    category: 'seismic',
    magnitude,
    // Earthquakes have no editorial tone; a fixed negative value keeps them from
    // being scored as neutral filler next to news-derived observations.
    tone: -0.5,
    reportCount: 1,
    actors: [],
    raw: {
      id: feature.id,
      usgsTitle: feature.properties.title,
      mag: magnitude,
      depthKm,
      place,
      sig: feature.properties.sig,
      alert: feature.properties.alert,
      tsunami,
      status: feature.properties.status,
      type: feature.properties.type,
    },
  };
}

export const usgsQuakesConnector: SourceDefinition = {
  id: 'usgs.quakes',
  name: 'USGS Earthquake Feed',
  homepage: 'https://earthquake.usgs.gov/earthquakes/feed/',
  license: 'US Geological Survey — public domain',
  intervalSeconds: 300,
  minRequestIntervalMs: 1500,
  emits: ['seismic'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cursor = (ctx.cursor ?? {}) as { etag?: string };
    const drafts = new Map<string, ObservationDraft>();

    // Both feeds are fetched every cycle and merged by USGS id. They overlap
    // heavily by design — the M4.5 feed catches everything large, the
    // significant feed catches small-but-damaging events the first would miss.
    for (const url of [FEED_URL, SIGNIFICANT_URL]) {
      const response = await ctx.http.get(url, { signal: ctx.signal });
      if (response.notModified) continue;

      const payload = await response.json<UsgsResponse>();
      for (const feature of payload.features ?? []) {
        const draft = toDraft(feature);
        // Deduplicate across the two feeds; either copy is equally good.
        if (draft && !drafts.has(draft.externalId)) {
          drafts.set(draft.externalId, draft);
        }
      }
    }

    ctx.log.debug({ quakes: drafts.size }, 'USGS feeds parsed');

    return {
      observations: [...drafts.values()],
      cursor: { etag: cursor.etag ?? null },
    };
  },
};
