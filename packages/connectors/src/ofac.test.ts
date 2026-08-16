import { describe, expect, it } from 'vitest';
import { __testing } from './ofac';

describe('OFAC recent actions parser', () => {
  it('extracts dated sanctions updates and ignores unrelated links', () => {
    const html = `
      <a href="/about-ofac">About</a>
      <div class="search-result views-row">
        <a href="/recent-actions/20260807" hreflang="en">
          Counter Terrorism and Iran-related Designations &amp; Updates
        </a>
      </div>
    `;

    const [draft] = __testing.parseUpdates(html);
    expect(draft?.externalId).toBe('/recent-actions/20260807');
    expect(draft?.occurredAt.toISOString()).toBe('2026-08-07T12:00:00.000Z');
    expect(draft?.title).toContain('Counter Terrorism and Iran-related Designations & Updates');
    expect(draft?.category).toBe('economy');
  });
});
