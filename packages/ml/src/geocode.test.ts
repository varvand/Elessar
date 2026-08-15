import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadGazetteer } from './gazetteer';
import { cellFor, resolveLocation } from './geocode';

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '__tests__/fixtures/gazetteer',
);

beforeAll(async () => {
  await loadGazetteer({ dir: FIXTURE_DIR });
});

/**
 * The geocoder's precedence ladder is where wrong pins come from, and a wrong pin
 * on a situational-awareness globe is worse than no pin. These tests pin down both
 * the ordering and the honesty of the reported precision.
 */
describe('precedence ladder', () => {
  it('trusts source coordinates above everything else', () => {
    // The title says Nairobi; the source says Kyiv. Coordinates win.
    const result = resolveLocation({
      title: 'Something happened in Nairobi',
      body: null,
      placeHint: null,
      geo: {
        point: { lat: 50.4547, lon: 30.5238 },
        precision: 'exact',
        placeName: null,
        countryCode: null,
        admin1: null,
      },
    });
    expect(result!.precision).toBe('exact');
    expect(result!.point.lat).toBeCloseTo(50.4547, 3);
    // Names are backfilled by reverse lookup.
    expect(result!.countryCode).toBe('UA');
  });

  it('uses an explicit place hint before scanning text', () => {
    const result = resolveLocation({
      title: 'Unrelated headline mentioning Rome',
      body: null,
      placeHint: 'Nairobi',
      geo: null,
    });
    expect(result!.countryCode).toBe('KE');
  });

  it('falls back to a city named in the title', () => {
    const result = resolveLocation({
      title: 'Explosion reported in central Kyiv overnight',
      body: null,
      placeHint: null,
      geo: null,
    });
    expect(result!.countryCode).toBe('UA');
    expect(result!.precision).toBe('city');
  });

  it('prefers the title over the body', () => {
    // A body mentions many places for context; the headline names the event's.
    const result = resolveLocation({
      title: 'Protests erupt across Nairobi',
      body: 'Analysts in London and Rome commented on the situation.',
      placeHint: null,
      geo: null,
    });
    expect(result!.countryCode).toBe('KE');
  });

  it('returns null when nothing locatable is present', () => {
    const result = resolveLocation({
      title: 'Markets closed higher on Tuesday',
      body: 'Traders cited routine profit taking.',
      placeHint: null,
      geo: null,
    });
    expect(result).toBeNull();
  });
});

describe('precision honesty', () => {
  it('REGRESSION: reports country precision for a country-only mention', () => {
    // Reporting this as `city` would render a confident pin at a national
    // centroid, which is the exact failure the precision field exists to prevent.
    const result = resolveLocation({
      title: 'Powerful magnitude 7.7 earthquake kills at least 47 in Indonesia',
      body: 'A search and rescue operation is under way to find survivors in Flores, an island in eastern Indonesia.',
      placeHint: null,
      geo: null,
    });
    expect(result).not.toBeNull();
    expect(result!.countryCode).toBe('ID');
    expect(result!.precision).toBe('country');
  });

  it('REGRESSION: never resolves an Indonesian story to Brazil', () => {
    // The original bug, stated as a test: "Flores" is an alternate name of Timon,
    // Brazil, and "from"/"for" match Frome and Fortaleza.
    for (const [title, body] of [
      [
        'Powerful magnitude 7.7 earthquake kills at least 47 in Indonesia',
        'Rescuers search for survivors in Flores.',
      ],
      ['Indonesia hit by earthquake aftershock as rescuers search for survivors', null],
      ['Death toll from Zimbabwe ferry disaster rises to 69', 'Bodies recovered from the lake.'],
    ] as const) {
      const result = resolveLocation({ title, body, placeHint: null, geo: null });
      expect(result?.countryCode, title).not.toBe('BR');
      expect(result?.countryCode, title).not.toBe('GB');
    }
  });

  it('files a Zimbabwe story under Zimbabwe', () => {
    const result = resolveLocation({
      title: 'Death toll from Zimbabwe ferry disaster rises to 69',
      body: 'Police say 23 more bodies have been recovered from the lake.',
      placeHint: null,
      geo: null,
    });
    expect(result!.countryCode).toBe('ZW');
  });

  it('does not let a body city override the country the title established', () => {
    // A story headlined "Indonesia" that mentions Rome in passing is about
    // Indonesia. Taking the body's city would relocate the event to Italy.
    const result = resolveLocation({
      title: 'Aftermath of the disaster in Indonesia',
      body: 'Officials in Rome offered assistance to the affected region.',
      placeHint: null,
      geo: null,
    });
    expect(result!.countryCode).toBe('ID');
  });

  it('accepts a body city that agrees with the title country', () => {
    const result = resolveLocation({
      title: 'Unrest continues across Ukraine',
      body: 'Clashes were reported in Kyiv through the night.',
      placeHint: null,
      geo: null,
    });
    expect(result!.countryCode).toBe('UA');
    expect(result!.precision).toBe('city');
  });
});

describe('FIPS country hint', () => {
  it('resolves a GDELT FIPS code when no other signal exists', () => {
    // GDELT's country field is FIPS; this is the last rung before "unlocated".
    const result = resolveLocation({
      title: 'Reported activity',
      body: null,
      placeHint: null,
      geo: null,
      fipsCountryCode: 'SG', // Senegal in FIPS
    });
    expect(result?.countryCode).toBe('SN');
    expect(result?.precision).toBe('country');
  });
});

describe('cellFor', () => {
  it('produces a stable grid cell for a located result, and null otherwise', () => {
    const located = resolveLocation({
      title: 'Explosion in Kyiv',
      body: null,
      placeHint: null,
      geo: null,
    });
    expect(cellFor(located)).toMatch(/^\d+:-?\d+:-?\d+$/);
    expect(cellFor(null)).toBeNull();
  });
});
