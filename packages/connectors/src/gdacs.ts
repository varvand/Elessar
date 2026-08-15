import {
  cleanText,
  normalizePoint,
  parseDate,
  type EventCategory,
  type FetchContext,
  type FetchResult,
  type ObservationDraft,
  type SourceDefinition,
} from '@elessar/core';
import { XMLParser } from 'fast-xml-parser';
import { asArray, nodeAttr, nodeText } from './rss';

/**
 * GDACS — Global Disaster Alert and Coordination System (EC JRC / UN OCHA).
 *
 * The best free multi-hazard feed there is: earthquakes, tropical cyclones,
 * floods, droughts, wildfires and volcanoes, each with coordinates, a
 * green/orange/red alert level, an affected-population estimate and an ISO3
 * country code. It is also the only source here that pre-computes *humanitarian
 * impact* rather than raw physical magnitude, which is usually the thing an
 * analyst actually cares about.
 *
 * It needs its own parser rather than the generic RSS one because every
 * useful field lives in the `gdacs:` namespace.
 */

const FEED_URL = 'https://www.gdacs.org/xml/rss.xml';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: '#cdata',
});

/** GDACS event type codes → our taxonomy. */
const EVENT_TYPE_CATEGORY: Record<string, EventCategory> = {
  EQ: 'seismic', // earthquake
  TC: 'severe_weather', // tropical cyclone
  FL: 'severe_weather', // flood
  DR: 'natural_disaster', // drought
  WF: 'wildfire', // wildfire
  VO: 'natural_disaster', // volcano
  TS: 'seismic', // tsunami
};

const EVENT_TYPE_LABEL: Record<string, string> = {
  EQ: 'Earthquake',
  TC: 'Tropical cyclone',
  FL: 'Flood',
  DR: 'Drought',
  WF: 'Wildfire',
  VO: 'Volcanic activity',
  TS: 'Tsunami',
};

/**
 * Alert level → the 1/2/3 magnitude scale `severity.ts` expects for this source.
 * GDACS's own colour coding already encodes expected humanitarian impact, so
 * this is the whole magnitude story for GDACS observations.
 */
const ALERT_LEVEL_VALUE: Record<string, number> = {
  green: 1,
  orange: 2,
  red: 3,
};

