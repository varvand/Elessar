'use client';

import { useMemo } from 'react';
import type { EventDto } from '@/lib/api-types';
import {
  colorForCategory,
  labelForCategory,
  severityBand,
  SEVERITY_LABELS,
  SEVERITY_VAR,
  timeAgo,
  PRECISION_SHORT,
} from '@/lib/presentation';

/**
 * The live event feed.
 *
 * This doubles as the accessible table view for the globe: every pin appears here
 * as a labelled row, so nothing on this dashboard is conveyed by colour or
 * position alone. That is why it lists *all* filtered events, not just located
 * ones — an unlocated event is invisible on the globe and must remain reachable.
 */

interface EventFeedProps {
  events: EventDto[];
  selectedId: string | null;
  onSelect: (event: EventDto) => void;
  loading: boolean;
}

export function EventFeed({ events, selectedId, onSelect, loading }: EventFeedProps) {
  if (loading && events.length === 0) {
    return (
      <div className="flex flex-col gap-px p-2">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="skeleton h-[62px] rounded-md" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-[12.5px] text-ink-secondary">No events match these filters</p>
        <p className="text-[11px] text-ink-muted">
          Widen the time window or lower the minimum severity.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-[var(--line-hairline)]">
      {events.map((event) => (
        <EventRow
          key={event.id}
          event={event}
          selected={event.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function EventRow({
  event,
  selected,
  onSelect,
}: {
  event: EventDto;
  selected: boolean;
  onSelect: (event: EventDto) => void;
}) {
  const band = severityBand(event.severity);
  const categoryColor = colorForCategory(event.category);

  // Escalating is worth a badge: an event whose reporting is accelerating is more
  // actionable than one that is merely large.
  const escalating = event.velocity > 1.3 && event.status === 'developing';

  const entities = useMemo(() => (event.entities ?? []).slice(0, 3), [event.entities]);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(event)}
        aria-current={selected ? 'true' : undefined}
        className="group relative flex w-full gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
        style={selected ? { background: 'var(--surface-3)' } : undefined}
      >
        {/* Severity rail: a 3px vertical bar. Redundant with the text label
            below, which is what makes the colour safe to rely on visually. */}
        <span
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: SEVERITY_VAR[band] }}
          aria-hidden
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: categoryColor }}
              aria-hidden
            />
            <span className="truncate text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: categoryColor }}>
              {labelForCategory(event.category)}
            </span>

            {escalating && (
              <span
                className="chip"
                style={{
                  color: 'var(--sev-serious)',
                  borderColor: 'color-mix(in oklab, var(--sev-serious) 40%, transparent)',
                  background: 'color-mix(in oklab, var(--sev-serious) 12%, transparent)',
                }}
              >
                ↑ Escalating
              </span>
            )}

            {/* Relative time is computed from the clock, so the server's value
                and the client's first render legitimately differ. Suppressing the
                warning here is correct — without it React treats the whole tree
                as mismatched and abandons hydration, which silently breaks every
                interactive component on the page (the globe included). */}
            <span
              className="ml-auto shrink-0 text-[10.5px] text-ink-muted tabular"
              suppressHydrationWarning
            >
              {timeAgo(event.lastSeenAt)}
            </span>
          </div>

          <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.35] text-ink">
            {event.title}
          </p>

          <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-muted">
            {/* Severity as label + number, never colour alone. */}
            <span className="tabular" style={{ color: SEVERITY_VAR[band] }}>
              {SEVERITY_LABELS[band]} {event.severity}
            </span>

            <span aria-hidden>·</span>

            {/* Corroboration: the number an analyst uses to decide how much to
                believe. Multi-source events are the valuable ones. */}
            <span
              className="tabular"
              title={`${event.observationCount} observations from ${event.sourceCount} independent sources`}
            >
              {event.sourceCount > 1 ? (
                <span style={{ color: 'var(--ink-secondary)' }}>
                  {event.sourceCount} sources
                </span>
              ) : (
                '1 source'
              )}
              {event.observationCount > 1 && ` · ${event.observationCount} reports`}
            </span>

            {event.placeName && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate" title={`${event.placeName} (${PRECISION_SHORT[event.geoPrecision] ?? 'unknown'} precision)`}>
                  {event.placeName}
                </span>
              </>
            )}
          </div>

          {entities.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {entities.map((entity) => (
                <span
                  key={entity.name}
                  className="rounded border border-hairline bg-surface-2 px-1.5 py-px text-[10px] text-ink-secondary"
                >
                  {entity.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>
    </li>
  );
}
