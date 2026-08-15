import { XMLParser } from 'fast-xml-parser';
import {
  cleanText,
  contentHash,
  normalizePoint,
  parseDate,
  truncate,
  type EventCategory,
  type FetchContext,
  type FetchResult,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/**
 * Generic RSS/Atom connector.
 *
 * One parser handles every news feed Elessar ships with, because the differences
 * between them are configuration, not code. Adding an outlet is a single entry in
 * `NEWS_FEEDS` below — which is the property that keeps the source catalogue
 * maintainable as it grows.
 *
 * Feeds are messy in predictable ways, all handled here: RSS 2.0 vs Atom vs
 * RDF/RSS 1.0, `<item>` sometimes an object rather than an array, CDATA
 * wrapping, entity double-encoding, missing dates, and geotags in any of three
 * competing namespaces.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  trimValues: true,
  // Namespace prefixes are kept: georss:point and geo:lat must stay
  // distinguishable, and GDACS relies on its own gdacs: prefix entirely.
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  cdataPropName: '#cdata',
});

/** Coerce fast-xml-parser's "object or array or scalar" into an array. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read a node's text whether it arrived as a scalar, {#text} or {#cdata}. */
export function nodeText(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string') return cleanText(node) || null;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const candidate = record['#cdata'] ?? record['#text'];
    if (candidate !== undefined) return nodeText(candidate);
  }
  return null;
}

export function nodeAttr(node: unknown, attr: string): string | null {
  if (node === null || typeof node !== 'object') return null;
  const value = (node as Record<string, unknown>)[`@${attr}`];
  return value === undefined ? null : cleanText(String(value)) || null;
}

interface FeedItem {
  title: string | null;
  description: string | null;
  link: string | null;
  guid: string | null;
  published: Date | null;
  lat: number | null;
  lon: number | null;
  categories: string[];
  raw: Record<string, unknown>;
}

/** Extract items from RSS 2.0, RSS 1.0/RDF or Atom without caring which. */
export function parseFeed(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;

  const rss = doc['rss'] as Record<string, unknown> | undefined;
  const rdf = (doc['rdf:RDF'] ?? doc['RDF']) as Record<string, unknown> | undefined;
  const feed = doc['feed'] as Record<string, unknown> | undefined;

  const channel = rss?.['channel'] as Record<string, unknown> | undefined;

  const rawItems: unknown[] = [
    ...asArray(channel?.['item']),
    ...asArray(rdf?.['item']),
    ...asArray(feed?.['entry']),
  ];

  return rawItems.map(toFeedItem).filter((item): item is FeedItem => item !== null);
}

