import { describe, expect, it } from 'vitest';
import { __testing } from './gdelt';

const { parseRow, parseLastUpdate, precisionFromGeoType, titleCase, EXPECTED_COLUMNS } = __testing;

/**
 * GDELT's export CSV ships with **no header row**, so the column offsets in
 * `gdelt.ts` *are* the schema. If they drift, every field silently reads its
 * neighbour: the Goldstein scale becomes a mention count, coordinates become
 * feature ids, and the whole backbone source produces confident nonsense.
 *
 * The row below is a real 2026 export line, reduced to the fields that matter.
 */
function buildRow(overrides: Record<number, string> = {}): string[] {
  const fields = new Array<string>(EXPECTED_COLUMNS).fill('');

  fields[0] = '1318443383'; // GLOBALEVENTID
  fields[1] = '20260815'; // SQLDATE
  fields[6] = 'CHINA'; // Actor1Name
  fields[7] = 'CHN'; // Actor1CountryCode
  fields[16] = 'AIR FORCE'; // Actor2Name
  fields[17] = 'USA'; // Actor2CountryCode
  fields[25] = '1'; // IsRootEvent
  fields[26] = '062'; // EventCode
  fields[28] = '06'; // EventRootCode
  fields[29] = '2'; // QuadClass
  fields[30] = '7.4'; // GoldsteinScale
  fields[31] = '10'; // NumMentions
  fields[32] = '3'; // NumSources
  fields[33] = '12'; // NumArticles
  fields[34] = '-42.553191489362'; // AvgTone
  fields[51] = '4'; // ActionGeo_Type (world city)
  fields[52] = 'Beijing, Beijing, China'; // ActionGeo_FullName
  fields[53] = 'CH'; // ActionGeo_CountryCode (FIPS: China)
  fields[54] = 'CH22'; // ActionGeo_ADM1Code
  fields[56] = '39.9289'; // ActionGeo_Lat
  fields[57] = '116.388'; // ActionGeo_Long
  fields[59] = '20260815193000'; // DATEADDED
  fields[60] = 'https://example.com/article'; // SOURCEURL

  for (const [index, value] of Object.entries(overrides)) {
    fields[Number(index)] = value;
  }
  return fields;
}

describe('column offsets', () => {
  it('expects the documented 61-field layout', () => {
    expect(EXPECTED_COLUMNS).toBe(61);
  });

  it('REGRESSION: reads every field from the position the codebook specifies', () => {
    const draft = parseRow(buildRow())!;
    expect(draft).not.toBeNull();

    expect(draft.externalId).toBe('1318443383');
    expect(draft.magnitude).toBeCloseTo(7.4, 6); // GoldsteinScale, col 31 (1-based)
    expect(draft.reportCount).toBe(3); // NumSources, col 33
    expect(draft.url).toBe('https://example.com/article'); // SOURCEURL, col 61
    expect(draft.geo!.point.lat).toBeCloseTo(39.9289, 4); // col 57
    expect(draft.geo!.point.lon).toBeCloseTo(116.388, 4); // col 58
    expect(draft.geo!.placeName).toBe('Beijing, Beijing, China'); // col 53
    expect(draft.actors).toEqual(['China', 'Air Force']); // cols 7 and 17
    expect(draft.occurredAt.toISOString()).toBe('2026-08-15T19:30:00.000Z'); // col 60
  });

  it('scales AvgTone from GDELT’s ±100 range into ±1', () => {
    const draft = parseRow(buildRow())!;
    expect(draft.tone).toBeCloseTo(-0.4255, 3);
  });

  it('clamps a tone outside the expected range', () => {
    expect(parseRow(buildRow({ 34: '-500' }))!.tone).toBe(-1);
    expect(parseRow(buildRow({ 34: '500' }))!.tone).toBe(1);
  });

  it('maps the CAMEO root code to a category, not the full event code', () => {
    // Root 19 is "fight"; the full code 190 would not be found in the root table.
    expect(parseRow(buildRow({ 28: '19', 26: '193' }))!.category).toBe('armed_conflict');
    expect(parseRow(buildRow({ 28: '14', 26: '141' }))!.category).toBe('civil_unrest');
    expect(parseRow(buildRow({ 28: '20', 26: '202' }))!.category).toBe('terrorism');
  });

  it('leaves countryCode null for the gazetteer to resolve', () => {
    // GDELT's ActionGeo_CountryCode is FIPS, which disagrees with ISO. The raw
    // code is preserved for provenance; the country is derived from coordinates.
    const draft = parseRow(buildRow())!;
    expect(draft.geo!.countryCode).toBeNull();
    const raw = draft.raw as { actionGeo: { fipsCountryCode: string } };
    expect(raw.actionGeo.fipsCountryCode).toBe('CH');
  });
});

