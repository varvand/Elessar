import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  findCountryByName,
  findLocationInText,
  findNearestPlace,
  findPlaceByName,
  findPlaceInText,
  fipsToIso2,
  gazetteerStats,
  getCountryByIso2,
  loadGazetteer,
} from './gazetteer';

/**
 * Runs against a fixture gazetteer, not the real 3 MB download, so these tests
 * execute on a fresh clone with no setup. The fixture deliberately contains the
 * exact name collisions that caused real mislocations in production output.
 */
const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '__tests__/fixtures/gazetteer',
);

beforeAll(async () => {
  await loadGazetteer({ dir: FIXTURE_DIR });
});

describe('loading', () => {
  it('indexes the fixture', () => {
    const stats = gazetteerStats();
    expect(stats).not.toBeNull();
    expect(stats!.places).toBeGreaterThan(15);
    expect(stats!.countries).toBeGreaterThan(15);
  });
});

describe('FIPS → ISO crosswalk', () => {
  it('REGRESSION: FIPS SG is Senegal, not Singapore', () => {
    // GDELT tags locations with FIPS 10-4, which disagrees with ISO 3166-1 on a
    // significant minority of countries. The first implementation used a
    // hand-written table and mislabelled Senegal as Singapore — events appeared
    // under the wrong country filter entirely. The crosswalk is now derived from
    // GeoNames' own `fips` column instead of being typed by hand.
    expect(fipsToIso2('SG')).toBe('SN');
    expect(fipsToIso2('SN')).toBe('SG');
  });

  it('REGRESSION: handles the other actively-misleading pairs', () => {
    expect(fipsToIso2('CH')).toBe('CN'); // FIPS CH = China, ISO CH = Switzerland
    expect(fipsToIso2('SZ')).toBe('CH'); // FIPS SZ = Switzerland
    expect(fipsToIso2('BF')).toBe('BS'); // FIPS BF = Bahamas, ISO BF = Burkina Faso
    expect(fipsToIso2('UV')).toBe('BF'); // FIPS UV = Burkina Faso
    expect(fipsToIso2('UK')).toBe('GB');
    expect(fipsToIso2('UP')).toBe('UA');
    expect(fipsToIso2('IZ')).toBe('IQ');
    expect(fipsToIso2('LE')).toBe('LB');
  });

  it('is case-insensitive and null-safe', () => {
    expect(fipsToIso2('sg')).toBe('SN');
    expect(fipsToIso2(null)).toBeNull();
    expect(fipsToIso2(undefined)).toBeNull();
    expect(fipsToIso2('')).toBeNull();
  });

  it('returns null for unknown codes rather than guessing', () => {
    // A guess here silently files an event under the wrong country. Null lets the
    // coordinate-based path resolve it properly instead.
    expect(fipsToIso2('ZZ')).toBeNull();
  });
});

describe('findPlaceByName', () => {
  it('resolves an explicit place hint', () => {
    expect(findPlaceByName('Kyiv')?.countryCode).toBe('UA');
    expect(findPlaceByName('Nairobi')?.countryCode).toBe('KE');
  });

  it('is diacritic- and case-insensitive', () => {
    expect(findPlaceByName('kyiv')?.countryCode).toBe('UA');
    expect(findPlaceByName('Hīt')?.countryCode).toBe('IQ');
  });

  it('honours a country hint to disambiguate', () => {
    // "Lebanon" is both a country and a town in Pennsylvania.
    expect(findPlaceByName('Lebanon', 'US')?.countryCode).toBe('US');
  });

  it('prefers the larger place when a bare name is ambiguous', () => {
    // Absent other evidence, reporting about "Petersburg" more likely means the
    // Russian city of 5.3M than the Virginia town of 32k.
    expect(findPlaceByName('Petersburg')?.countryCode).toBe('RU');
  });

  it('returns null for unknown names', () => {
    expect(findPlaceByName('Nowhereville')).toBeNull();
  });
});

