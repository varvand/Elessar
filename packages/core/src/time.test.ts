import { describe, expect, it } from 'vitest';
import { ageHours, floorTo, HOUR, hoursBetween, parseDate, relativeTime, sleep } from './time';

describe('parseDate', () => {
  it('REGRESSION: parses GDELT compact stamps', () => {
    // GDELT's DATEADDED is YYYYMMDDHHMMSS with no separators. `new Date()` reads
    // that as an invalid date, and every GDELT observation would land at the
    // epoch or be dropped.
    const parsed = parseDate('20260815191500');
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe('2026-08-15T19:15:00.000Z');
  });

  it('parses the date-only GDELT variant as UTC midnight', () => {
    expect(parseDate('20260815')!.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('parses ISO 8601 and RFC 822 (the RSS pubDate format)', () => {
    expect(parseDate('2026-08-15T19:15:00Z')!.toISOString()).toBe('2026-08-15T19:15:00.000Z');
    expect(parseDate('Sat, 15 Aug 2026 16:43:23 GMT')!.toISOString()).toBe(
      '2026-08-15T16:43:23.000Z',
    );
  });

  it('distinguishes epoch seconds from milliseconds', () => {
    // USGS gives milliseconds; several other feeds give seconds. Guessing wrong
    // puts events in 1970 or in the year 56,000.
    expect(parseDate(1786791291796)!.getUTCFullYear()).toBe(2026);
    expect(parseDate(1786791291)!.getUTCFullYear()).toBe(2026);
  });

  it('REGRESSION: returns null rather than an Invalid Date', () => {
    // `new Date(garbage)` yields NaN, which poisons every downstream comparison
    // silently — sorts scramble and time gates always pass.
    for (const input of ['', '   ', 'not a date', 'yesterday', null, undefined, {}, [], Number.NaN]) {
      expect(parseDate(input), String(input)).toBeNull();
    }
  });

  it('passes through valid Dates and rejects invalid ones', () => {
    const date = new Date('2026-08-15T00:00:00Z');
    expect(parseDate(date)).toBe(date);
    expect(parseDate(new Date('nonsense'))).toBeNull();
  });
});

describe('hoursBetween / ageHours', () => {
  it('is absolute and order-independent', () => {
    const a = new Date('2026-08-15T00:00:00Z');
    const b = new Date('2026-08-15T06:00:00Z');
    expect(hoursBetween(a, b)).toBeCloseTo(6, 9);
    expect(hoursBetween(b, a)).toBeCloseTo(6, 9);
  });

  it('reports a negative age for future timestamps, so callers must clamp', () => {
    // Deliberately signed: the decay model clamps this itself, and hiding the
    // sign here would conceal genuinely future-dated source data.
    const now = new Date('2026-08-15T00:00:00Z');
    const future = new Date('2026-08-16T00:00:00Z');
    expect(ageHours(future, now)).toBeCloseTo(-24, 9);
  });
});

describe('floorTo', () => {
  it('floors to the hour bucket used by the anomaly detector', () => {
    const result = floorTo(new Date('2026-08-15T19:47:33.123Z'), HOUR);
    expect(result.toISOString()).toBe('2026-08-15T19:00:00.000Z');
  });

  it('is idempotent', () => {
    const once = floorTo(new Date('2026-08-15T19:47:33Z'), HOUR);
    expect(floorTo(once, HOUR).getTime()).toBe(once.getTime());
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-08-15T12:00:00Z');

  it('formats each magnitude compactly', () => {
    expect(relativeTime(new Date('2026-08-15T11:59:30Z'), now)).toBe('now');
    expect(relativeTime(new Date('2026-08-15T11:45:00Z'), now)).toBe('15m ago');
    expect(relativeTime(new Date('2026-08-15T09:00:00Z'), now)).toBe('3h ago');
    expect(relativeTime(new Date('2026-08-12T12:00:00Z'), now)).toBe('3d ago');
    expect(relativeTime(new Date('2026-06-15T12:00:00Z'), now)).toBe('2mo ago');
  });

  it('says "now" rather than a negative duration for future dates', () => {
    expect(relativeTime(new Date('2026-08-16T12:00:00Z'), now)).toBe('now');
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(5000, controller.signal)).rejects.toThrow('aborted');
  });

  it('rejects when aborted mid-sleep, so shutdown is prompt', async () => {
    const controller = new AbortController();
    const pending = sleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow('aborted');
  });
});
