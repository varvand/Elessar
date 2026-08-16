import type { EventMarketImpact, MarketChannel } from '@/lib/market';

const CHANNELS: { id: MarketChannel; label: string }[] = [
  { id: 'supply', label: 'Supply' },
  { id: 'policy', label: 'Policy' },
  { id: 'security', label: 'Security' },
  { id: 'operations', label: 'Operations' },
  { id: 'macro', label: 'Macro' },
];

export function MarketImpactSummary({ impacts }: { impacts: EventMarketImpact[] }) {
  const totals = CHANNELS.map((channel) => ({
    ...channel,
    count: impacts.filter((impact) =>
      impact.exposures.some((exposure) => exposure.channel === channel.id),
    ).length,
  }));
  const max = Math.max(1, ...totals.map((channel) => channel.count));

  return (
    <div className="grid grid-cols-5 gap-2 px-2 pb-2 pt-1.5">
      {totals.map((channel) => (
        <div
          key={channel.id}
          className="rounded-md border border-hairline bg-surface-2 px-2 py-1.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">{channel.label}</span>
            <span className="text-[11px] text-ink-secondary tabular">{channel.count}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-[var(--group-governance)]"
              style={{ width: `${(channel.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
