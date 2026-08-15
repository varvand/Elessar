'use client';

import { useEffect, useState } from 'react';
import type { SourceHealthDto } from '@/lib/api-types';
import { formatCount, sourceShortName, timeAgo } from '@/lib/presentation';

/**
 * Source health and attribution.
 *
 * Two jobs in one panel, both non-negotiable for a tool like this:
 *
 * 1. **Operational honesty.** If GDELT has been failing for an hour, the globe is
 *    quietly missing most of the world's events. An operator who cannot see that
 *    will read an empty globe as a calm world. Silence must be visible.
 *
 * 2. **Attribution.** Every source here is free and mostly publicly funded or
 *    volunteer-run. Their licences require credit, and crediting them is the
 *    right thing to do regardless.
 */

export function SourcesPanel() {
  const [sources, setSources] = useState<SourceHealthDto[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetch('/api/sources', { signal: controller.signal });
        if (!response.ok) return;
        const payload = (await response.json()) as { sources: SourceHealthDto[] };
        setSources(payload.sources);
      } catch {
        // Transient failures are expected; the next tick retries.
      }
    };

    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  if (!sources) {
    return (
      <div className="flex flex-col gap-1.5 p-2.5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="skeleton h-8 rounded-md" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col divide-y divide-[var(--line-hairline)]">
        {sources.map((source) => {
          const failing = source.consecutiveFailures > 0;
          const stale =
            source.lastSuccessAt !== null &&
            Date.now() - new Date(source.lastSuccessAt).getTime() > 2 * 60 * 60 * 1000;
          const never = source.lastSuccessAt === null;

          const tone = failing || never ? 'var(--sev-critical)' : stale ? 'var(--sev-elevated)' : 'var(--group-human)';
          const statusText = failing
            ? `failing (${source.consecutiveFailures}×)`
            : never
              ? 'no successful run'
              : stale
                ? 'stale'
                : 'healthy';

          return (
            <li key={source.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: tone }}
                  aria-hidden
                />
                <a
                  href={source.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-[11.5px] text-ink-secondary hover:text-ink hover:underline"
                  title={`${source.name} — ${source.license}`}
                >
                  {sourceShortName(source.id)}
                </a>
                {/* Status as text, not colour alone. */}
                <span className="text-[10px]" style={{ color: tone }}>
                  {statusText}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-ink-muted tabular">
                  {formatCount(source.observationsIngested)}
                </span>
              </div>

              <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[10px] text-ink-muted tabular">
                {source.lastSuccessAt ? (
                  <span>ok {timeAgo(source.lastSuccessAt)} ago</span>
                ) : (
                  <span>never succeeded</span>
                )}
                {source.lastRunObservations !== null && (
                  <span>+{source.lastRunObservations} last run</span>
                )}
                {source.lastRunDurationMs !== null && (
                  <span>{source.lastRunDurationMs}ms</span>
                )}
              </div>

              {failing && source.lastError && (
                <p
                  className="mt-1 line-clamp-2 pl-3.5 text-[10px] leading-snug"
                  style={{ color: 'var(--sev-critical)' }}
                  title={source.lastError}
                >
                  {source.lastError}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <p className="border-t border-hairline px-3 py-2 text-[10px] leading-relaxed text-ink-muted">
        Data from GDELT, USGS, GDACS (EC JRC / UN OCHA), NASA EONET, NOAA/NWS and
        the listed news publishers. Place names from GeoNames (CC BY 4.0). All
        sources are free and used under their published terms.
      </p>
    </div>
  );
}