export const gdacsConnector: SourceDefinition = {
  id: 'gdacs.alerts',
  name: 'GDACS Multi-Hazard Alerts',
  homepage: 'https://www.gdacs.org/',
  license: 'European Commission JRC / UN OCHA — free reuse with attribution',
  intervalSeconds: 600,
  minRequestIntervalMs: 3000,
  emits: ['seismic', 'severe_weather', 'wildfire', 'natural_disaster', 'humanitarian'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cursor = (ctx.cursor ?? {}) as { etag?: string; lastModified?: string };

    const response = await ctx.http.get(FEED_URL, {
      etag: cursor.etag ?? null,
      lastModified: cursor.lastModified ?? null,
      signal: ctx.signal,
    });

    if (response.notModified) {
      return { observations: [], cursor, notModified: true };
    }

    const doc = parser.parse(await response.text()) as Record<string, unknown>;
    const channel = (doc['rss'] as Record<string, unknown> | undefined)?.['channel'] as
      | Record<string, unknown>
      | undefined;

    const items = asArray(channel?.['item']);
    const observations: ObservationDraft[] = [];

    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;

      const eventId = nodeText(item['gdacs:eventid']);
      const episodeId = nodeText(item['gdacs:episodeid']);
      const eventType = (nodeText(item['gdacs:eventtype']) ?? '').toUpperCase();
      if (!eventId) continue;

      // Episodes are revisions of an event (a cyclone's successive advisories).
      // Keying on event+episode keeps each advisory as its own observation, so
      // the event's own timeline shows how it developed.
      const externalId = episodeId ? `${eventType}${eventId}.${episodeId}` : `${eventType}${eventId}`;

      const geoPoint = item['geo:Point'] as Record<string, unknown> | undefined;
      const point =
        normalizePoint(nodeText(geoPoint?.['geo:lat']), nodeText(geoPoint?.['geo:long'])) ??
        pointFromGeorss(nodeText(item['georss:point']));

      const alertLevel = (nodeText(item['gdacs:alertlevel']) ?? '').toLowerCase();
      const country = nodeText(item['gdacs:country']);
      const iso3 = nodeText(item['gdacs:iso3']);

      const severityNode = item['gdacs:severity'];
      const severityValue = Number.parseFloat(nodeAttr(severityNode, 'value') ?? '');
      const severityText = nodeText(severityNode);

      const populationNode = item['gdacs:population'];
      const populationValue = Number.parseFloat(nodeAttr(populationNode, 'value') ?? '');
      const populationText = nodeText(populationNode);

      const fromDate =
        parseDate(nodeText(item['gdacs:fromdate'])) ??
        parseDate(nodeText(item['pubDate'])) ??
        new Date();

      const title = nodeText(item['title']) ?? `${EVENT_TYPE_LABEL[eventType] ?? eventType} alert`;

      observations.push({
        sourceId: 'gdacs.alerts',
        externalId,
        title: cleanText(title),
        body: [
          nodeText(item['description']),
          severityText ? `Severity: ${severityText}.` : null,
          populationText ? `Exposed population: ${populationText}.` : null,
          alertLevel ? `GDACS alert level: ${alertLevel.toUpperCase()}.` : null,
          country ? `Country: ${country}.` : null,
        ]
          .filter(Boolean)
          .join(' '),
        url: nodeText(item['link']),
        occurredAt: fromDate,
        publishedAt: parseDate(nodeText(item['gdacs:dateadded'])) ?? fromDate,
        geo: point
          ? {
              point,
              precision: 'exact',
              placeName: country,
              countryCode: iso3ToIso2(iso3),
              admin1: null,
            }
          : null,
        placeHint: country,
        category: EVENT_TYPE_CATEGORY[eventType] ?? 'natural_disaster',
        magnitude: ALERT_LEVEL_VALUE[alertLevel] ?? 1,
        tone: -0.6,
        reportCount: 1,
        actors: [],
        raw: {
          eventId,
          episodeId,
          eventType,
          alertLevel,
          alertScore: nodeText(item['gdacs:alertscore']),
          severity: { value: severityValue, text: severityText },
          population: { value: populationValue, text: populationText },
          country,
          iso3,
          isCurrent: nodeText(item['gdacs:iscurrent']),
        },
      });
    }

    ctx.log.debug({ alerts: observations.length }, 'GDACS feed parsed');

    return {
      observations,
      cursor: {
        etag: response.etag ?? cursor.etag,
        lastModified: response.lastModified ?? cursor.lastModified,
      },
    };
  },
};

function pointFromGeorss(value: string | null) {
  if (!value) return null;
  const [lat, lon] = value.split(/[\s,]+/);
  return normalizePoint(lat, lon);
}

/**
 * ISO 3166-1 alpha-3 → alpha-2 for the countries GDACS actually reports on
 * (disaster-prone states). Unknown codes return null rather than a guess, so the
 * gazetteer gets a chance to resolve the country from coordinates instead.
 */
