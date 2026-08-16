import {
  cleanText,
  parseDate,
  type FetchContext,
  type FetchResult,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/** OFAC's official recent sanctions list updates. */

const LIST_URL = 'https://ofac.treasury.gov/recent-actions/sanctions-list-updates';
const ORIGIN = 'https://ofac.treasury.gov';

function parseUpdates(html: string): ObservationDraft[] {
  const drafts: ObservationDraft[] = [];
  const seen = new Set<string>();
  const linkPattern = /<a\b[^>]*href=["'](\/recent-actions\/(\d{8}))["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(linkPattern)) {
    const path = match[1];
    const dateCode = match[2];
    const title = cleanText(match[3]);
    if (!path || !dateCode || !title || seen.has(path)) continue;

    const occurredAt = parseDate(
      `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}T12:00:00Z`,
    );
    if (!occurredAt) continue;

    seen.add(path);
    drafts.push({
      sourceId: 'us.ofac',
      externalId: path,
      title: `OFAC: ${title}`,
      body: 'The US Treasury Office of Foreign Assets Control published a sanctions list update.',
      url: `${ORIGIN}${path}`,
      occurredAt,
      publishedAt: occurredAt,
      geo: null,
      placeHint: null,
      category: 'economy',
      magnitude: null,
      tone: -0.45,
      reportCount: 1,
      actors: ['US Treasury', 'Office of Foreign Assets Control'],
      raw: { path, title, date: dateCode },
    });
  }

  return drafts;
}

export const ofacConnector: SourceDefinition = {
  id: 'us.ofac',
  name: 'US Treasury OFAC Updates',
  homepage: LIST_URL,
  license: 'United States Government work, public domain',
  intervalSeconds: 1800,
  minRequestIntervalMs: 2000,
  emits: ['economy'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cursor = (ctx.cursor ?? {}) as { etag?: string; lastModified?: string };
    const response = await ctx.http.get(LIST_URL, {
      etag: cursor.etag,
      lastModified: cursor.lastModified,
      signal: ctx.signal,
    });

    if (response.notModified) {
      return { observations: [], cursor, notModified: true };
    }

    const observations = parseUpdates(await response.text());
    ctx.log.debug({ updates: observations.length }, 'OFAC sanctions updates parsed');
    return {
      observations,
      cursor: {
        etag: response.etag ?? cursor.etag,
        lastModified: response.lastModified ?? cursor.lastModified,
      },
    };
  },
};

export const __testing = { parseUpdates };
