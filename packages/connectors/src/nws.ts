import {
  centroid,
  normalizePoint,
  parseDate,
  truncate,
  type EventCategory,
  type FetchContext,
  type FetchResult,
  type GeoPoint,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/**
 * US National Weather Service — active CAP alerts.
 *
 * Regional rather than global, but included because it is the highest-quality
 * severe-weather feed available anywhere for free: official warnings, real
 * polygons, CAP severity/urgency/certainty, updated continuously.
 *
 * Two things this connector has to get right:
 *
 * 1. Volume. The unfiltered feed is ~1.4 MB and a couple of hundred alerts,
 *    mostly routine advisories. We request only Severe/Extreme actual alerts —
 *    server-side, so the bandwidth is never spent.
 *
 * 2. Geometry. Alerts carry a Polygon, a MultiPolygon, or nothing at all
 *    (zone-based alerts reference UGC codes whose geometry lives behind another
 *    request). We reduce polygons to a centroid and skip geometry-less alerts
 *    rather than fetch per-zone shapes — that would be hundreds of extra
 *    requests per cycle against a free government API.
 */

/**
 * No `limit` parameter: api.weather.gov rejects it outright with HTTP 400 on
 * the /alerts/active endpoint. Filtering is done with `severity` and `status`,
 * which the API does support and which cut the payload by roughly 90%.
 */
const FEED_URL = 'https://api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme';

interface NwsFeature {
  id: string;
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
    | { type: string; coordinates: unknown }
    | null;
  properties: {
    id?: string;
    areaDesc?: string;
    event?: string;
    headline?: string | null;
    description?: string | null;
    instruction?: string | null;
    severity?: string;
    certainty?: string;
    urgency?: string;
    sent?: string;
    effective?: string;
    onset?: string | null;
    expires?: string | null;
    senderName?: string;
  };
}

interface NwsResponse {
  features: NwsFeature[];
}

/** CAP severity → the 1..4 scale `severity.ts` expects for this source. */
const CAP_SEVERITY_VALUE: Record<string, number> = {
  minor: 1,
  moderate: 2,
  severe: 3,
  extreme: 4,
};

/**
 * NWS event names are a fixed, documented vocabulary, so mapping the ones that
 * are not plain severe weather is worth doing explicitly.
 */
function categoryForEvent(eventName: string): EventCategory {
  const name = eventName.toLowerCase();
  if (name.includes('fire') || name.includes('red flag')) return 'wildfire';
  if (name.includes('tsunami') || name.includes('earthquake')) return 'seismic';
  if (name.includes('volcan')) return 'natural_disaster';
  if (name.includes('avalanche') || name.includes('landslide')) return 'natural_disaster';
  if (name.includes('air quality') || name.includes('smoke')) return 'health';
  return 'severe_weather';
}

/**
 * Reduce CAP geometry to a single representative point.
 *
 * Uses the shared spherical `centroid` rather than a naive lat/lon mean so
 * Alaskan and Pacific-territory alerts that cross the antimeridian do not land
 * in the wrong hemisphere.
 */
function geometryCentroid(geometry: NwsFeature['geometry']): GeoPoint | null {
  if (!geometry) return null;

  const rings: number[][][] = [];
  if (geometry.type === 'Polygon') {
    rings.push(...(geometry.coordinates as number[][][]));
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates as number[][][][]) {
      rings.push(...polygon);
    }
  } else {
    return null;
  }

  const points: { point: GeoPoint }[] = [];
  for (const ring of rings) {
    for (const pair of ring) {
      // GeoJSON order is [lon, lat].
      const point = normalizePoint(pair[1], pair[0]);
      if (point) points.push({ point });
    }
  }

  return centroid(points);
}

