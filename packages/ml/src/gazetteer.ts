import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, haversineKm, isStopword, normalizeKey, type GeoPoint } from '@elessar/core';

/**
 * Offline gazetteer, built from the GeoNames `cities15000` dump (CC BY 4.0).
 *
 * Everything geographic in Elessar runs through here — forward geocoding from a
 * place name, reverse geocoding from coordinates, and the authoritative
 * FIPS→ISO country crosswalk that GDELT needs. Offline and in-process because a
 * hosted geocoder would be the pipeline's rate limit, its cost centre, and a
 * privacy leak all at once.
 *
 * ~34,000 populated places of 15,000+ inhabitants. That resolution is a
 * deliberate tradeoff: it covers essentially every place that appears in
 * international reporting while fitting in ~15 MB of resident memory. Villages
 * are missed, and for those we fall back to admin1 or country precision — which
 * `GeoPrecision` then records honestly rather than pretending to a fix we
 * do not have.
 */

const log = createLogger({ module: 'gazetteer' });

export interface Place {
  geonameId: number;
  name: string;
  lat: number;
  lon: number;
  countryCode: string;
  admin1: string;
  population: number;
}

export interface Country {
  iso2: string;
  iso3: string;
  fips: string;
  name: string;
  /** Population-weighted centroid of the country's known cities. */
  centroid: GeoPoint | null;
}

/** Grid cell size for the reverse-geocoding index, in degrees. */
const INDEX_CELL_DEG = 2;

/**
 * A name → place mapping, tagged with where the name came from.
 *
 * The distinction is load-bearing. GeoNames' `alternatenames` column is a
 * grab-bag of transliterations, abbreviations and historical names, and after
 * diacritic folding it collides violently with ordinary English vocabulary:
 * "from" resolves to Frome (GB), "for" to Fortaleza (BR), "and" to Anderson
 * (US), "way" to Toay (AR). Treating those as equal to a primary name is what
 * put an Indonesian earthquake in Brazil.
 */
interface NameEntry {
  placeIndex: number;
  isPrimary: boolean;
}

interface GazetteerData {
  places: Place[];
  /** Normalized name → candidates, primary names first. */
  nameIndex: Map<string, NameEntry[]>;
  /** "latBin:lonBin" → place indices, for bounded reverse lookup. */
  spatialIndex: Map<string, number[]>;
  countriesByIso2: Map<string, Country>;
  countriesByFips: Map<string, Country>;
  countriesByName: Map<string, Country>;
}

let data: GazetteerData | null = null;

/**
 * Overridable data directory.
 *
 * Exists so the test suite can load a small fixture gazetteer instead of the
 * real 3 MB download. Without this the geocoder's regression tests — the ones
 * guarding against pins landing in the wrong country — would have to be skipped
 * on any machine that had not run `pnpm db:seed-gazetteer`, which is precisely
 * where a silent skip is most dangerous.
 */
let dataDirOverride: string | null = null;

function dataDir(): string {
  return dataDirOverride ?? resolve(process.cwd(), 'data/gazetteer');
}

export function gazetteerFiles(): { cities: string; countries: string } {
  return {
    cities: resolve(dataDir(), 'cities15000.txt'),
    countries: resolve(dataDir(), 'countryInfo.txt'),
  };
}

export function isGazetteerSeeded(): boolean {
  const files = gazetteerFiles();
  return existsSync(files.cities) && existsSync(files.countries);
}

function spatialKey(lat: number, lon: number): string {
  return `${Math.floor(lat / INDEX_CELL_DEG)}:${Math.floor(lon / INDEX_CELL_DEG)}`;
}

/**
 * GeoNames `cities15000.txt` columns (tab-separated, no header):
 *  0 geonameid   1 name        2 asciiname   3 alternatenames
 *  4 latitude    5 longitude   6 feature cls 7 feature code
 *  8 country     9 cc2        10 admin1     11 admin2
 * 12 admin3     13 admin4     14 population 15 elevation
 * 16 dem        17 timezone   18 modified
 */
