import type { EventCategory } from './taxonomy';
import type { GeoPrecision, ParsedObservationDraft } from './types';

/**
 * Scoring.
 *
 * The hard problem here is commensurability: a magnitude-6.2 earthquake and a
 * CAMEO "use unconventional mass violence" event arrive on completely unrelated
 * scales, yet both must render as a pin whose size an analyst can compare at a
 * glance.
 *
 * The approach: each source maps its native magnitude into a normalized 0..1
 * `intensity` via an explicit, documented curve (below). Only then is intensity
 * combined with corroboration and category weight. All the per-source judgement
 * lives in one file, so recalibrating is a local change rather than a hunt
 * through connectors.
 */

/**
 * Baseline importance per category, 0..1. This encodes an editorial stance —
 * mass-casualty violence outranks a diplomatic summit — and is the knob to turn
 * when the dashboard feels miscalibrated for a given deployment's mission.
 */
const CATEGORY_WEIGHT: Record<EventCategory, number> = {
  terrorism: 1.0,
  armed_conflict: 0.95,
  natural_disaster: 0.9,
  seismic: 0.85,
  civil_unrest: 0.8,
  humanitarian: 0.8,
  severe_weather: 0.75,
  wildfire: 0.75,
  health: 0.75,
  cyber: 0.7,
  infrastructure: 0.65,
  political: 0.6,
  economy: 0.6,
  maritime: 0.55,
  aviation: 0.55,
  diplomacy: 0.5,
  space: 0.4,
  other: 0.35,
};

/** Confidence multiplier by how precisely we managed to locate the event. */
const PRECISION_CONFIDENCE: Record<GeoPrecision, number> = {
  exact: 1.0,
  city: 0.92,
  admin1: 0.75,
  country: 0.55,
  unknown: 0.3,
};

/**
 * Per-source magnitude → intensity (0..1) curves.
 *
 * Each entry documents the native scale it is translating, because these
 * numbers are meaningless without that context.
 */
const INTENSITY_CURVES: Record<string, (magnitude: number) => number> = {
  /**
   * Richter/moment magnitude. Logarithmic in energy already, so a linear ramp
   * over the felt-to-catastrophic band works well. M2.5 ≈ 0 (barely felt),
   * M9 ≈ 1 (megathrust).
   */
  'usgs.quakes': (m) => clamp01((m - 2.5) / 6.5),

  /**
   * GDELT Goldstein scale: -10 (most conflictual) .. +10 (most cooperative).
   * Intensity tracks conflict, so the scale is inverted. Cooperative events are
   * not zero-intensity — a peace treaty is significant — hence the |x| floor.
   */
  'gdelt.events': (g) => {
    const conflict = clamp01((-g + 10) / 20); // 0 at +10, 1 at -10
    const notability = Math.abs(g) / 10; // cooperation still registers
    return clamp01(0.6 * conflict + 0.4 * notability);
  },

  /**
   * GDACS alert level, pre-mapped by the connector to 1 (green) / 2 (orange) /
   * 3 (red).
   */
  'gdacs.alerts': (level) => clamp01((level - 0.5) / 2.5),

  /**
   * NWS severity, pre-mapped to 1 (Minor) .. 4 (Extreme).
   */
  'nws.alerts': (level) => clamp01((level - 0.5) / 3.5),

  /**
   * NASA FIRMS fire radiative power in megawatts. Heavy-tailed: most detections
   * are a few MW, large fire fronts reach thousands. Log compression.
   */
  'firms.fires': (frp) => clamp01(Math.log10(Math.max(frp, 1) + 1) / 3.5),

  /** NASA EONET has no magnitude; treat as mid-intensity. */
  'nasa.eonet': () => 0.5,

  /** NOAA G, R and S space-weather scales, normalized from 1 .. 5. */
  'noaa.swpc': (level) => clamp01((level - 0.5) / 4.5),
};

/** Fallback when a source has no registered curve or supplies no magnitude. */
const DEFAULT_INTENSITY = 0.4;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function intensityFor(sourceId: string, magnitude: number | null): number {
  if (magnitude === null || !Number.isFinite(magnitude)) return DEFAULT_INTENSITY;
  const curve = INTENSITY_CURVES[sourceId];
  return curve ? clamp01(curve(magnitude)) : DEFAULT_INTENSITY;
}

/**
 * Corroboration: how much independent reporting backs this observation.
 *
 * Saturating (log) rather than linear — the jump from 1 source to 5 is far more
 * informative than 50 to 100, and a linear term would let a single viral story
 * dominate the globe.
 */