export const nwsAlertsConnector: SourceDefinition = {
  id: 'nws.alerts',
  name: 'US National Weather Service Alerts',
  homepage: 'https://www.weather.gov/documentation/services-web-api',
  license: 'NOAA/NWS — public domain',
  intervalSeconds: 300,
  minRequestIntervalMs: 2000,
  emits: ['severe_weather', 'wildfire', 'natural_disaster', 'seismic', 'health'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cursor = (ctx.cursor ?? {}) as { etag?: string; lastModified?: string };

    const response = await ctx.http.get(FEED_URL, {
      etag: cursor.etag ?? null,
      lastModified: cursor.lastModified ?? null,
      signal: ctx.signal,
      // api.weather.gov requires this Accept header for the GeoJSON variant.
      headers: { accept: 'application/geo+json' },
    });

    if (response.notModified) {
      return { observations: [], cursor, notModified: true };
    }

    const payload = await response.json<NwsResponse>();
    const observations: ObservationDraft[] = [];
    let withoutGeometry = 0;

    for (const feature of payload.features ?? []) {
      const props = feature.properties;
      const point = geometryCentroid(feature.geometry);

      if (!point) {
        // Zone-based alert: geometry would require a per-UGC-zone lookup.
        withoutGeometry += 1;
        continue;
      }

      const eventName = props.event ?? 'Weather alert';
      const sent = parseDate(props.sent) ?? new Date();

      /**
       * `occurredAt` is when the alert was *issued*, deliberately not its `onset`.
       *
       * CAP `onset` is a forecast: a flood warning issued today can carry an onset
       * three days out for a predicted river crest. Treating that as the event
       * time places the observation in the future, which breaks every
       * time-ordered consumer downstream — the feed's decay ranking most of all.
       * The forecast window is preserved in `raw` for anyone who needs it.
       */
      const effective = parseDate(props.effective) ?? sent;
      const occurredAt = effective > sent ? sent : effective;
      const onset = parseDate(props.onset);

      observations.push({
        sourceId: 'nws.alerts',
        externalId: feature.id ?? props.id ?? `${eventName}:${props.sent}`,
        title: props.headline ? truncate(props.headline, 200) : `${eventName} — ${props.areaDesc ?? 'US'}`,
        body: [
          props.description ? truncate(props.description, 2500) : null,
          props.instruction ? `Instruction: ${truncate(props.instruction, 600)}` : null,
          `Severity ${props.severity ?? 'unknown'}, urgency ${props.urgency ?? 'unknown'}, certainty ${props.certainty ?? 'unknown'}.`,
          props.areaDesc ? `Areas: ${props.areaDesc}.` : null,
        ]
          .filter(Boolean)
          .join(' '),
        url: feature.id?.startsWith('http') ? feature.id : null,
        occurredAt,
        publishedAt: sent,
        geo: {
          point,
          // A polygon centroid genuinely localizes the alert, but the alert
          // covers an area — "city" reflects that better than "exact".
          precision: 'city',
          placeName: props.areaDesc ?? null,
          countryCode: 'US',
          admin1: null,
        },
        placeHint: props.areaDesc ?? null,
        category: categoryForEvent(eventName),
        magnitude: CAP_SEVERITY_VALUE[(props.severity ?? '').toLowerCase()] ?? 2,
        tone: -0.5,
        reportCount: 1,
        actors: props.senderName ? [props.senderName] : [],
        raw: {
          id: feature.id,
          event: eventName,
          severity: props.severity,
          urgency: props.urgency,
          certainty: props.certainty,
          areaDesc: props.areaDesc,
          senderName: props.senderName,
          // Forecast window kept for analysis; not used as the event time.
          onset: onset?.toISOString() ?? null,
          effective: props.effective ?? null,
          expires: props.expires,
          geometryType: feature.geometry?.type ?? null,
        },
      });
    }

    if (withoutGeometry > 0) {
      ctx.log.debug({ withoutGeometry }, 'skipped zone-only NWS alerts (no polygon)');
    }

    return {
      observations,
      cursor: {
        etag: response.etag ?? cursor.etag,
        lastModified: response.lastModified ?? cursor.lastModified,
      },
    };
  },
};