function toFeedItem(raw: unknown): FeedItem | null {
  if (raw === null || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;

  const title = nodeText(node['title']);
  if (!title) return null;

  const description =
    nodeText(node['description']) ??
    nodeText(node['summary']) ??
    nodeText(node['content:encoded']) ??
    nodeText(node['content']);

  // Atom puts the URL in <link href>; RSS puts it in the element text.
  const linkNodes = asArray(node['link']);
  let link: string | null = null;
  for (const candidate of linkNodes) {
    const href = nodeAttr(candidate, 'href');
    const rel = nodeAttr(candidate, 'rel');
    if (href && (rel === null || rel === 'alternate')) {
      link = href;
      break;
    }
    const text = nodeText(candidate);
    if (text?.startsWith('http')) {
      link = text;
      break;
    }
  }

  const published =
    parseDate(nodeText(node['pubDate'])) ??
    parseDate(nodeText(node['published'])) ??
    parseDate(nodeText(node['updated'])) ??
    parseDate(nodeText(node['dc:date']));

  const { lat, lon } = extractGeo(node);

  const categories = asArray(node['category'])
    .map((c) => nodeText(c) ?? nodeAttr(c, 'term'))
    .filter((c): c is string => c !== null);

  return {
    title,
    description,
    link,
    guid: nodeText(node['guid']) ?? nodeText(node['id']) ?? link,
    published,
    lat,
    lon,
    categories,
    raw: node,
  };
}

/**
 * Geotags appear in three mutually incompatible namespaces across the feeds we
 * consume, plus GDACS's nested <geo:Point>. All three are checked because which
 * one a feed uses is not documented anywhere and changes without notice.
 */
function extractGeo(node: Record<string, unknown>): { lat: number | null; lon: number | null } {
  // georss:point — "lat lon" in a single element.
  const georss = nodeText(node['georss:point']);
  if (georss) {
    const [latRaw, lonRaw] = georss.split(/[\s,]+/);
    const point = normalizePoint(latRaw, lonRaw);
    if (point) return { lat: point.lat, lon: point.lon };
  }

  // geo:Point nested container (W3C Basic Geo).
  const geoPoint = node['geo:Point'];
  if (geoPoint && typeof geoPoint === 'object') {
    const container = geoPoint as Record<string, unknown>;
    const point = normalizePoint(nodeText(container['geo:lat']), nodeText(container['geo:long']));
    if (point) return { lat: point.lat, lon: point.lon };
  }

  // Flat geo:lat / geo:long siblings.
  const flat = normalizePoint(nodeText(node['geo:lat']), nodeText(node['geo:long']));
  if (flat) return { lat: flat.lat, lon: flat.lon };

  return { lat: null, lon: null };
}

// ---------------------------------------------------------------------------
// News feed catalogue
// ---------------------------------------------------------------------------

export interface NewsFeedConfig {
  id: string;
  name: string;
  url: string;
  homepage: string;
  license: string;
  /** Applied when the classifier has no strong opinion. */
  defaultCategory?: EventCategory;
  intervalSeconds?: number;
}

/**
 * Free, publicly documented, no-key news feeds.
 *
 * Selection criteria: broad international coverage, stable feed URLs, and
 * editorially independent of one another — correlating five feeds that all
 * syndicate the same wire copy would inflate the corroboration score without
 * adding information.
 */
export const NEWS_FEEDS: NewsFeedConfig[] = [
  {
    id: 'rss.bbc-world',
    name: 'BBC News — World',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    homepage: 'https://www.bbc.co.uk/news/world',
    license: 'BBC RSS terms — headline/link reuse with attribution',
  },
  {
    id: 'rss.aljazeera',
    name: 'Al Jazeera — All News',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    homepage: 'https://www.aljazeera.com',
    license: 'Al Jazeera RSS terms — attribution required',
  },
  {
    id: 'rss.dw-world',
    name: 'Deutsche Welle — World',
    url: 'https://rss.dw.com/rdf/rss-en-world',
    homepage: 'https://www.dw.com',
    license: 'DW RSS terms — attribution required',
  },
  {
    id: 'rss.france24',
    name: 'France 24 — International',
    url: 'https://www.france24.com/en/rss',
    homepage: 'https://www.france24.com',
    license: 'France 24 RSS terms — attribution required',
  },
  {
    id: 'rss.un-news',
    name: 'UN News — Global',
    url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml',
    homepage: 'https://news.un.org',
    license: 'UN News — free reuse with attribution',
    defaultCategory: 'diplomacy',
  },
];

/**
 * Build a `SourceDefinition` from feed config. Conditional requests are used
 * throughout: most of these feeds update every few minutes, and a 304 costs
 * both sides essentially nothing.
 */
export function createRssConnector(config: NewsFeedConfig): SourceDefinition {
  return {
    id: config.id,
    name: config.name,
    homepage: config.homepage,
    license: config.license,
    intervalSeconds: config.intervalSeconds ?? 300,
    minRequestIntervalMs: 2000,
    emits: [
      'armed_conflict',
      'civil_unrest',
      'terrorism',
      'political',
      'diplomacy',
      'economy',
      'humanitarian',
      'health',
      'natural_disaster',
      'other',
    ],

    async fetch(ctx: FetchContext): Promise<FetchResult> {
      const cursor = (ctx.cursor ?? {}) as { etag?: string; lastModified?: string };

      const response = await ctx.http.get(config.url, {
        etag: cursor.etag ?? null,
        lastModified: cursor.lastModified ?? null,
        signal: ctx.signal,
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      });

      if (response.notModified) {
        ctx.log.debug({ source: config.id }, 'feed unchanged (304)');
        return { observations: [], cursor, notModified: true };
      }

      const items = parseFeed(await response.text());
      const now = new Date();
      const observations: ObservationDraft[] = [];

      for (const item of items) {
        const occurredAt = item.published ?? now;
        const point =
          item.lat !== null && item.lon !== null
            ? normalizePoint(item.lat, item.lon)
            : null;

        // Prefer the feed's guid; fall back to a content hash so an item without
        // one still gets a stable identity across polls instead of duplicating.
        const externalId = item.guid ?? item.link ?? contentHash(item.title, config.id);

        observations.push({
          sourceId: config.id,
          externalId,
          title: item.title ?? 'Untitled',
          body: item.description ? truncate(item.description, 4000) : null,
          url: item.link,
          occurredAt,
          publishedAt: item.published,
          geo: point
            ? {
                point,
                precision: 'city',
                placeName: null,
                countryCode: null,
                admin1: null,
              }
            : null,
          // The classifier does the real work; feed categories are noisy but a
          // useful place hint sometimes hides in them.
          placeHint: item.categories.length ? item.categories.join(', ') : null,
          category: config.defaultCategory ?? null,
          magnitude: null,
          tone: null,
          reportCount: 1,
          actors: [],
          raw: {
            feed: config.id,
            title: item.title,
            link: item.link,
            categories: item.categories,
            published: item.published?.toISOString() ?? null,
          },
        });
      }

      ctx.log.debug({ source: config.id, items: observations.length }, 'feed parsed');

      return {
        observations,
        cursor: {
          etag: response.etag ?? cursor.etag,
          lastModified: response.lastModified ?? cursor.lastModified,
        },
      };
    },
  };
}

export const newsConnectors: SourceDefinition[] = NEWS_FEEDS.map(createRssConnector);
