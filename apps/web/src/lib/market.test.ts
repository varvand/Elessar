import { describe, expect, it } from 'vitest';
import type { EventDto } from './api-types';
import { deriveMarketImpact } from './market';

function event(overrides: Partial<EventDto>): EventDto {
  return {
    id: 'event-1',
    title: 'Test event',
    summary: null,
    category: 'other',
    status: 'active',
    severity: 70,
    confidence: 80,
    velocity: 1,
    lat: null,
    lon: null,
    geoPrecision: 'unknown',
    placeName: null,
    countryCode: null,
    observationCount: 1,
    sourceCount: 1,
    firstSeenAt: '2026-08-15T10:00:00Z',
    lastSeenAt: '2026-08-15T10:00:00Z',
    ...overrides,
  };
}

describe('market impact model', () => {
  it('keeps severity separate from derived market materiality', () => {
    const input = event({ category: 'armed_conflict' });
    const impact = deriveMarketImpact(input);

    expect(impact).not.toBeNull();
    expect(impact?.materiality).not.toBe(input.severity);
    expect(impact?.exposures.map((item) => item.label)).toContain('Defense');
    expect(impact?.exposures.map((item) => item.label)).toContain('Regional equities');
  });

  it('requires policy language before assigning sanctions exposures', () => {
    expect(
      deriveMarketImpact(event({ category: 'economy', title: 'Retail sales update' })),
    ).toBeNull();

    const impact = deriveMarketImpact(
      event({ category: 'economy', title: 'New export controls and sanctions announced' }),
    );
    expect(impact?.exposures.map((item) => item.label)).toContain('Affected exporters');
  });

  it('does not force unrelated events into the market feed', () => {
    expect(deriveMarketImpact(event({ category: 'other' }))).toBeNull();
  });
});
