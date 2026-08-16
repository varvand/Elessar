import { describe, expect, it } from 'vitest';
import { __testing } from './reliefweb';

describe('ReliefWeb parser', () => {
  it('normalizes a humanitarian report and retains attribution', () => {
    const draft = __testing.toDraft({
      id: 123,
      fields: {
        title: 'Flood response update',
        body: '<p>Thousands of people need shelter.</p>',
        url_alias: 'https://reliefweb.int/report/example',
        date: { original: '2026-08-15T09:00:00Z' },
        country: [{ name: 'Sudan', iso3: 'SDN' }],
        disaster_type: [{ name: 'Flood' }],
        source: [{ name: 'Example Agency', shortname: 'EA' }],
      },
    });

    expect(draft?.sourceId).toBe('ocha.reliefweb');
    expect(draft?.category).toBe('severe_weather');
    expect(draft?.placeHint).toBe('Sudan');
    expect(draft?.body).toBe('Thousands of people need shelter.');
    expect(draft?.actors).toEqual(['EA']);
  });

  it('uses humanitarian as the conservative default', () => {
    expect(
      __testing.categoryFor({ id: 'x', fields: { title: 'Emergency needs assessment' } }),
    ).toBe('humanitarian');
  });
});
