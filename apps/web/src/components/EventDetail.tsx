'use client';

import { useEffect, useState } from 'react';
import type { EventDetailDto, EventDto } from '@/lib/api-types';
import type { EventMarketImpact } from '@/lib/market';
import { directionLabel } from './market/MarketImpactFeed';
import {
  colorForCategory,
  formatCoordinates,
  labelForCategory,
  PRECISION_LABELS,
  severityBand,
  SEVERITY_LABELS,
  SEVERITY_VAR,
  sourceShortName,
  STATUS_LABELS,
  timeAgo,
} from '@/lib/presentation';

/**
 * Event detail: the provenance view.
 *
 * This panel is where the platform earns trust. Every pin on the globe is a
 * derived, clustered, machine-scored object, and an analyst cannot act on that
 * without seeing what produced it. So the panel leads with the evidence — every
 * contributing observation, its source, its similarity to the cluster, and a link
 * to the original — followed by the extracted entities and semantically related
 * events.
 *
 * Nothing here is a summary the operator has to take on faith.
 */

interface EventDetailProps {
  event: EventDto;
  marketImpact?: EventMarketImpact | null;
  marketExpanded?: boolean;
  onClose: () => void;
  onSelectRelated: (eventId: string) => void;
}

export function EventDetail({
  event,
  marketImpact,
  marketExpanded = false,
  onClose,
  onSelectRelated,
}: EventDetailProps) {
  const [detail, setDetail] = useState<EventDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marketOpen, setMarketOpen] = useState(marketExpanded);

  useEffect(() => setMarketOpen(marketExpanded), [event.id, marketExpanded]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(`/api/events/${event.id}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setDetail((await response.json()) as EventDetailDto);
      } catch (fetchError) {
        if (controller.signal.aborted) return;
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load');
      }
    })();

    return () => controller.abort();
  }, [event.id]);

  // Escape closes the panel — expected of anything modal-shaped.
  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const band = severityBand(event.severity);
  const categoryColor = colorForCategory(event.category);

  return (
    <aside
      className="flex h-full w-full flex-col bg-surface-1"
      aria-label={`Details for ${event.title}`}
    >
      {/* --- Header --- */}
      <div className="flex items-start gap-2 border-b border-hairline px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: categoryColor }}
              aria-hidden
            />
            <span
              className="text-[10.5px] font-semibold uppercase tracking-wide"
              style={{ color: categoryColor }}
            >
              {labelForCategory(event.category)}
            </span>
            <span className="eyebrow">{STATUS_LABELS[event.status] ?? event.status}</span>
          </div>
          <h2 className="mt-1.5 text-[15px] font-semibold leading-snug text-ink">{event.title}</h2>
        </div>

        <button type="button" onClick={onClose} className="btn shrink-0" aria-label="Close details">
          <svg
            viewBox="0 0 14 14"
            className="h-3 w-3"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden
          >
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* --- Scores --- */}
        <section className="grid grid-cols-3 divide-x divide-[var(--line-hairline)] border-b border-hairline">
          <Metric
            label="Severity"
            value={String(event.severity)}
            sub={SEVERITY_LABELS[band]}
            color={SEVERITY_VAR[band]}
            hint="How much this matters: source magnitude, corroboration and category weight"
          />
          <Metric
            label="Confidence"
            value={String(event.confidence)}
            sub={event.confidence >= 70 ? 'High' : event.confidence >= 45 ? 'Moderate' : 'Low'}
            hint="How much to trust that this is real and correctly located — independent of severity"
          />
          <Metric
            label="Corroboration"
            value={String(event.sourceCount)}
            sub={event.sourceCount === 1 ? 'single source' : 'independent sources'}
            color={event.sourceCount > 1 ? 'var(--group-human)' : undefined}
            hint="Distinct sources reporting this event"
          />
        </section>

        {/* --- Location and timing --- */}
        <section className="border-b border-hairline px-3.5 py-3">
          <dl className="flex flex-col gap-1.5 text-[11.5px]">
            <Row label="Location" value={event.placeName ?? 'Unlocated'} />
            {event.lat !== null && event.lon !== null && (
              <Row label="Coordinates" value={formatCoordinates(event.lat, event.lon)} mono />
            )}
            {/* Precision is stated explicitly: a country-centroid pin must not be
                mistaken for a surveyed position. */}
            <Row
              label="Geo precision"
              value={PRECISION_LABELS[event.geoPrecision] ?? event.geoPrecision}
            />
            <Row label="First seen" value={`${timeAgo(event.firstSeenAt)} ago`} />
            <Row label="Last update" value={`${timeAgo(event.lastSeenAt)} ago`} />
            {event.velocity > 0 && (
              <Row
                label="Velocity"
                value={`${event.velocity.toFixed(2)}× lifetime average`}
                color={event.velocity > 1.3 ? 'var(--sev-serious)' : undefined}
              />
            )}
          </dl>
        </section>

        {event.summary && (
          <section className="border-b border-hairline px-3.5 py-3">
            <h3 className="eyebrow">Summary</h3>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{event.summary}</p>
          </section>
        )}

        {marketImpact && (
          <details
            className="border-b border-hairline px-3.5 py-3"
            open={marketOpen}
            onToggle={(toggleEvent) => setMarketOpen(toggleEvent.currentTarget.open)}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span className="eyebrow">Potential market impact</span>
              <span className="text-[10.5px] text-ink-muted tabular">
                {marketImpact.materiality} materiality · {marketImpact.confidence} confidence
              </span>
            </summary>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-muted">
              Rule-based exposure analysis, not a trade recommendation. Event severity and market
              materiality are scored independently.
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {marketImpact.exposures.map((exposure) => (
                <li
                  key={exposure.id}
                  className="rounded-md border border-hairline bg-surface-2 px-2.5 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11.5px] font-medium text-ink">{exposure.label}</span>
                    <span className="chip">{directionLabel(exposure.direction)}</span>
                    <span className="ml-auto text-[10px] text-ink-muted tabular">
                      {exposure.materiality} · {exposure.confidence} conf
                    </span>
                  </div>
                  <p className="mt-1 text-[10.5px] leading-relaxed text-ink-secondary">
                    {exposure.rationale}
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink-muted">
                    {exposure.channel} channel · {exposure.horizon}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* --- Evidence --- */}
        <section className="border-b border-hairline px-3.5 py-3">
          <div className="flex items-center justify-between">
            <h3 className="eyebrow">Evidence</h3>
            <span className="eyebrow tabular">
              {(() => {
                const count = detail ? detail.observations.length : event.observationCount;
                return `${count} ${count === 1 ? 'observation' : 'observations'}`;
              })()}
            </span>
          </div>

          {error && (
            <p className="mt-2 text-[11.5px]" style={{ color: 'var(--sev-critical)' }}>
              Could not load evidence: {error}
            </p>
          )}

          {!detail && !error && (
            <div className="mt-2 flex flex-col gap-1.5">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="skeleton h-11 rounded-md" />
              ))}
            </div>
          )}

          {detail && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {detail.observations.map((observation) => (
                <li
                  key={observation.id}
                  className="rounded-md border border-hairline bg-surface-2 px-2.5 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="eyebrow" style={{ color: 'var(--ink-secondary)' }}>
                      {sourceShortName(observation.sourceId)}
                    </span>
                    <span className="text-[10px] text-ink-muted tabular">
                      {timeAgo(observation.occurredAt)}
                    </span>
                    {/* Similarity makes the clustering decision auditable. */}
                    <span
                      className="ml-auto text-[10px] text-ink-muted tabular"
                      title="Cosine similarity to the event centroid when this observation was assigned"
                    >
                      sim {observation.similarity.toFixed(2)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] leading-snug text-ink">
                    {observation.url ? (
                      <a
                        href={observation.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {observation.title}
                      </a>
                    ) : (
                      observation.title
                    )}
                  </p>
                  {observation.magnitude !== null && (
                    <p className="mt-0.5 text-[10.5px] text-ink-muted tabular">
                      magnitude {observation.magnitude}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- Entities --- */}
        {detail && detail.entities.length > 0 && (
          <section className="border-b border-hairline px-3.5 py-3">
            <h3 className="eyebrow">Entities</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {detail.entities.map((entity) => (
                <span
                  key={entity.id}
                  className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-secondary"
                  title={`${entity.kind} · ${entity.mentions} mentions`}
                >
                  {entity.name}
                  <span className="ml-1 text-ink-muted tabular">{entity.mentions}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {/* --- Related --- */}
        {detail && detail.related.length > 0 && (
          <section className="px-3.5 py-3">
            <h3 className="eyebrow">Semantically related</h3>
            <p className="mt-1 text-[10.5px] text-ink-muted">
              Nearest events by embedding similarity — possible connections, not confirmed links.
            </p>
            <ul className="mt-2 flex flex-col gap-px">
              {detail.related.map((related) => (
                <li key={related.id}>
                  <button
                    type="button"
                    onClick={() => onSelectRelated(related.id)}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-surface-2"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: colorForCategory(related.category) }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-secondary">
                      {related.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-ink-muted tabular">
                      {related.similarity.toFixed(2)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

function Metric({
  label,
  value,
  sub,
  color,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  hint?: string;
}) {
  return (
    <div className="px-3 py-2.5" title={hint}>
      <div className="eyebrow">{label}</div>
      <div
        className="mt-0.5 text-[18px] font-semibold leading-none tabular"
        style={{ color: color ?? 'var(--ink-primary)' }}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[10px] text-ink-muted">{sub}</div>}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  color,
}: {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-24 shrink-0 text-ink-muted">{label}</dt>
      <dd
        className={mono ? 'mono text-[11px]' : ''}
        style={{ color: color ?? 'var(--ink-secondary)' }}
      >
        {value}
      </dd>
    </div>
  );
}
