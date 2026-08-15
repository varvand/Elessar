'use client';

import {
  CATEGORY_GROUP_LABELS,
  CATEGORY_GROUP_VAR,
  STACK_ORDER,
  type CategoryGroupId,
} from '@/lib/presentation';

/**
 * Filters, in one row above the views they control.
 *
 * Placement matters: filters that sit beside or below a chart read as part of the
 * data. A single row on top establishes that everything beneath it is scoped by
 * these controls.
 */

export interface FilterState {
  groups: CategoryGroupId[];
  minSeverity: number;
  hours: number;
  search: string;
  orderBy: 'hotness' | 'severity' | 'recent';
}

interface FilterBarProps {
  value: FilterState;
  onChange: (next: FilterState) => void;
  /** Per-group event counts, so the operator sees what a filter would cost. */
  counts: Record<string, number>;
}

const TIME_WINDOWS: { hours: number; label: string }[] = [
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 72, label: '3d' },
  { hours: 168, label: '7d' },
];

const SEVERITY_STEPS: { value: number; label: string }[] = [
  { value: 0, label: 'All' },
  { value: 30, label: '30+' },
  { value: 50, label: '50+' },
  { value: 70, label: '70+' },
];

const ORDER_OPTIONS: { value: FilterState['orderBy']; label: string; hint: string }[] = [
  { value: 'hotness', label: 'Priority', hint: 'Severity with per-category time decay' },
  { value: 'severity', label: 'Severity', hint: 'Highest severity first' },
  { value: 'recent', label: 'Latest', hint: 'Most recently updated first' },
];

export function FilterBar({ value, onChange, counts }: FilterBarProps) {
  const selectGroup = (group: CategoryGroupId) => {
    const isOnlySelected = value.groups.length === 1 && value.groups[0] === group;
    onChange({ ...value, groups: isOnlySelected ? [...STACK_ORDER] : [group] });
  };

  const allSelected = value.groups.length === STACK_ORDER.length;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
      {/* --- Category groups --- */}
      <div className="flex items-center gap-1.5">
        <span className="eyebrow mr-0.5">Domain</span>
        {STACK_ORDER.map((group) => {
          const active = value.groups.includes(group);
          const isOnlySelected = active && value.groups.length === 1;
          return (
            <button
              key={group}
              type="button"
              onClick={() => selectGroup(group)}
              aria-pressed={active}
              title={
                isOnlySelected
                  ? 'Show all domains'
                  : `Show only ${CATEGORY_GROUP_LABELS[group]} — ${counts[group] ?? 0} events`
              }
              className="btn"
              data-active={active && !allSelected}
              style={{ opacity: active ? 1 : 0.45 }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: CATEGORY_GROUP_VAR[group] }}
                aria-hidden
              />
              {CATEGORY_GROUP_LABELS[group]}
              <span className="text-ink-muted tabular">{counts[group] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <Divider />

      {/* --- Time window --- */}
      <div className="flex items-center gap-1">
        <span className="eyebrow mr-0.5">Window</span>
        {TIME_WINDOWS.map((window) => (
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

      {/* --- Severity floor --- */}
      <div className="flex items-center gap-1">
        <span className="eyebrow mr-0.5">Severity</span>
        {SEVERITY_STEPS.map((step) => (
          <button
            key={step.value}
            type="button"
            onClick={() => onChange({ ...value, minSeverity: step.value })}
            aria-pressed={value.minSeverity === step.value}
            className="btn tabular"
            data-active={value.minSeverity === step.value}
          >
            {step.label}
          </button>
        ))}
      </div>

      <Divider />

      {/* --- Sort --- */}
      <div className="flex items-center gap-1">
        <span className="eyebrow mr-0.5">Rank</span>
        {ORDER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange({ ...value, orderBy: option.value })}
            aria-pressed={value.orderBy === option.value}
            title={option.hint}
            className="btn"
            data-active={value.orderBy === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* --- Search --- */}
      <div className="ml-auto flex items-center">
        <label className="relative flex items-center">
          <span className="sr-only">Search events</span>
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
            placeholder="Search titles, places…"
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
