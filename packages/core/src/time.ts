/** Time helpers. All internal timestamps are UTC `Date` objects. */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / HOUR;
}

export function ageHours(date: Date, now: Date = new Date()): number {
  return (now.getTime() - date.getTime()) / HOUR;
}

/**
 * Parse a date from the many shapes public feeds use, returning null rather
 * than an Invalid Date. Feeds lie about formats constantly; a silent
 * `new Date(undefined)` becomes NaN and poisons every downstream comparison.
 */
export function parseDate(input: unknown): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;

  if (typeof input === 'number') {
    // Heuristic: values below 1e12 are seconds, above are milliseconds.
    const ms = input < 1e12 ? input * 1000 : input;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // GDELT's compact form: YYYYMMDDHHMMSS or YYYYMMDD.
  const compact = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(trimmed);
  if (compact) {
    const [, y, mo, d, h = '00', mi = '00', s = '00'] = compact;
    const parsed = new Date(
      Date.UTC(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
      ),
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const direct = new Date(trimmed);
  return Number.isNaN(direct.getTime()) ? null : direct;
}

/** Floor a date to a bucket, for time-series aggregation. */
export function floorTo(date: Date, bucketMs: number): Date {
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

/** Sleep that rejects promptly when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** "3m ago", "2h ago", "4d ago" — compact enough for a dense feed. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const deltaMs = now.getTime() - date.getTime();
  if (deltaMs < 0) return 'now';
  const mins = Math.floor(deltaMs / MINUTE);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
