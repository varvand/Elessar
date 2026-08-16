import { describe, expect, it } from 'vitest';
import { __testing } from './swpc';

describe('NOAA SWPC parser', () => {
  const message = [
    'Space Weather Message Code: WARK04',
    'Serial Number: 5401',
    'Issue Time: 2026 Aug 14 1054 UTC',
    '',
    'WARNING: Geomagnetic K-index of 4 expected',
    'Potential Impacts: Weak power grid fluctuations can occur.',
  ].join('\r\n');

  it('extracts a stable observation and normalized scale', () => {
    const draft = __testing.toDraft({
      product_id: 'K04W',
      issue_datetime: '2026-08-14 10:54:33.670',
      message,
    });

    expect(draft?.externalId).toBe('K04W:2026-08-14T10:54:33.670Z:5401');
    expect(draft?.title).toBe('WARNING: Geomagnetic K-index of 4 expected');
    expect(draft?.magnitude).toBe(1);
    expect(draft?.category).toBe('space');
  });

  it('drops cancellation products from the active event stream', () => {
    expect(
      __testing.toDraft({
        product_id: 'K04W',
        issue_datetime: '2026-08-14 12:00:00',
        message: 'CANCEL WATCH: Geomagnetic K-index warning',
      }),
    ).toBeNull();
  });
});
