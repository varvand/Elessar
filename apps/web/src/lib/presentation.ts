/**
 * Imported from the `taxonomy` subpath, not the package root.
 *
 * `@elessar/core`'s barrel re-exports the env loader and text utilities, which
 * import `node:fs` and `node:crypto`. This module is used by client components,
 * and pulling the barrel in drags those Node built-ins into the browser bundle —
 * which fails the build outright. The subpath exposes only the pure taxonomy
 * module, keeping the client/server boundary enforced by module structure rather
 * than by convention.
 */
import { CATEGORY_LABELS, type EventCategory } from '@elessar/core/taxonomy';

/**
 * The single place where domain values become colours, labels and shapes.
 *
 * Centralized so the validated palette can never drift: a component that wants
 * a colour asks here rather than writing a hex, which means re-validating the
 * palette is a one-file change and no stray `#d95926` can creep into a chart.
 */

/**
 * Category groups are the unit of colour, not categories.
 *
 * There are 18 categories and no palette can give 18 distinguishable hues — past
 * about 8 the eye cannot separate them and colourblind separation collapses
 * entirely. So the 18 categories fold into 5 groups for colour, and category
 * identity is carried by the text label everywhere it appears. Colour tells you
 * *what kind* of thing at a glance; the label tells you exactly what.
 */
export const CATEGORY_GROUP_IDS = ['governance', 'security', 'human', 'domain', 'hazard'] as const;

export type CategoryGroupId = (typeof CATEGORY_GROUP_IDS)[number];

/**
 * Render order for stacked charts.
 *
 * This sequence IS the colourblind-safety mechanism — the validator checks
 * adjacent pairs, and this order is one of the few that clears every gate in
 * both light and dark mode. Reordering it silently invalidates that result.
 */
export const STACK_ORDER: CategoryGroupId[] = [
  'governance',
  'security',
  'human',
  'domain',
  'hazard',
];

export const CATEGORY_GROUP_LABELS: Record<CategoryGroupId, string> = {
  governance: 'Governance',
  security: 'Security',
  human: 'Human',
  domain: 'Domain',
  hazard: 'Hazard',
};

/** CSS variable per group, so components never hold a hex value. */
export const CATEGORY_GROUP_VAR: Record<CategoryGroupId, string> = {
  governance: 'var(--group-governance)',
  security: 'var(--group-security)',
  human: 'var(--group-human)',
  domain: 'var(--group-domain)',
  hazard: 'var(--group-hazard)',
};

const CATEGORY_TO_GROUP: Record<EventCategory, CategoryGroupId> = {
  armed_conflict: 'security',
  terrorism: 'security',
  civil_unrest: 'security',
  cyber: 'security',

  political: 'governance',
  diplomacy: 'governance',
  economy: 'governance',

  humanitarian: 'human',
  health: 'human',

  seismic: 'hazard',
  severe_weather: 'hazard',
  wildfire: 'hazard',
  natural_disaster: 'hazard',

  infrastructure: 'domain',
  maritime: 'domain',
  aviation: 'domain',
  space: 'domain',
  other: 'domain',
};

export function groupForCategory(category: string): CategoryGroupId {
  return CATEGORY_TO_GROUP[category as EventCategory] ?? 'domain';
}

export function categoriesInGroup(group: CategoryGroupId): EventCategory[] {
  return (Object.keys(CATEGORY_TO_GROUP) as EventCategory[]).filter(
    (category) => CATEGORY_TO_GROUP[category] === group,
  );
}

export function colorForCategory(category: string): string {
  return CATEGORY_GROUP_VAR[groupForCategory(category)];
}

export function labelForCategory(category: string): string {
  return CATEGORY_LABELS[category as EventCategory] ?? category;
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export type SeverityBand = 'critical' | 'serious' | 'elevated' | 'routine';

/**
 * Severity bands.
 *
 * Thresholds are deliberately coarse. Severity is an estimate assembled from
 * heterogeneous sources, and presenting it as a precise number invites false
 * confidence — four named bands communicate the actual resolution of the signal.
 * The numeric score stays available for sorting and in the detail view.
 */
export function severityBand(severity: number): SeverityBand {
  if (severity >= 70) return 'critical';
  if (severity >= 50) return 'serious';
  if (severity >= 30) return 'elevated';
  return 'routine';
}

export const SEVERITY_LABELS: Record<SeverityBand, string> = {
  critical: 'Critical',
  serious: 'Serious',
  elevated: 'Elevated',
  routine: 'Routine',
};

export const SEVERITY_VAR: Record<SeverityBand, string> = {
  critical: 'var(--sev-critical)',
  serious: 'var(--sev-serious)',
  elevated: 'var(--sev-elevated)',
  routine: 'var(--sev-routine)',
};

export function colorForSeverity(severity: number): string {
  return SEVERITY_VAR[severityBand(severity)];
}

/**
 * Resolved hex values for severity bands.
 *
 * The globe renders through WebGL, which cannot read CSS custom properties —
 * three.js needs a concrete colour. These must stay in step with `globals.css`;
 * they are the one sanctioned duplication of the palette, and the reason it is
 * confined to a single exported constant.
 */
export const SEVERITY_HEX_DARK: Record<SeverityBand, string> = {
  critical: '#d03b3b',
  serious: '#ec835a',
  elevated: '#fab219',
  routine: '#5b7089',
};

export const SEVERITY_HEX_LIGHT: Record<SeverityBand, string> = {
  critical: '#c62f2f',
  serious: '#d2683c',
  elevated: '#b07b00',
  routine: '#78889c',
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  developing: 'Developing',
  dormant: 'Dormant',
  closed: 'Closed',
};

/** Geographic precision, phrased for an analyst deciding how much to trust a pin. */
export const PRECISION_LABELS: Record<string, string> = {
  exact: 'Exact coordinates',
  city: 'City-level',
  admin1: 'Region-level',
  country: 'Country-level',
  unknown: 'Unlocated',
};

export const PRECISION_SHORT: Record<string, string> = {
  exact: 'exact',
  city: 'city',
  admin1: 'region',
  country: 'country',
  unknown: 'unknown',
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/** Compact relative time for a dense feed. */
export function timeAgo(input: string | Date, now: Date = new Date()): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  const deltaMs = now.getTime() - date.getTime();
  if (!Number.isFinite(deltaMs)) return '—';
  if (deltaMs < 60_000) return 'now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export function formatCoordinates(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(3)}°${ns} ${Math.abs(lon).toFixed(3)}°${ew}`;
}

/** Short source label, e.g. "gdelt.events" → "GDELT". */
export function sourceShortName(sourceId: string): string {
  const [prefix, rest] = sourceId.split('.');
  switch (prefix) {
    case 'gdelt':
      return 'GDELT';
    case 'usgs':
      return 'USGS';
    case 'gdacs':
      return 'GDACS';
    case 'nws':
      return 'NWS';
    case 'nasa':
      return 'NASA';
    case 'firms':
      return 'FIRMS';
    case 'noaa':
      return 'NOAA SWPC';
    case 'ocha':
      return 'ReliefWeb';
    case 'us':
      return rest === 'ofac' ? 'OFAC' : sourceId;
    case 'rss':
      return (rest ?? '')
        .split('-')
        .map((part) =>
          part.length <= 3 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1),
        )
        .join(' ');
    default:
      return sourceId;
  }
}
