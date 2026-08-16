'use client';

import type { MarketChannel } from '@/lib/market';

export interface MarketFilterState {
  channel: MarketChannel | 'all';
  minConfidence: number;
  hours: number;
  search: string;
}

const CHANNELS: { value: MarketFilterState['channel']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'supply', label: 'Supply' },
  { value: 'policy', label: 'Policy' },
  { value: 'security', label: 'Security' },
  { value: 'operations', label: 'Operations' },
  { value: 'macro', label: 'Macro' },
];

const WINDOWS = [
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 72, label: '3d' },
  { hours: 168, label: '7d' },
];

const CONFIDENCE = [
  { value: 0, label: 'All' },
  { value: 50, label: '50+' },
  { value: 70, label: '70+' },
];

export function MarketFilterBar({
  value,
  onChange,
}: {
  value: MarketFilterState;
  onChange: (next: MarketFilterState) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
      <div className="flex items-center gap-1">
        <span className="eyebrow mr-0.5">Channel</span>
        {CHANNELS.map((channel) => (
          <button
            key={channel.value}
            type="button"
            onClick={() => onChange({ ...value, channel: channel.value })}
            aria-pressed={value.channel === channel.value}
            className="btn"
            data-active={value.channel === channel.value}
          >
            {channel.label}
          </button>
        ))}
      </div>

      <Divider />

      <div className="flex items-center gap-1">
        <span className="eyebrow mr-0.5">Window</span>
        {WINDOWS.map((window) => (
          <button
            key={window.hours}
            type="button"
            onClick={() => onChange({ ...value, hours: window.hours })}
            aria-pressed={value.hours === window.hours}
            className="btn tabular"
            data-active={value.hours === window.hours}
          >
            {window.label}
          </button>
        ))}
      </div>

      <Divider />

      <div className="flex items-center gap-1">
        <span className="eyebrow mr-0.5">Impact confidence</span>
        {CONFIDENCE.map((step) => (
          <button
            key={step.value}
            type="button"
            onClick={() => onChange({ ...value, minConfidence: step.value })}
            aria-pressed={value.minConfidence === step.value}
            className="btn tabular"
            data-active={value.minConfidence === step.value}
          >
            {step.label}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center">
        <label className="relative flex items-center">
          <span className="sr-only">Search market events</span>
          <svg
            className="pointer-events-none absolute left-2 h-3.5 w-3.5"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ink-muted)"
            strokeWidth={1.6}
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={value.search}
            onChange={(event) => onChange({ ...value, search: event.target.value })}
            placeholder="Search market events…"
            className="w-52 rounded-md border border-hairline bg-surface-2 py-[5px] pl-7 pr-2 text-[11.5px] text-ink placeholder:text-ink-muted focus:border-[var(--line-focus)] focus:outline-none"
          />
        </label>
      </div>
    </div>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-[var(--line-hairline)]" aria-hidden />;
}
