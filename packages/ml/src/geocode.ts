import {
  gridCell,
  type GeoResolution,
  type ParsedObservationDraft,
} from '@elessar/core';
import {
  findLocationInText,
  findNearestPlace,
  findPlaceByName,
  fipsToIso2,
  getCountryByIso2,
} from './gazetteer';

/**
 * Location resolution.
 *
 * Runs a strict precedence ladder, because location is the field most likely to
 * be confidently wrong, and a wrong pin on a situational-awareness globe is
 * worse than no pin at all. Each rung is more speculative than the one above,
 * and the resulting `GeoPrecision` records honestly which rung answered:
 *
 *   1. Coordinates from the source           → keep, enrich place/country names
 *   2. Source's own FIPS/place hint          → gazetteer forward lookup
 *   3. Place mentioned in the title          → gazetteer text scan
 *   4. Place mentioned in the body           → gazetteer text scan
 *   5. Country name anywhere in the text     → country centroid
 *   6. Nothing                               → unlocated
 *
 * Titles are scanned before bodies deliberately: a headline's place reference is
 * almost always the event's location, whereas a body mentions many places for
 * context ("...similar to the 2011 Tōhoku disaster...").
 */

export interface GeocodeInput {
  title: string;
  body: string | null;
  placeHint: string | null;
  /** Coordinates supplied by the connector, if any. */
  geo: GeoResolution | null;
  /** Raw FIPS country code, as GDELT provides. */
  fipsCountryCode?: string | null;
}

export function resolveLocation(input: GeocodeInput): GeoResolution | null {
  // --- 1. Source-supplied coordinates are authoritative -------------------
  if (input.geo) {
    return enrichWithNames(input.geo);
  }

  // --- 2. Explicit place hint from the source ----------------------------
  if (input.placeHint) {
    const countryHint = input.fipsCountryCode ? fipsToIso2(input.fipsCountryCode) : null;
    const place = findPlaceByName(input.placeHint, countryHint);
    if (place) return fromPlace(place, 'city');

    // The hint may be a country name rather than a city.
    const country = countryFromHint(input.placeHint);
    if (country) return country;
  }

  // --- 3. Location named in the title ------------------------------------
  // A city match in the title wins outright; a bare country match is held back
  // as a fallback, since the body may yet name a specific city inside it.
  let countryFallback: GeoResolution | null = null;

  const fromTitle = findLocationInText(input.title);
  if (fromTitle?.kind === 'place' && fromTitle.place) {
    return fromPlace(fromTitle.place, 'city');
  }
  if (fromTitle?.kind === 'country' && fromTitle.country) {
    countryFallback = countryCentroid(fromTitle.country.iso2);
  }

  // --- 4. Location named in the body -------------------------------------
  if (input.body) {
    // Only the opening of the body: a dateline or first paragraph localizes the
    // story, while later paragraphs drift into background and comparisons.
    const lead = input.body.slice(0, 600);
    const fromBody = findLocationInText(lead);

    if (fromBody?.kind === 'place' && fromBody.place) {
      // A city named in the body is only trusted when it is consistent with the
      // country the title established. Otherwise the title governs: a story
      // headlined "Indonesia" that mentions Lisbon in passing is about Indonesia.
      const titleCountry = fromTitle?.country?.iso2 ?? null;
      if (!titleCountry || fromBody.place.countryCode === titleCountry) {
        return fromPlace(fromBody.place, 'city');
      }
    }
    if (!countryFallback && fromBody?.kind === 'country' && fromBody.country) {
      countryFallback = countryCentroid(fromBody.country.iso2);
    }
  }

  if (countryFallback) return countryFallback;

  // --- 5. FIPS country code, if the source gave one ----------------------
  if (input.fipsCountryCode) {
    const iso2 = fipsToIso2(input.fipsCountryCode);
    if (iso2) {
      const resolved = countryCentroid(iso2);
      if (resolved) return resolved;
    }
  }

  // --- 6. Unlocated ------------------------------------------------------
  return null;
}

function fromPlace(
  place: { name: string; lat: number; lon: number; countryCode: string; admin1: string },
  precision: 'exact' | 'city' | 'admin1',
): GeoResolution {
  const country = place.countryCode ? getCountryByIso2(place.countryCode) : null;
  return {
    point: { lat: place.lat, lon: place.lon },
    precision,
    placeName: country ? `${place.name}, ${country.name}` : place.name,
    countryCode: place.countryCode || null,
    admin1: place.admin1 || null,
  };
}

/**
 * Fill in place and country names for a resolution that already has
 * coordinates. This is where GDELT's missing country code gets resolved — from
 * geography rather than from a code table.
 */
function enrichWithNames(geo: GeoResolution): GeoResolution {
  const needsName = !geo.placeName;
  const needsCountry = !geo.countryCode;
  if (!needsName && !needsCountry) return geo;

  // Search radius scales with how precisely the point is known: an exact fix
  // should match a nearby town, while a country centroid may sit in open
  // countryside far from any city.
  const radiusKm = geo.precision === 'exact' ? 100 : geo.precision === 'city' ? 200 : 600;
  const nearest = findNearestPlace(geo.point, radiusKm);
  if (!nearest) return geo;

  const country = nearest.countryCode ? getCountryByIso2(nearest.countryCode) : null;

  return {
    ...geo,
    placeName:
      geo.placeName ??
      (country ? `${nearest.name}, ${country.name}` : nearest.name),
    countryCode: geo.countryCode ?? (nearest.countryCode || null),
    admin1: geo.admin1 ?? (nearest.admin1 || null),
  };
}

function countryFromHint(hint: string): GeoResolution | null {
  // A hint may be a comma-separated list of RSS categories; try each part.
  for (const part of hint.split(/[,;|]/)) {
    const trimmed = part.trim();
    if (trimmed.length < 3) continue;
    const place = findPlaceByName(trimmed);
    if (place) return fromPlace(place, 'city');
  }
  return null;
}

function countryCentroid(iso2: string): GeoResolution | null {
  const country = getCountryByIso2(iso2);
  if (!country?.centroid) return null;
  return {
    point: country.centroid,
    precision: 'country',
    placeName: country.name,
    countryCode: country.iso2,
    admin1: null,
  };
}

/** Convenience wrapper for an observation draft. */
export function resolveObservationLocation(
  draft: Pick<ParsedObservationDraft, 'title' | 'body' | 'placeHint' | 'geo' | 'raw'>,
): GeoResolution | null {
  const raw = draft.raw as { actionGeo?: { fipsCountryCode?: string | null } } | null | undefined;

  return resolveLocation({
    title: draft.title,
    body: draft.body,
    placeHint: draft.placeHint,
    geo: draft.geo,
    fipsCountryCode: raw?.actionGeo?.fipsCountryCode ?? null,
  });
}

/** Grid cell for anomaly baselines, or null when unlocated. */
export function cellFor(geo: GeoResolution | null): string | null {
  return geo ? gridCell(geo.point) : null;
}