function parseCities(text: string): { places: Place[]; nameIndex: Map<string, NameEntry[]> } {
  const places: Place[] = [];
  const nameIndex = new Map<string, NameEntry[]>();

  const addName = (name: string, index: number, isPrimary: boolean) => {
    const key = normalizeKey(name);
    // Very short keys are pure noise against free text ("Or", "As", "Hit").
    if (key.length < 3) return;

    // A place name that is also an ordinary English word cannot be matched
    // safely in running prose, so it is never indexed from an alternate name.
    // Primary names are kept (Nice, Split and Reading are real cities) and are
    // instead protected by the capitalization test at match time.
    if (!isPrimary && (isStopword(key) || key.length < 5)) return;

    const existing = nameIndex.get(key);
    if (existing) {
      existing.push({ placeIndex: index, isPrimary });
    } else {
      nameIndex.set(key, [{ placeIndex: index, isPrimary }]);
    }
  };

  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 15) continue;

    const lat = Number.parseFloat(f[4] ?? '');
    const lon = Number.parseFloat(f[5] ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const index = places.length;
    places.push({
      geonameId: Number.parseInt(f[0] ?? '0', 10),
      name: f[1] ?? '',
      lat,
      lon,
      countryCode: (f[8] ?? '').toUpperCase(),
      admin1: f[10] ?? '',
      population: Number.parseInt(f[14] ?? '0', 10) || 0,
    });

    addName(f[1] ?? '', index, true);
    if (f[2] && f[2] !== f[1]) addName(f[2], index, true);

    // Alternate names carry the genuinely useful exonyms ("Kiev" for Kyiv,
    // "Cologne" for Köln) that feeds actually use, so they are worth indexing —
    // but only as second-class candidates, per the NameEntry doc comment.
    for (const alternate of (f[3] ?? '').split(',')) {
      if (alternate.length >= 3) addName(alternate, index, false);
    }
  }

  // Order candidates: primary names before alternates, then by population, so
  // an ambiguous bare name resolves to the most prominent plausible place.
  for (const entries of nameIndex.values()) {
    if (entries.length > 1) {
      entries.sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        return (places[b.placeIndex]?.population ?? 0) - (places[a.placeIndex]?.population ?? 0);
      });
      if (entries.length > 12) entries.length = 12;
    }
  }

  return { places, nameIndex };
}

/**
 * `countryInfo.txt` columns: ISO, ISO3, ISO-Numeric, fips, Country, Capital, …
 *
 * The `fips` column is what makes this file valuable beyond country names: it is
 * an authoritative FIPS 10-4 → ISO 3166-1 crosswalk, which is exactly what
 * GDELT's location codes need. Deriving it from data rather than hand-typing it
 * removes a whole class of silent mislabelling bug.
 */