describe('row filtering', () => {
  it('drops rows below the mention threshold', () => {
    // GDELT's long tail is dominated by routine "make public statement" codings
    // that outnumber genuine signal roughly 50:1.
    expect(parseRow(buildRow({ 31: '1' }))).toBeNull();
    expect(parseRow(buildRow({ 31: '0' }))).toBeNull();
    expect(parseRow(buildRow({ 31: '2' }))).not.toBeNull();
  });

  it('drops rows with no usable coordinates', () => {
    // GDELT gives no text body, so an unlocated row cannot be recovered later.
    expect(parseRow(buildRow({ 56: '', 57: '' }))).toBeNull();
    expect(parseRow(buildRow({ 56: '0', 57: '0' }))).toBeNull(); // the "unknown" sentinel
  });

  it('drops rows with no event id', () => {
    expect(parseRow(buildRow({ 0: '' }))).toBeNull();
  });
});

describe('precisionFromGeoType', () => {
  it('REGRESSION: maps GDELT geo types so a country guess is not a city pin', () => {
    // 1 = country, 2 = US state, 3 = US city, 4 = world city, 5 = world state.
    expect(precisionFromGeoType('1')).toBe('country');
    expect(precisionFromGeoType('2')).toBe('admin1');
    expect(precisionFromGeoType('3')).toBe('city');
    expect(precisionFromGeoType('4')).toBe('city');
    expect(precisionFromGeoType('5')).toBe('admin1');
    expect(precisionFromGeoType('')).toBe('unknown');
    expect(precisionFromGeoType('9')).toBe('unknown');
  });
});

describe('titleCase', () => {
  it('makes SHOUTING actor names readable', () => {
    expect(titleCase('CHINA')).toBe('China');
    expect(titleCase('AIR FORCE')).toBe('Air Force');
    expect(titleCase('UNITED STATES')).toBe('United States');
  });
});

describe('title synthesis', () => {
  it('builds a readable headline from the CAMEO coding', () => {
    // GDELT has no headline of its own; the feed must be legible without opening
    // the source article.
    const both = parseRow(buildRow())!;
    expect(both.title).toContain('China');
    expect(both.title).toContain('Air Force');
    expect(both.title).toContain('Beijing');

    const oneActor = parseRow(buildRow({ 16: '' }))!;
    expect(oneActor.title).toContain('China');

    const noActors = parseRow(buildRow({ 6: '', 16: '' }))!;
    expect(noActors.title.length).toBeGreaterThan(0);
  });
});

describe('parseLastUpdate', () => {
  it('picks the export file out of the three-line manifest', () => {
    const body = [
      '32879 50a00c8b http://data.gdeltproject.org/gdeltv2/20260815191500.export.CSV.zip',
      '52769 89c4d1a8 http://data.gdeltproject.org/gdeltv2/20260815191500.mentions.CSV.zip',
      '2722773 a808994b http://data.gdeltproject.org/gdeltv2/20260815191500.gkg.csv.zip',
    ].join('\n');

    const result = parseLastUpdate(body);
    expect(result!.stamp).toBe('20260815191500');
    expect(result!.exportUrl).toContain('.export.CSV.zip');
  });

  it('returns null rather than guessing when the manifest is unrecognizable', () => {
    expect(parseLastUpdate('')).toBeNull();
    expect(parseLastUpdate('garbage')).toBeNull();
    expect(parseLastUpdate('123 abc http://example.com/other.zip')).toBeNull();
  });
});