describe('country lookup', () => {
  it('finds countries by official name', () => {
    expect(findCountryByName('Indonesia')?.iso2).toBe('ID');
    expect(findCountryByName('indonesia')?.iso2).toBe('ID');
  });

  it('accepts the colloquial aliases reporting actually uses', () => {
    // GeoNames lists one official name per country; newswire copy does not.
    expect(findCountryByName('Britain')?.iso2).toBe('GB');
    expect(findCountryByName('USA')?.iso2).toBe('US');
    expect(findCountryByName('United States')?.iso2).toBe('US');
  });

  it('computes a population-weighted centroid inside plausible bounds', () => {
    const indonesia = getCountryByIso2('ID');
    expect(indonesia?.centroid).not.toBeNull();
    expect(Math.abs(indonesia!.centroid!.lat)).toBeLessThanOrEqual(90);
    expect(Math.abs(indonesia!.centroid!.lon)).toBeLessThanOrEqual(180);
  });
});

describe('findNearestPlace', () => {
  it('finds the nearest populated place to a coordinate', () => {
    // Just off Ende, Indonesia.
    expect(findNearestPlace({ lat: -8.85, lon: 121.66 }, 100)?.countryCode).toBe('ID');
  });

  it('returns null when nothing is within the radius', () => {
    // Middle of the South Pacific.
    expect(findNearestPlace({ lat: -40, lon: -140 }, 200)).toBeNull();
  });

  it('REGRESSION: searches across the antimeridian', () => {
    // Longitude bins span a negative range, so wrapping them into [0, span)
    // rather than the index's own range made every lookup near ±180° miss all
    // buckets and silently return null.
    const nearTonga = findNearestPlace({ lat: -21.2, lon: -175.1 }, 300);
    expect(nearTonga).not.toBeNull();
    const nearNz = findNearestPlace({ lat: -41.3, lon: 174.8 }, 300);
    expect(nearNz?.countryCode).toBe('NZ');
  });
});

describe('free-text scanning', () => {
  it('REGRESSION: does not match lowercase English words as place names', () => {
    // GeoNames alternate names collide with ordinary vocabulary once diacritics
    // are folded: "from" -> Frome (GB), "for" -> Fortaleza (BR), "and" ->
    // Anderson (US), "hit" -> Hit (IQ). These put an Indonesian earthquake in
    // Brazil and an Indian story in Ohio. Requiring capitalization in the source
    // text eliminates the whole class.
    for (const text of [
      'Death toll from the disaster rises to 69',
      'Rescuers search for survivors',
      'Police and troops deployed to the area',
      'The storm hit overnight',
    ]) {
      const hit = findPlaceInText(text);
      expect(hit, `"${text}" matched ${hit?.name}`).toBeNull();
    }
  });

  it('REGRESSION: prefers a country mention over a spurious city match', () => {
    // "…in Flores, an island in eastern Indonesia" once resolved to Timon,
    // Brazil, because Timon carries "Flores" as an alternate name. Indonesia is
    // the answer a human would give.
    const found = findLocationInText(
      'A search operation is under way to find survivors in Flores, an island in eastern Indonesia.',
    );
    expect(found?.kind).toBe('country');
    expect(found?.country?.iso2).toBe('ID');
  });

  it('still finds genuine capitalized city names', () => {
    expect(findPlaceInText('Explosion reported in central Kyiv overnight')?.countryCode).toBe('UA');
    expect(findPlaceInText('Protests erupt across Nairobi over a new tax bill')?.countryCode).toBe(
      'KE',
    );
  });

  it('prefers the longer multi-word match', () => {
    // "New York City" must not be shadowed by "York".
    expect(findPlaceInText('Reported in New York City today')?.name).toContain('New York');
  });

  it('rejects a small capitalized place, which is usually a coincidence', () => {
    // A lone capitalized word matching a 15k-population town is far more often a
    // surname or a sentence-initial word than a dateline.
    expect(findPlaceInText('York said the report was inaccurate')).toBeNull();
  });

  it('returns null for text with no location at all', () => {
    expect(findLocationInText('Markets closed higher on Tuesday')).toBeNull();
  });
});