function parseCountries(text: string): {
  byIso2: Map<string, Country>;
  byFips: Map<string, Country>;
  byName: Map<string, Country>;
} {
  const byIso2 = new Map<string, Country>();
  const byFips = new Map<string, Country>();
  const byName = new Map<string, Country>();

  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 5) continue;

    const country: Country = {
      iso2: (f[0] ?? '').toUpperCase(),
      iso3: (f[1] ?? '').toUpperCase(),
      fips: (f[3] ?? '').toUpperCase(),
      name: f[4] ?? '',
      centroid: null,
    };
    if (country.iso2 === '') continue;

    byIso2.set(country.iso2, country);
    if (country.fips !== '') byFips.set(country.fips, country);
    if (country.name !== '') byName.set(normalizeKey(country.name), country);
  }

  // GeoNames lists one official name per country, but reporting uses colloquial
  // forms constantly. Without these, "Britain", "the US" and "South Korea" are
  // invisible to the text scanner. Short and verifiable by inspection, unlike a
  // full FIPS table — and every entry maps to a code the file itself supplies.
  const ALIASES: Record<string, string> = {
    'united states': 'US',
    'united states of america': 'US',
    usa: 'US',
    america: 'US',
    'the us': 'US',
    'u s': 'US',
    'united kingdom': 'GB',
    uk: 'GB',
    britain: 'GB',
    'great britain': 'GB',
    england: 'GB',
    scotland: 'GB',
    wales: 'GB',
    'northern ireland': 'GB',
    'south korea': 'KR',
    'north korea': 'KP',
    'south africa': 'ZA',
    'south sudan': 'SS',
    russia: 'RU',
    'russian federation': 'RU',
    iran: 'IR',
    syria: 'SY',
    vietnam: 'VN',
    laos: 'LA',
    myanmar: 'MM',
    burma: 'MM',
    tanzania: 'TZ',
    venezuela: 'VE',
    bolivia: 'BO',
    moldova: 'MD',
    czechia: 'CZ',
    'czech republic': 'CZ',
    turkiye: 'TR',
    turkey: 'TR',
    'ivory coast': 'CI',
    'cote divoire': 'CI',
    'cape verde': 'CV',
    'democratic republic of the congo': 'CD',
    'dr congo': 'CD',
    congo: 'CD',
    'republic of the congo': 'CG',
    palestine: 'PS',
    gaza: 'PS',
    'gaza strip': 'PS',
    'west bank': 'PS',
    'the netherlands': 'NL',
    holland: 'NL',
    macedonia: 'MK',
    'north macedonia': 'MK',
    eswatini: 'SZ',
    swaziland: 'SZ',
    taiwan: 'TW',
    'hong kong': 'HK',
    'united arab emirates': 'AE',
    uae: 'AE',
    'saudi arabia': 'SA',
    'sri lanka': 'LK',
    'new zealand': 'NZ',
    'papua new guinea': 'PG',
    'costa rica': 'CR',
    'dominican republic': 'DO',
    'el salvador': 'SV',
    'puerto rico': 'PR',
    laosia: 'LA',
    brunei: 'BN',
    'east timor': 'TL',
    'timor leste': 'TL',
  };

  for (const [alias, iso2] of Object.entries(ALIASES)) {
    const country = byIso2.get(iso2);
    // Never shadow an official name with an alias — "Congo" must not overwrite
    // whichever Congo GeoNames named that way.
    if (country && !byName.has(alias)) byName.set(alias, country);
  }

  return { byIso2, byFips, byName };
}

/**
 * Load and index the gazetteer. Idempotent; safe to call from many places.
 *
 * `options.dir` points the loader at an alternative data directory and forces a
 * reload — for tests and for deployments that ship the gazetteer elsewhere.
 */
export async function loadGazetteer(options?: { dir?: string }): Promise<void> {
  if (options?.dir && options.dir !== dataDirOverride) {
    dataDirOverride = options.dir;
    data = null; // a different corpus must not be served from a stale index
  }
  if (data) return;

  const files = gazetteerFiles();
  if (!isGazetteerSeeded()) {
    throw new Error(
      `Gazetteer not found at ${dataDir()}. Run \`pnpm db:seed-gazetteer\` to download it.`,
    );
  }

  const started = Date.now();
  const [citiesText, countriesText] = await Promise.all([
    readFile(files.cities, 'utf8'),
    readFile(files.countries, 'utf8'),
  ]);

  const { places, nameIndex } = parseCities(citiesText);
  const { byIso2, byFips, byName } = parseCountries(countriesText);

  // Spatial index for reverse lookup. Without it, every reverse geocode is a
  // 34k-element scan; at GDELT's ~600 observations per cycle that is 20M
  // haversines per run, which dominates the whole pipeline.
  const spatialIndex = new Map<string, number[]>();
  for (let i = 0; i < places.length; i += 1) {
    const place = places[i]!;
    const key = spatialKey(place.lat, place.lon);
    const bucket = spatialIndex.get(key);
    if (bucket) bucket.push(i);
    else spatialIndex.set(key, [i]);
  }

  // Population-weighted country centroids, for country-precision fallbacks.
  const accumulator = new Map<string, { lat: number; lon: number; weight: number }>();
  for (const place of places) {
    if (!place.countryCode) continue;
    const weight = Math.max(place.population, 1);
    const entry = accumulator.get(place.countryCode);
    if (entry) {
      entry.lat += place.lat * weight;
      entry.lon += place.lon * weight;
      entry.weight += weight;
    } else {
      accumulator.set(place.countryCode, {
        lat: place.lat * weight,
        lon: place.lon * weight,
        weight,
      });
    }
  }
  for (const [iso2, sums] of accumulator) {
    const country = byIso2.get(iso2);
    if (country && sums.weight > 0) {
      country.centroid = { lat: sums.lat / sums.weight, lon: sums.lon / sums.weight };
    }
  }

  data = {
    places,
    nameIndex,
    spatialIndex,
    countriesByIso2: byIso2,
    countriesByFips: byFips,
    countriesByName: byName,
  };

  log.info(
    {
      places: places.length,
      names: nameIndex.size,
      countries: byIso2.size,
      ms: Date.now() - started,
    },
    'gazetteer loaded',
  );
}

