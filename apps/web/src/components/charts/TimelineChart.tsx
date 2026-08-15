'use client';

import { useMemo, useRef, useState } from 'react';
import type { TimelinePointDto } from '@/lib/api-types';
import {
  CATEGORY_GROUP_LABELS,
  CATEGORY_GROUP_VAR,
  STACK_ORDER,
  type CategoryGroupId,
} from '@/lib/presentation';

/**
 * Observation volume over time, stacked by category group.
 *
 * Hand-rolled SVG rather than a charting library, for control the libraries do
 * not give: a 2px surface-coloured gap between stacked bands, a crosshair that
 * snaps to buckets, and a legend that is always present. Those are the specs
 * that make a stacked chart readable, and they are exactly what gets lost behind
 * a generic `<AreaChart>`.
 *
 * Bars, not a smoothed area: the underlying data is a discrete count per time
 * bucket. A spline through bucket counts implies instantaneous rates that were
 * never measured, and invents a continuous curve out of what is genuinely a
 * histogram.
 */

interface TimelineChartProps {
  points: TimelinePointDto[];
  activeGroups: CategoryGroupId[];
  hours: number;
  height?: number;
}

const PADDING = { top: 10, right: 8, bottom: 20, left: 34 };

export function TimelineChart({
  points,
  activeGroups,
  hours,
  height = 132,
}: TimelineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Measure once per layout via a callback ref — a ResizeObserver here would
  // fight the parent grid during the initial layout pass.
  const measure = (element: HTMLDivElement | null) => {
    containerRef.current = element;
    if (element && element.clientWidth > 0 && element.clientWidth !== width) {
      setWidth(element.clientWidth);
    }
  };

  const groups = useMemo(
    () => STACK_ORDER.filter((group) => activeGroups.includes(group)),
    [activeGroups],
  );

  const plotWidth = Math.max(80, width - PADDING.left - PADDING.right);
  const plotHeight = Math.max(40, height - PADDING.top - PADDING.bottom);

  const maxTotal = useMemo(() => {
    const max = points.reduce((peak, point) => {
      const total = groups.reduce((sum, group) => sum + (point.groups[group] ?? 0), 0);
      return Math.max(peak, total);
    }, 0);
    // A flat zero axis would divide by zero; 1 keeps the scale valid and the
    // chart legibly empty.
    return Math.max(1, max);
  }, [points, groups]);

  const barWidth = points.length > 0 ? plotWidth / points.length : plotWidth;
  // Below ~3px a gap consumes the bar itself, so it is dropped rather than
  // shrinking the mark into invisibility.
  const gap = barWidth > 4 ? 1 : 0;
  const innerWidth = Math.max(0.75, barWidth - gap * 2);

  const yScale = (value: number) => plotHeight - (value / maxTotal) * plotHeight;

  const yTicks = useMemo(() => niceTicks(maxTotal, 3), [maxTotal]);
  const xTicks = useMemo(() => timeTicks(points, hours), [points, hours]);

  const hovered = hoverIndex !== null ? points[hoverIndex] : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* Legend is always present: with 2+ series, identity must never rest on
          colour alone. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-1.5">
        {groups.map((group) => (
          <span key={group} className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-3 rounded-sm"
              style={{ background: CATEGORY_GROUP_VAR[group] }}
              aria-hidden
            />
            <span className="text-[10.5px] text-ink-secondary">
              {CATEGORY_GROUP_LABELS[group]}
            </span>
          </span>
        ))}
        <span className="ml-auto eyebrow tabular">
          peak {maxTotal}/bucket
        </span>
      </div>

      <div ref={measure} className="relative min-h-0 flex-1">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Observation volume over the last ${hours} hours, stacked by category group`}
          onMouseLeave={() => setHoverIndex(null)}
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - bounds.left - PADDING.left;
            const index = Math.floor(x / barWidth);
            setHoverIndex(index >= 0 && index < points.length ? index : null);
          }}
        >
          <g transform={`translate(${PADDING.left},${PADDING.top})`}>
            {/* Recessive gridlines, drawn behind the marks. */}
            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  x1={0}
                  x2={plotWidth}
                  y1={yScale(tick)}
                  y2={yScale(tick)}
                  stroke="var(--grid-line)"
                  strokeWidth={1}
                />
                <text
                  x={-6}
                  y={yScale(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="tabular"
                  fill="var(--ink-muted)"
                  fontSize={9.5}
                >
                  {tick >= 1000 ? `${Math.round(tick / 1000)}k` : tick}
                </text>
              </g>
            ))}

            {/* Hover band, beneath the bars so it never obscures data. */}
            {hoverIndex !== null && (
              <rect
                x={hoverIndex * barWidth}
                y={0}
                width={barWidth}
                height={plotHeight}
                fill="var(--surface-3)"
                opacity={0.7}
              />
            )}

            {/* Stacked bars, drawn bottom-up in the validated group order. */}
            {points.map((point, index) => {
              let cursor = 0;
              const x = index * barWidth + gap;

              return (
                <g key={point.bucket}>
                  {groups.map((group) => {
                    const value = point.groups[group] ?? 0;
                    if (value <= 0) return null;

                    const segmentTop = yScale(cursor + value);
                    const segmentBottom = yScale(cursor);
                    cursor += value;

                    // 2px surface gap between segments, so adjacent bands read as
                    // separate quantities rather than one blended mass.
                    const rawHeight = segmentBottom - segmentTop;
                    const drawHeight = Math.max(0.75, rawHeight - (rawHeight > 3 ? 2 : 0));

                    return (
                      <rect
                        key={group}
                        x={x}
                        y={segmentTop}
                        width={innerWidth}
                        height={drawHeight}
                        fill={CATEGORY_GROUP_VAR[group]}
                        rx={innerWidth > 3 ? 1 : 0}
                      />
                    );
                  })}
                </g>
              );
            })}

            {/* Baseline: the anchor the bars are measured from. */}
            <line
              x1={0}
              x2={plotWidth}
              y1={plotHeight}
              y2={plotHeight}
              stroke="var(--axis-line)"
              strokeWidth={1}
            />

            {xTicks.map(({ index, label }) => (
              <text
                key={`${index}-${label}`}
                x={index * barWidth + barWidth / 2}
                y={plotHeight + 13}
                textAnchor="middle"
                className="tabular"
                fill="var(--ink-muted)"
                fontSize={9.5}
              >
                {label}
              </text>
            ))}
          </g>
        </svg>

        {hovered && hoverIndex !== null && (
          <TimelineTooltip
            point={hovered}
            groups={groups}
            x={PADDING.left + hoverIndex * barWidth + barWidth / 2}
            containerWidth={width}
          />
        )}
      </div>
    </div>
  );
}

function TimelineTooltip({
  point,
  groups,
  x,
  containerWidth,
}: {
  point: TimelinePointDto;
  groups: CategoryGroupId[];
  x: number;
  containerWidth: number;
}) {
  const TOOLTIP_WIDTH = 168;
  // Clamp inside the container so a tooltip near either edge stays readable.
  const left = Math.min(Math.max(x - TOOLTIP_WIDTH / 2, 4), containerWidth - TOOLTIP_WIDTH - 4);

  const present = groups
    .map((group) => ({ group, value: point.groups[group] ?? 0 }))
    .filter((entry) => entry.value > 0)
    .reverse(); // Top of the stack first, matching what the eye sees.

  const time = new Date(point.bucket);

  return (
    <div
      className="pointer-events-none absolute top-0 z-20 rounded-md border border-hairline bg-surface-1 px-2.5 py-2 shadow-[var(--shadow-panel)]"
      style={{ left, width: TOOLTIP_WIDTH }}
    >
      <div className="eyebrow tabular">
        {time.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </div>
      {present.length === 0 ? (
        <div className="mt-1 text-[11px] text-ink-muted">No observations</div>
      ) : (
        <div className="mt-1.5 flex flex-col gap-1">
          {present.map(({ group, value }) => (
            <div key={group} className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-3 shrink-0 rounded-sm"
                style={{ background: CATEGORY_GROUP_VAR[group] }}
                aria-hidden
              />
              <span className="text-[10.5px] text-ink-secondary">
                {CATEGORY_GROUP_LABELS[group]}
              </span>
              <span className="ml-auto text-[10.5px] text-ink tabular">{value}</span>
            </div>
          ))}
          <div className="mt-0.5 flex items-center gap-1.5 border-t border-hairline pt-1">
            <span className="text-[10.5px] text-ink-muted">Total</span>
            <span className="ml-auto text-[10.5px] font-semibold text-ink tabular">
              {point.total}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Axis ticks at 1/2/5×10^n, so labels are numbers a human would choose.
 *
 * Steps are floored to at least 1 and the result de-duplicated: counts are
 * integers, so a fractional step over a small maximum (max=1 gives step 0.5)
 * rounds two ticks to the same label — which renders duplicate React keys and
 * two gridlines drawn on top of each other.
 */
function niceTicks(max: number, count: number): number[] {
  const rough = Math.max(max / count, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = Math.max(
    1,
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude,
  );

  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) {
    const rounded = Math.round(value);
    if (!ticks.includes(rounded)) ticks.push(rounded);
  }
  return ticks;
}

/** Roughly six evenly spaced time labels, formatted for the window's length. */
function timeTicks(
  points: TimelinePointDto[],
  hours: number,
): { index: number; label: string }[] {
  if (points.length === 0) return [];

  const target = 6;
  const stride = Math.max(1, Math.ceil(points.length / target));
  const showDate = hours > 48;

  const ticks: { index: number; label: string }[] = [];
  for (let index = 0; index < points.length; index += stride) {
    const point = points[index];
    if (!point) continue;
    const date = new Date(point.bucket);
    ticks.push({
      index,
      label: showDate
        ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    });
  }
  return ticks;
}
