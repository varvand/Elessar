import { unzipSync } from 'fflate';
import {
  cameoRootLabel,
  cameoRootToCategory,
  normalizePoint,
  parseDate,
  type FetchContext,
  type FetchResult,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/**
 * GDELT 2.0 Event firehose — the backbone source.
 *
 * GDELT machine-codes worldwide news into CAMEO-typed, geolocated event records
 * and publishes a new batch every 15 minutes. That makes it the one free source
 * that alone gives global coverage with real coordinates and a conflict scale.
 *
 * Why the raw CSV firehose rather than the friendlier DOC/GEO JSON APIs:
 * those APIs are aggressively rate limited (one request per five seconds, and
 * shared-IP clients see blanket HTTP 429s), while the 15-minute CSV drops are
 * plain static files on Google Cloud Storage with no limit and no key. For a
 * system that wants every event rather than a keyword slice, the firehose is
 * both kinder to GDELT and strictly more complete.
 *
 * Feed layout:
 *   lastupdate.txt lists three lines — export (events), mentions, gkg — each
 *   "<size> <md5> <url>". We consume the export file only; mentions and GKG are
 *   an order of magnitude larger and add little for situational awareness.
 */

const LAST_UPDATE_URL = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';

/**
 * Column indices in the 61-field, tab-separated export CSV.
 *
 * The file ships without a header row, so these offsets *are* the schema.
 * Verified against a live 2026 export before being written down. Reference:
 * GDELT Event Codebook V2.0.
 */
const COL = {
  globalEventId: 0,
  sqlDate: 1,
  actor1Name: 6,
  actor1CountryCode: 7,
  actor2Name: 16,
  actor2CountryCode: 17,
  isRootEvent: 25,
  eventCode: 26,
  eventRootCode: 28,
  quadClass: 29,
  goldsteinScale: 30,
  numMentions: 31,
  numSources: 32,
  numArticles: 33,
  avgTone: 34,
  actionGeoType: 51,
  actionGeoFullName: 52,
  actionGeoCountryCode: 53,
  actionGeoAdm1Code: 54,
  actionGeoLat: 56,
  actionGeoLong: 57,
  dateAdded: 59,
  sourceUrl: 60,
} as const;

const EXPECTED_COLUMNS = 61;

/**
 * GDELT's ActionGeo_Type, which tells us how precisely the event was located.
 * 1 = country, 2 = US state, 3 = US city, 4 = world city, 5 = world state.
 * Mapping it through is what keeps a country-level guess from rendering as a
 * confident city pin.
 */
function precisionFromGeoType(geoType: string): 'city' | 'admin1' | 'country' | 'unknown' {
  switch (geoType) {
    case '3':
    case '4':
      return 'city';
    case '2':
    case '5':
      return 'admin1';
    case '1':
      return 'country';
    default:
      return 'unknown';
  }
}

interface LastUpdate {
  exportUrl: string;
  /** Filename stem, e.g. "20260815191500" — used as the cursor. */
  stamp: string;
}

function parseLastUpdate(body: string): LastUpdate | null {
  for (const line of body.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const url = parts[2];
    if (!url || !url.includes('.export.CSV.zip')) continue;
    const stamp = /(\d{14})\.export\.CSV\.zip$/.exec(url)?.[1];
    if (!stamp) continue;
    return { exportUrl: url, stamp };
  }
  return null;
}

/**
 * GDELT rows are one *mention-weighted* event each, and the same real-world
 * happening appears many times with different source URLs. We keep them all —
 * the clustering stage is what collapses them, and the duplication is itself
 * the corroboration signal.
 *
 * Rows below this Goldstein-absolute / mention threshold are dropped: GDELT's
 * long tail is dominated by routine "make public statement" codings that would
 * bury genuine signal at a ratio of roughly 50:1.
 */
const MIN_MENTIONS = 2;

function parseRow(fields: string[]): ObservationDraft | null {
  const globalEventId = fields[COL.globalEventId];
  if (!globalEventId) return null;

  const sourceUrl = fields[COL.sourceUrl] ?? '';
  const numMentions = Number.parseInt(fields[COL.numMentions] ?? '0', 10) || 0;
  const numSources = Number.parseInt(fields[COL.numSources] ?? '0', 10) || 0;
  const numArticles = Number.parseInt(fields[COL.numArticles] ?? '0', 10) || 0;

  if (numMentions < MIN_MENTIONS) return null;

  const point = normalizePoint(fields[COL.actionGeoLat], fields[COL.actionGeoLong]);
  // Without coordinates there is nothing to pin, and GDELT gives us no text
  // body to geocode from — so an unlocated row is not recoverable downstream.
  if (!point) return null;

  const rootCode = fields[COL.eventRootCode] ?? '';
  const category = cameoRootToCategory(rootCode);
  const cameoLabel = cameoRootLabel(rootCode);

  const goldstein = Number.parseFloat(fields[COL.goldsteinScale] ?? '');
  const avgTone = Number.parseFloat(fields[COL.avgTone] ?? '');

  const actor1 = fields[COL.actor1Name] ?? '';
  const actor2 = fields[COL.actor2Name] ?? '';
  const actors = [actor1, actor2].filter((a) => a.length > 1).map(titleCase);

  const placeName = fields[COL.actionGeoFullName] ?? null;
  const fipsCountry = fields[COL.actionGeoCountryCode] ?? null;

  // GDELT has no headline of its own; synthesize a readable one from the CAMEO
  // coding so the feed is legible without opening the source article.
  const title = buildTitle(actors, cameoLabel, placeName);

  const occurredAt =
    parseDate(fields[COL.dateAdded]) ?? parseDate(fields[COL.sqlDate]) ?? new Date();

  return {
    sourceId: 'gdelt.events',
    externalId: globalEventId,
    title,
    body: [
      cameoLabel ? `CAMEO: ${cameoLabel} (${fields[COL.eventCode] ?? rootCode}).` : null,
      actors.length ? `Actors: ${actors.join(' → ')}.` : null,
      placeName ? `Location: ${placeName}.` : null,
      Number.isFinite(goldstein) ? `Goldstein scale: ${goldstein.toFixed(1)}.` : null,
      `Corroboration: ${numArticles} articles across ${numSources} sources.`,
    ]
      .filter(Boolean)
      .join(' '),
    url: sourceUrl.startsWith('http') ? sourceUrl : null,
    occurredAt,
    publishedAt: occurredAt,
    geo: {
      point,
      precision: precisionFromGeoType(fields[COL.actionGeoType] ?? ''),
      placeName,
      // Derived from coordinates during enrichment; see the note above.
      countryCode: null,
      admin1: fields[COL.actionGeoAdm1Code] ?? null,
    },
    placeHint: placeName,
    category,
    magnitude: Number.isFinite(goldstein) ? goldstein : null,
    // GDELT's AvgTone runs roughly -100..+100; ours is -1..+1.
    tone: Number.isFinite(avgTone) ? Math.max(-1, Math.min(1, avgTone / 100)) : null,
    reportCount: Math.max(numSources, 1),
    actors,
    raw: {
      globalEventId,
      eventCode: fields[COL.eventCode],
      eventRootCode: rootCode,
      quadClass: fields[COL.quadClass],
      goldsteinScale: goldstein,
      numMentions,
      numSources,
      numArticles,
      avgTone,
      actor1: { name: actor1, country: fields[COL.actor1CountryCode] },
      actor2: { name: actor2, country: fields[COL.actor2CountryCode] },
      actionGeo: { fullName: placeName, fipsCountryCode: fipsCountry, type: fields[COL.actionGeoType] },
      isRootEvent: fields[COL.isRootEvent] === '1',
    },
  };
}

function buildTitle(
  actors: string[],
  cameoLabel: string | null,
  placeName: string | null,
): string {
  const action = cameoLabel ?? 'Reported activity';
  const where = placeName ? ` in ${placeName}` : '';

  if (actors.length >= 2) return `${actors[0]} — ${action} — ${actors[1]}${where}`;
  if (actors.length === 1) return `${actors[0]}: ${action}${where}`;
  return `${action}${where}`;
}

/** GDELT actor names arrive SHOUTING; title-case them for display. */
function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word.length <= 1 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * GDELT tags locations with FIPS 10-4 country codes, not ISO 3166-1. The two
 * agree for most countries and disagree for a significant minority in ways that
 * are actively misleading: FIPS `SG` is Senegal but ISO `SG` is Singapore, FIPS
 * `CH` is China but ISO `CH` is Switzerland, FIPS `BF` is the Bahamas but ISO
 * `BF` is Burkina Faso.
 *
 * Rather than hand-maintain a ~250-entry crosswalk — which is both tedious and
 * exactly the sort of table that rots silently and mislabels events in the
 * country filter — the FIPS code is preserved verbatim in `raw` and the country
 * is left for the enrichment stage to derive from coordinates. Reverse lookup
 * against the gazetteer is authoritative, and we need that gazetteer anyway.
 */

export const gdeltEventsConnector: SourceDefinition = {
  id: 'gdelt.events',
  name: 'GDELT 2.0 Event Firehose',
  homepage: 'https://www.gdeltproject.org/',
  license: 'GDELT open data — free for any use with attribution',
  // GDELT publishes every 15 minutes; polling faster only wastes requests.
  intervalSeconds: 900,
  minRequestIntervalMs: 5000,
  emits: [
    'armed_conflict',
    'civil_unrest',
    'terrorism',
    'political',
    'diplomacy',
    'humanitarian',
    'other',
  ],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cursor = (ctx.cursor ?? {}) as { stamp?: string };

    const indexResponse = await ctx.http.get(LAST_UPDATE_URL, { signal: ctx.signal });
    const lastUpdate = parseLastUpdate(await indexResponse.text());

    if (!lastUpdate) {
      throw new Error('Could not locate an export CSV in GDELT lastupdate.txt');
    }

    // The 15-minute batch we already ingested is still the newest one.
    if (cursor.stamp === lastUpdate.stamp) {
      ctx.log.debug({ stamp: lastUpdate.stamp }, 'GDELT batch already ingested');
      return { observations: [], cursor, notModified: true };
    }

    const zipResponse = await ctx.http.get(lastUpdate.exportUrl, { signal: ctx.signal });
    const archive = unzipSync(await zipResponse.bytes());

    const csvName = Object.keys(archive).find((name) => name.endsWith('.CSV'));
    if (!csvName) {
      throw new Error(`No .CSV member in ${lastUpdate.exportUrl}`);
    }

    const csv = new TextDecoder('utf-8').decode(archive[csvName]!);
    const observations: ObservationDraft[] = [];
    let malformed = 0;

    for (const line of csv.split('\n')) {
      if (line.trim() === '') continue;
      const fields = line.split('\t');
      if (fields.length < EXPECTED_COLUMNS) {
        malformed += 1;
        continue;
      }
      const draft = parseRow(fields);
      if (draft) observations.push(draft);
    }

    if (malformed > 0) {
      ctx.log.warn({ malformed, stamp: lastUpdate.stamp }, 'skipped malformed GDELT rows');
    }

    ctx.log.info(
      { stamp: lastUpdate.stamp, kept: observations.length },
      'GDELT batch parsed',
    );

    return { observations, cursor: { stamp: lastUpdate.stamp } };
  },
};
