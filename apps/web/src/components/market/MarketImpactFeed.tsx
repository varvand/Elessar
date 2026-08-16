'use client';

import type { EventDto } from '@/lib/api-types';
import type { EventMarketImpact, MarketDirection } from '@/lib/market';
import {
  colorForCategory,
  labelForCategory,
  severityBand,
  SEVERITY_VAR,
  timeAgo,
} from '@/lib/presentation';

export interface MarketImpactItem {
  event: EventDto;
  impact: EventMarketImpact;
}

export function MarketImpactFeed({
  items,
  selectedId,
  onSelect,
  loading,
}: {
  items: MarketImpactItem[];
  selectedId: string | null;
  onSelect: (event: EventDto) => void;
  loading: boolean;
}) {
  if (loading && items.length === 0) {
    return (
      <div className="flex flex-col gap-px p-2">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="skeleton h-[88px] rounded-md" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-[12.5px] text-ink-secondary">No explainable impacts match</p>
        <p className="text-[11px] text-ink-muted">
          Widen the window or lower the impact confidence.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-[var(--line-hairline)]">
      {items.map(({ event, impact }) => (
        <li key={event.id}>
          <button
            type="button"
            onClick={() => onSelect(event)}
            aria-current={selectedId === event.id ? 'true' : undefined}
            className="relative w-full px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
            style={selectedId === event.id ? { background: 'var(--surface-3)' } : undefined}
          >
            <span
              className="absolute inset-y-0 left-0 w-[3px]"
              style={{ background: SEVERITY_VAR[severityBand(event.severity)] }}
              aria-hidden
            />

            <div className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: colorForCategory(event.category) }}
                aria-hidden
              />
              <span
                className="truncate text-[10.5px] font-semibold uppercase tracking-wide"
                style={{ color: colorForCategory(event.category) }}
              >
                {labelForCategory(event.category)}
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-ink-muted tabular">
                {timeAgo(event.lastSeenAt)}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.35] text-ink">{event.title}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="eyebrow">{materialityLabel(impact.materiality)} impact</span>
              <span className="text-[10px] text-ink-muted tabular">
                {impact.materiality} materiality · {impact.confidence} confidence
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {impact.exposures.slice(0, 3).map((exposure) => (
                <span
                  key={exposure.id}
                  className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-secondary"
                >
                  {exposure.label} · {directionLabel(exposure.direction)}
                </span>
              ))}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function materialityLabel(score: number): string {
  if (score >= 70) return 'High';
  if (score >= 50) return 'Moderate';
  return 'Low';
}

export function directionLabel(direction: MarketDirection): string {
  const labels: Record<MarketDirection, string> = {
    positive: 'positive',
    negative: 'negative',
    mixed: 'mixed',
    unclear: 'unclear',
  };
  return labels[direction];
}
