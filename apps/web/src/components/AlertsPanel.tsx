'use client';

import type { AlertDto } from '@/lib/api-types';
import { labelForCategory, colorForCategory, timeAgo } from '@/lib/presentation';

/**
 * Anomaly alerts.
 *
 * Distinct from events by design. An event is "something happened"; an alert is
 * "the *rate* of things happening here is abnormal for this place and category".
 * The second is what catches a situation developing before any single report looks
 * severe, and it is the reason baselines are maintained per (category, grid cell).
 *
 * Each alert shows observed vs expected and the z-score, because an alert an
 * analyst cannot sanity-check is an alert they will learn to ignore.
 */

interface AlertsPanelProps {
  alerts: AlertDto[];
  loading: boolean;
}

export function AlertsPanel({ alerts, loading }: AlertsPanelProps) {
  if (loading && alerts.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 p-2.5">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="skeleton h-12 rounded-md" />
        ))}
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-start gap-1 px-3.5 py-3">
        <p className="text-[11.5px] text-ink-secondary">No anomalies detected</p>
        <p className="text-[10.5px] leading-snug text-ink-muted">
          Volume is within the normal range for every region and category with an
          established baseline. Baselines need ~12 hourly buckets before they can
          fire.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-[var(--line-hairline)]">
      {alerts.map((alert) => (
        <li key={alert.id} className="px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="pulse-dot" aria-hidden />
            {alert.category && (
              <span
                className="text-[10.5px] font-semibold uppercase tracking-wide"
                style={{ color: colorForCategory(alert.category) }}
              >
                {labelForCategory(alert.category)}
              </span>
            )}
            {/* Clock-derived: see the note in EventFeed. */}
            <span
              className="ml-auto text-[10px] text-ink-muted tabular"
              suppressHydrationWarning
            >
              {timeAgo(alert.createdAt)}
            </span>
          </div>

          <p className="mt-1 text-[12px] leading-snug text-ink">{alert.title}</p>

          {alert.observed !== null && alert.expected !== null && (
            <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-ink-muted tabular">
              <span>
                observed <span className="text-ink-secondary">{alert.observed}</span>
              </span>
              <span>
                expected{' '}
                <span className="text-ink-secondary">{alert.expected.toFixed(1)}</span>
              </span>
              {alert.zScore !== null && (
                <span style={{ color: 'var(--sev-serious)' }}>
                  {alert.zScore.toFixed(1)}σ
                </span>
              )}
            </div>
          )}

          {alert.placeName && (
            <p className="mt-1 truncate text-[10.5px] text-ink-muted">{alert.placeName}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