const ISO3_TO_ISO2: Record<string, string> = {
  AFG: 'AF', ALB: 'AL', DZA: 'DZ', AGO: 'AO', ARG: 'AR', ARM: 'AM', AUS: 'AU', AUT: 'AT',
  AZE: 'AZ', BHS: 'BS', BGD: 'BD', BLR: 'BY', BEL: 'BE', BLZ: 'BZ', BEN: 'BJ', BTN: 'BT',
  BOL: 'BO', BIH: 'BA', BWA: 'BW', BRA: 'BR', BGR: 'BG', BFA: 'BF', BDI: 'BI', KHM: 'KH',
  CMR: 'CM', CAN: 'CA', CAF: 'CF', TCD: 'TD', CHL: 'CL', CHN: 'CN', COL: 'CO', COM: 'KM',
  COG: 'CG', COD: 'CD', CRI: 'CR', CIV: 'CI', HRV: 'HR', CUB: 'CU', CYP: 'CY', CZE: 'CZ',
  DNK: 'DK', DJI: 'DJ', DMA: 'DM', DOM: 'DO', ECU: 'EC', EGY: 'EG', SLV: 'SV', ERI: 'ER',
  EST: 'EE', ETH: 'ET', FJI: 'FJ', FIN: 'FI', FRA: 'FR', GAB: 'GA', GMB: 'GM', GEO: 'GE',
  DEU: 'DE', GHA: 'GH', GRC: 'GR', GTM: 'GT', GIN: 'GN', GNB: 'GW', GUY: 'GY', HTI: 'HT',
  HND: 'HN', HUN: 'HU', ISL: 'IS', IND: 'IN', IDN: 'ID', IRN: 'IR', IRQ: 'IQ', IRL: 'IE',
  ISR: 'IL', ITA: 'IT', JAM: 'JM', JPN: 'JP', JOR: 'JO', KAZ: 'KZ', KEN: 'KE', KIR: 'KI',
  PRK: 'KP', KOR: 'KR', KWT: 'KW', KGZ: 'KG', LAO: 'LA', LVA: 'LV', LBN: 'LB', LSO: 'LS',
  LBR: 'LR', LBY: 'LY', LTU: 'LT', LUX: 'LU', MDG: 'MG', MWI: 'MW', MYS: 'MY', MDV: 'MV',
  MLI: 'ML', MLT: 'MT', MHL: 'MH', MRT: 'MR', MUS: 'MU', MEX: 'MX', FSM: 'FM', MDA: 'MD',
  MNG: 'MN', MNE: 'ME', MAR: 'MA', MOZ: 'MZ', MMR: 'MM', NAM: 'NA', NPL: 'NP', NLD: 'NL',
  NZL: 'NZ', NIC: 'NI', NER: 'NE', NGA: 'NG', MKD: 'MK', NOR: 'NO', OMN: 'OM', PAK: 'PK',
  PLW: 'PW', PSE: 'PS', PAN: 'PA', PNG: 'PG', PRY: 'PY', PER: 'PE', PHL: 'PH', POL: 'PL',
  PRT: 'PT', QAT: 'QA', ROU: 'RO', RUS: 'RU', RWA: 'RW', WSM: 'WS', STP: 'ST', SAU: 'SA',
  SEN: 'SN', SRB: 'RS', SYC: 'SC', SLE: 'SL', SGP: 'SG', SVK: 'SK', SVN: 'SI', SLB: 'SB',
  SOM: 'SO', ZAF: 'ZA', SSD: 'SS', ESP: 'ES', LKA: 'LK', SDN: 'SD', SUR: 'SR', SWE: 'SE',
  CHE: 'CH', SYR: 'SY', TWN: 'TW', TJK: 'TJ', TZA: 'TZ', THA: 'TH', TLS: 'TL', TGO: 'TG',
  TON: 'TO', TTO: 'TT', TUN: 'TN', TUR: 'TR', TKM: 'TM', TUV: 'TV', UGA: 'UG', UKR: 'UA',
  ARE: 'AE', GBR: 'GB', USA: 'US', URY: 'UY', UZB: 'UZ', VUT: 'VU', VEN: 'VE', VNM: 'VN',
  YEM: 'YE', ZMB: 'ZM', ZWE: 'ZW',
};

function iso3ToIso2(iso3: string | null): string | null {
  if (!iso3) return null;
  return ISO3_TO_ISO2[iso3.toUpperCase()] ?? null;
}