export function corroborationFactor(reportCount: number | null): number {
  const n = Math.max(1, reportCount ?? 1);
  return clamp01(Math.log10(n) / 2); // 1→0, 10→0.5, 100→1
}

export interface ScoreInput {
  sourceId: string;
  category: EventCategory;
  categoryConfidence: number;
  magnitude: number | null;
  tone: number | null;
  reportCount: number | null;
  geoPrecision: GeoPrecision;
  /** Distinct sources across the whole event; 1 for a lone observation. */
  sourceCount?: number;
}

/**
 * Severity, 0..100.
 *
 * severity = 100 · categoryWeight · (0.6·intensity + 0.25·corroboration + 0.15·negativeTone)
 *
 * Tone contributes only its negative half: strongly negative coverage is a
 * signal that something bad is happening, but strongly positive coverage is not
 * evidence of severity, so it must not inflate the score.
 */
export function computeSeverity(input: ScoreInput): number {
  const intensity = intensityFor(input.sourceId, input.magnitude);
  const corroboration = corroborationFactor(
    Math.max(input.reportCount ?? 1, input.sourceCount ?? 1),
  );
  const negativeTone = input.tone === null ? 0.3 : clamp01(-input.tone);

  const raw =
    CATEGORY_WEIGHT[input.category] *
    (0.6 * intensity + 0.25 * corroboration + 0.15 * negativeTone);

  return Math.round(clamp01(raw) * 100);
}

/**
 * Confidence, 0..100 — is this real, and is it where we think it is?
 *
 * Deliberately independent of severity so the two can be filtered separately.
 * Multiplicative because the factors are failure modes, not contributions: a
 * confident classification cannot rescue an unlocatable event.
 */
export function computeConfidence(input: ScoreInput): number {
  const geo = PRECISION_CONFIDENCE[input.geoPrecision];
  const classification = 0.5 + 0.5 * clamp01(input.categoryConfidence);
  // A second independent source is the single biggest confidence gain.
  const independence = clamp01(0.6 + 0.4 * corroborationFactor(input.sourceCount ?? 1));
  return Math.round(clamp01(geo * classification * independence) * 100);
}

/**
 * Recency-weighted decay used to rank the live feed and age events out of the
 * "active" view.
 *
 * The half-life measures how long an event stays *situationally relevant*, not
 * how long the physical process lasts. That distinction was learned from real
 * output: an initial 6-hour seismic half-life — reasoning that ground shaking is
 * over in minutes — pushed a magnitude-7.7 earthquake with 47 confirmed deaths
 * and five corroborating sources *below* routine county flood warnings within a
 * single day. The shaking was over; the event emphatically was not.
 *
 * So these track the lifetime of the human situation: casualties, rescue,
 * aftershocks, displacement.
 */
const HALF_LIFE_HOURS: Partial<Record<EventCategory, number>> = {
  seismic: 48,
  severe_weather: 24,
  wildfire: 72,
  cyber: 48,
  natural_disaster: 96,
  armed_conflict: 96,
  terrorism: 96,
  humanitarian: 168,
  health: 168,
  economy: 120,
};

const DEFAULT_HALF_LIFE_HOURS = 36;

export function halfLifeHours(category: EventCategory): number {
  return HALF_LIFE_HOURS[category] ?? DEFAULT_HALF_LIFE_HOURS;
}

/** Multiplier in (0,1] applied to severity for ranking the live feed. */
export function recencyWeight(category: EventCategory, ageHours: number): number {
  const hl = halfLifeHours(category);
  return Math.pow(0.5, Math.max(0, ageHours) / hl);
}

export function categoryWeight(category: EventCategory): number {
  return CATEGORY_WEIGHT[category];
}

/** Convenience wrapper for scoring a freshly enriched draft. */
export function scoreObservation(
  draft: Pick<ParsedObservationDraft, 'sourceId' | 'magnitude' | 'tone' | 'reportCount'>,
  category: EventCategory,
  categoryConfidence: number,
  geoPrecision: GeoPrecision,
): { severity: number; confidence: number } {
  const input: ScoreInput = {
    sourceId: draft.sourceId,
    category,
    categoryConfidence,
    magnitude: draft.magnitude,
    tone: draft.tone,
    reportCount: draft.reportCount,
    geoPrecision,
  };
  return {
    severity: computeSeverity(input),
    confidence: computeConfidence(input),
  };
}
