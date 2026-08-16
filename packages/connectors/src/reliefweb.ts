import {
  cleanText,
  loadEnv,
  parseDate,
  truncate,
  type EventCategory,
  type FetchContext,
  type FetchResult,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';

/**
 * ReliefWeb reports published by UN OCHA and its humanitarian partners.
 *
 * The API requires a registered app name. It is not a secret, but ReliefWeb
 * uses it to identify clients and enforce its public rate limit.
 */

const API_URL = 'https://api.reliefweb.int/v2/reports';

interface ReliefWebItem {
  id: string | number;
  fields?: {
    title?: string;
    body?: string;
    url?: string;
    url_alias?: string;
    date?: { created?: string; original?: string; changed?: string };
    country?: { name?: string; iso3?: string }[];
    disaster_type?: { name?: string }[];
    theme?: { name?: string }[];
    source?: { name?: string; shortname?: string }[];
  };
}

interface ReliefWebResponse {
  data?: ReliefWebItem[];
}

function categoryFor(item: ReliefWebItem): EventCategory {
  const fields = item.fields;
  const text = [
    fields?.title,
    fields?.body,
    ...(fields?.disaster_type?.map((entry) => entry.name) ?? []),
    ...(fields?.theme?.map((entry) => entry.name) ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/\b(cholera|disease|epidemic|health|measles|outbreak|pandemic)\b/.test(text)) {
    return 'health';
  }
  if (/\b(conflict|fighting|hostilities|violence|war)\b/.test(text)) {
    return 'armed_conflict';
  }
  if (/\b(cyclone|flood|hurricane|storm|typhoon)\b/.test(text)) {
    return 'severe_weather';
  }
  if (/\b(earthquake|landslide|tsunami|volcano)\b/.test(text)) {
    return 'natural_disaster';
  }
  return 'humanitarian';
}

function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function toDraft(item: ReliefWebItem): ObservationDraft | null {
  const fields = item.fields;
  const title = cleanText(fields?.title);
  if (!title) return null;

  const occurredAt =
    parseDate(fields?.date?.original) ??
    parseDate(fields?.date?.created) ??
    parseDate(fields?.date?.changed);
  if (!occurredAt) return null;

  const countries =
    fields?.country?.map((country) => cleanText(country.name)).filter(Boolean) ?? [];
  const sources =
    fields?.source?.map((source) => cleanText(source.shortname ?? source.name)).filter(Boolean) ??
    [];

  return {
    sourceId: 'ocha.reliefweb',
    externalId: String(item.id),
    title,
    body: truncate(cleanText(fields?.body), 1800) || null,
    url: safeUrl(fields?.url_alias) ?? safeUrl(fields?.url),
    occurredAt,
    publishedAt: parseDate(fields?.date?.created) ?? occurredAt,
    geo: null,
    placeHint: countries[0] ?? null,
    category: categoryFor(item),
    magnitude: null,
    tone: -0.55,
    reportCount: Math.max(1, sources.length),
    actors: sources,
    raw: {
      id: item.id,
      countries: fields?.country,
      disasterTypes: fields?.disaster_type,
      themes: fields?.theme,
      sources: fields?.source,
    },
  };
}

export const reliefWebConnector: SourceDefinition = {
  id: 'ocha.reliefweb',
  name: 'ReliefWeb Reports',
  homepage: 'https://reliefweb.int/',
  license: 'ReliefWeb API Terms of Service, source attribution retained',
  intervalSeconds: 1800,
  minRequestIntervalMs: 1500,
  requiresEnv: ['RELIEFWEB_APPNAME'],
  emits: ['humanitarian', 'health', 'armed_conflict', 'severe_weather', 'natural_disaster'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cursor = (ctx.cursor ?? {}) as { etag?: string; lastModified?: string };
    const appname = loadEnv().RELIEFWEB_APPNAME;
    if (!appname) throw new Error('RELIEFWEB_APPNAME is required');

    const params = new URLSearchParams({
      appname,
      preset: 'latest',
      profile: 'full',
      limit: '100',
    });
    const response = await ctx.http.get(`${API_URL}?${params.toString()}`, {
      etag: cursor.etag,
      lastModified: cursor.lastModified,
      signal: ctx.signal,
    });

    if (response.notModified) {
      return { observations: [], cursor, notModified: true };
    }

    const payload = await response.json<ReliefWebResponse>();
    const observations = (payload.data ?? [])
      .map(toDraft)
      .filter((draft): draft is ObservationDraft => draft !== null);

    ctx.log.debug({ reports: observations.length }, 'ReliefWeb reports parsed');
    return {
      observations,
      cursor: {
        etag: response.etag ?? cursor.etag,
        lastModified: response.lastModified ?? cursor.lastModified,
      },
    };
  },
};

export const __testing = { categoryFor, toDraft };