function requireData(): GazetteerData {
  if (!data) {
    throw new Error('Gazetteer not loaded. Call loadGazetteer() during startup.');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Exact-name lookup, for a string already known to be a place name (a source's
 * `placeHint`, a dateline). Safe to match loosely here precisely because the
 * caller has already asserted this is a location — unlike free-text scanning.
 */
export function findPlaceByName(name: string, countryHint?: string | null): Place | null {
  const { places, nameIndex } = requireData();
  const candidates = nameIndex.get(normalizeKey(name));
  if (!candidates?.length) return null;

  if (countryHint) {
    const hint = countryHint.toUpperCase();
    for (const entry of candidates) {
      const place = places[entry.placeIndex];
      if (place?.countryCode === hint) return place;
    }
  }
  // Pre-sorted: primary names first, then by population.
  return places[candidates[0]!.placeIndex] ?? null;
}

/**
 * Nearest populated place to a point, searching outward through spatial index
 * rings until a hit is found or the radius budget is exhausted.
 */
export function findNearestPlace(point: GeoPoint, maxKm = 200): Place | null {
  const { places, spatialIndex } = requireData();

  const centreLatBin = Math.floor(point.lat / INDEX_CELL_DEG);
  const centreLonBin = Math.floor(point.lon / INDEX_CELL_DEG);

  let best: Place | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  // Each ring adds one cell of reach in every direction (~222 km at the
  // equator); one extra ring absorbs the cell-narrowing toward the poles.
  const maxRing = Math.max(1, Math.ceil(maxKm / (INDEX_CELL_DEG * 111)) + 1);

  // Longitude bins produced by `spatialKey` span [-180/CELL, 180/CELL), so
  // wrapping has to land in that same range — not [0, span) — or antimeridian
  // lookups silently miss every bucket.
  const lonSpan = Math.round(360 / INDEX_CELL_DEG);
  const halfSpan = lonSpan / 2;
  const wrapLonBin = (bin: number): number =>
    (((bin + halfSpan) % lonSpan) + lonSpan) % lonSpan - halfSpan;

  for (let ring = 0; ring <= maxRing; ring += 1) {
    for (let dLat = -ring; dLat <= ring; dLat += 1) {
      for (let dLon = -ring; dLon <= ring; dLon += 1) {
        // Only the perimeter of this ring is new work.
        if (ring > 0 && Math.abs(dLat) !== ring && Math.abs(dLon) !== ring) continue;

        const bucket = spatialIndex.get(
          `${centreLatBin + dLat}:${wrapLonBin(centreLonBin + dLon)}`,
        );
        if (!bucket) continue;

        for (const index of bucket) {
          const place = places[index];
          if (!place) continue;
          const distance = haversineKm(point, { lat: place.lat, lon: place.lon });
          if (distance < bestDistance) {
            bestDistance = distance;
            best = place;
          }
        }
      }
    }
    // The rings searched so far guarantee coverage out to this radius, so a hit
    // inside it cannot be beaten by anything further out.
    if (best && bestDistance <= ring * INDEX_CELL_DEG * 111) break;
  }

  return best && bestDistance <= maxKm ? best : null;
}

export function getCountryByIso2(iso2: string): Country | null {
  return requireData().countriesByIso2.get(iso2.toUpperCase()) ?? null;
}

/**
 * FIPS 10-4 → ISO 3166-1 alpha-2, from GeoNames' own crosswalk.
 * This is what makes GDELT's location codes usable.
 */
export function fipsToIso2(fips: string | null | undefined): string | null {
  if (!fips) return null;
  return requireData().countriesByFips.get(fips.toUpperCase())?.iso2 ?? null;
}

export function findCountryByName(name: string): Country | null {
  return requireData().countriesByName.get(normalizeKey(name)) ?? null;
}

/**
 * A location found by scanning free text, with how specific the match was.
 *
 * Callers need the distinction so `GeoPrecision` can be set honestly: a country
 * mention is real evidence but locates an event only to a national centroid.
 */
export interface TextLocation {
  kind: 'place' | 'country';
  place: Place | null;
  country: Country | null;
}

/**
 * Tokenize while keeping each token's original capitalization alongside its
 * normalized form. Capitalization is the single most useful signal available for
 * telling a place name from an identically-spelled common word, and it is
 * destroyed by normalization — so both forms have to be carried together.
 */
function tokenizeWithCase(text: string): { raw: string; norm: string }[] {
  const tokens: { raw: string; norm: string }[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}'’-]+/u)) {
    if (raw === '') continue;
    const norm = normalizeKey(raw);
    if (norm === '') continue;
    tokens.push({ raw, norm });
  }
  return tokens;
}

function isCapitalized(token: string): boolean {
  const first = token[0];
  if (!first) return false;
  // `toLowerCase() !== first` also catches non-Latin scripts without case,
  // which we must not reject — hence the explicit uppercase comparison.
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

/**
 * Minimum population for a *single-word* city match found in free text.
 *
 * Multi-word matches ("New York", "Cape Town") are specific enough to trust at
 * any size. A lone capitalized word is far riskier — surnames, brands and
 * sentence-initial words all look like place names — so it must name a place
 * prominent enough to plausibly be the subject of international reporting.
 */
const MIN_POPULATION_FOR_BARE_WORD = 200_000;

/**
 * Scan free text for the location it is about.
 *
 * Rules, in priority order:
 *   1. Multi-word primary place name (highest specificity)
 *   2. Country name
 *   3. Single capitalized primary place name above a population floor
 *
 * Every candidate must be capitalized in the original text. That one rule
 * eliminates the entire class of failure where "from", "for", "and" and "hit"
 * resolved to Frome, Fortaleza, Anderson and Hīt.
 *
 * Countries outrank bare city names because country names are nearly unique
 * strings, whereas a bare city name is frequently a coincidence. "…kills at
 * least 47 in Indonesia" should resolve to Indonesia, not to a small town that
 * happens to share a name with an English word.
 */
export function findPlaceInText(text: string, maxWords = 4): Place | null {
  const found = findLocationInText(text, maxWords);
  return found?.place ?? null;
}

export function findLocationInText(text: string, maxWords = 4): TextLocation | null {
  const { places, nameIndex, countriesByName } = requireData();
  const tokens = tokenizeWithCase(text);
  if (tokens.length === 0) return null;

  let bestMultiWord: Place | null = null;
  let bestMultiWordSize = 0;
  let bestCountry: Country | null = null;
  let bestBareWord: Place | null = null;

  for (let size = Math.min(maxWords, tokens.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const window = tokens.slice(start, start + size);

      // Require every token in the candidate span to be capitalized.
      if (!window.every((token) => isCapitalized(token.raw))) continue;

      const phrase = window.map((token) => token.norm).join(' ');
      if (phrase.length < 3) continue;

      // Countries first — an unambiguous, high-value match.
      const country = countriesByName.get(phrase);
      if (country && !bestCountry) bestCountry = country;

      const candidates = nameIndex.get(phrase);
      if (!candidates?.length) continue;

      // Only primary names are trusted from free text; alternates are reserved
      // for explicit `findPlaceByName` lookups where the caller vouches for the
      // string being a location.
      const primary = candidates.find((entry) => entry.isPrimary);
      if (!primary) continue;

      const place = places[primary.placeIndex];
      if (!place) continue;

      if (size > 1) {
        if (size > bestMultiWordSize) {
          bestMultiWordSize = size;
          bestMultiWord = place;
        }
      } else if (
        place.population >= MIN_POPULATION_FOR_BARE_WORD &&
        !isStopword(phrase) &&
        (!bestBareWord || place.population > bestBareWord.population)
      ) {
        bestBareWord = place;
      }
    }
  }

  if (bestMultiWord) return { kind: 'place', place: bestMultiWord, country: null };
  if (bestCountry) return { kind: 'country', place: null, country: bestCountry };
  if (bestBareWord) return { kind: 'place', place: bestBareWord, country: null };
  return null;
}

export function gazetteerStats(): { places: number; names: number; countries: number } | null {
  if (!data) return null;
  return {
    places: data.places.length,
    names: data.nameIndex.size,
    countries: data.countriesByIso2.size,
  };
}
