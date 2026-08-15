'use client';

import type { StatsDto } from '@/lib/api-types';
import { formatCount } from '@/lib/presentation';

/**
 * The stat strip.
 *
 * These are stat tiles, not charts, because each answers a single "how many right
 * now" question — the form heuristic says a lone magnitude is a number, and
 * wrapping a single figure in axes adds ink without adding information.
 *
 * `tabular-nums` throughout: these numbers refresh in place every few seconds,
 * and proportional figures make the whole strip jitter as digits change width.
 */

interface StatStripProps {
  stats: StatsDto | null;
  loading: boolean;
}

export function StatStrip({ stats, loading }: StatStripProps) {
  const tiles: {
    label: string;
    value: string;
    tone?: 'critical' | 'serious' | 'neutral';
    hint: string;
  }[] = stats
    ? [
        {
          label: 'Active events',
          value: formatCount(stats.activeEvents),
          hint: 'Events with new observations in the last 24 hours',
        },
        {
          label: 'Critical',
          value: formatCount(stats.criticalEvents),
          tone: stats.criticalEvents > 0 ? 'critical' : 'neutral',
          hint: 'Severity 70 or above in the last 24 hours',
        },
        {
          label: 'Observations 24h',
          value: formatCount(stats.observations24h),
          hint: 'Raw reports ingested from all sources',
        },
        {
          label: 'Countries',
          value: formatCount(stats.countriesAffected),
          hint: 'Distinct countries with active events',
        },
        {
          label: 'Open alerts',
          value: formatCount(stats.openAlerts),
          tone: stats.openAlerts > 0 ? 'serious' : 'neutral',
          hint: 'Unacknowledged statistical anomalies',
        },
        {
          label: 'Sources',
          value: `${stats.healthySources}/${stats.totalSources}`,
          tone: stats.healthySources < stats.totalSources ? 'serious' : 'neutral',
          hint: 'Connectors whose last run succeeded',
        },
      ]
    : [];

  if (loading && !stats) {
    return (
      <div className="flex items-stretch gap-px">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="skeleton h-[44px] w-[104px] rounded-md" />
        ))}
      </div>
    );
  }

  return (
    <dl className="flex items-stretch divide-x divide-[var(--line-hairline)]">
      {tiles.map((tile) => (
        <div key={tile.label} className="px-3.5 first:pl-0 last:pr-0" title={tile.hint}>
          <dt className="eyebrow whitespace-nowrap">{tile.label}</dt>
          <dd
            className="mt-0.5 text-[17px] font-semibold leading-none tabular"
            style={{
              color:
                tile.tone === 'critical'
                  ? 'var(--sev-critical)'
                  : tile.tone === 'serious'
                    ? 'var(--sev-serious)'
                    : 'var(--ink-primary)',
            }}
          >
            {tile.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
