import {
  cleanText,
  parseDate,
  truncate,
  type FetchContext,
  type FetchResult,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/** NOAA Space Weather Prediction Center active products. */

const FEED_URL = 'https://services.swpc.noaa.gov/products/alerts.json';

interface SwpcProduct {
  product_id?: string;
  issue_datetime?: string;
  message?: string;
}

function parseUtcDate(value: string | undefined): Date | null {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  return parseDate(normalized);
}

function scaleFor(message: string): number | null {
  const direct = message.match(/\b[GRS]([1-5])\b/i);
  if (direct?.[1]) return Number(direct[1]);

  const kIndex = message.match(/K-index of\s*([4-9])/i);
  if (!kIndex?.[1]) return null;
  return Math.max(1, Number(kIndex[1]) - 4);
}

function headlineFor(message: string): string | null {
  const line = message
    .split(/\r?\n/)
    .map((part) => cleanText(part))
    .find((part) => /^(?:ALERT|SUMMARY|WARNING|WATCH):/i.test(part));
  return line ?? null;
}

function toDraft(product: SwpcProduct): ObservationDraft | null {
  const message = cleanText(product.message);
  const occurredAt = parseUtcDate(product.issue_datetime);
  if (!message || !occurredAt || /\bCANCEL(?:LED)?\b/i.test(message)) return null;

  const headline = headlineFor(product.message ?? '');
  const serial = message.match(/Serial Number:\s*(\d+)/i)?.[1] ?? 'none';
  const title = headline ?? `NOAA space weather product ${product.product_id ?? ''}`.trim();

  return {
    sourceId: 'noaa.swpc',
    externalId: `${product.product_id ?? 'product'}:${occurredAt.toISOString()}:${serial}`,
    title,
    body: truncate(message, 1800),
    url: FEED_URL,
    occurredAt,
    publishedAt: occurredAt,
    geo: null,
    placeHint: null,
    category: 'space',
    magnitude: scaleFor(message),
    tone: -0.35,
    reportCount: 1,
    actors: ['NOAA Space Weather Prediction Center'],
    raw: product,
  };
}

export const swpcConnector: SourceDefinition = {
  id: 'noaa.swpc',
  name: 'NOAA Space Weather Alerts',
  homepage: 'https://www.swpc.noaa.gov/',
  license: 'United States Government work, public domain',
  intervalSeconds: 300,
  minRequestIntervalMs: 1500,
  emits: ['space'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cursor = (ctx.cursor ?? {}) as { etag?: string; lastModified?: string };
    const response = await ctx.http.get(FEED_URL, {
      etag: cursor.etag,
      lastModified: cursor.lastModified,
      signal: ctx.signal,
    });

    if (response.notModified) {
      return { observations: [], cursor, notModified: true };
    }

    const payload = await response.json<SwpcProduct[]>();
    const observations = (Array.isArray(payload) ? payload : [])
      .map(toDraft)
      .filter((draft): draft is ObservationDraft => draft !== null);

    ctx.log.debug({ products: observations.length }, 'NOAA space weather products parsed');
    return {
      observations,
      cursor: {
        etag: response.etag ?? cursor.etag,
        lastModified: response.lastModified ?? cursor.lastModified,
      },
    };
  },
};

export const __testing = { headlineFor, parseUtcDate, scaleFor, toDraft };
