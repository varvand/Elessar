/**
 * Event taxonomy.
 *
 * One flat, closed set of categories shared by every connector. Flat rather
 * than hierarchical on purpose: the dashboard filters on it, the anomaly
 * detector builds a baseline per (category, region) pair, and both get
 * materially harder if a category can be a parent of another.
 *
 * Adding a category is a migration-free change (it is a Postgres text column
 * validated in the app), but it *does* invalidate stored anomaly baselines for
 * whichever categories get re-partitioned.
 */

export const EVENT_CATEGORIES = [
  'armed_conflict',
  'civil_unrest',
  'terrorism',
  'political',
  'diplomacy',
  'natural_disaster',
  'severe_weather',
  'wildfire',
  'seismic',
  'health',
  'humanitarian',
  'cyber',
  'economy',
  'infrastructure',
  'maritime',
  'aviation',
  'space',
  'other',
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  armed_conflict: 'Armed Conflict',
  civil_unrest: 'Civil Unrest',
  terrorism: 'Terrorism',
  political: 'Political',
  diplomacy: 'Diplomacy',
  natural_disaster: 'Natural Disaster',
  severe_weather: 'Severe Weather',
  wildfire: 'Wildfire',
  seismic: 'Seismic',
  health: 'Health',
  humanitarian: 'Humanitarian',
  cyber: 'Cyber',
  economy: 'Economy',
  infrastructure: 'Infrastructure',
  maritime: 'Maritime',
  aviation: 'Aviation',
  space: 'Space',
  other: 'Other',
};

/**
 * Categories grouped for the dashboard legend. Purely presentational — the
 * pipeline never reads this.
 */
export const CATEGORY_GROUPS: { label: string; categories: EventCategory[] }[] = [
  {
    label: 'Security',
    categories: ['armed_conflict', 'terrorism', 'civil_unrest', 'cyber'],
  },
  {
    label: 'Governance',
    categories: ['political', 'diplomacy', 'economy'],
  },
  {
    label: 'Hazard',
    categories: ['seismic', 'severe_weather', 'wildfire', 'natural_disaster'],
  },
  {
    label: 'Human',
    categories: ['humanitarian', 'health'],
  },
  {
    label: 'Domain',
    categories: ['infrastructure', 'maritime', 'aviation', 'space', 'other'],
  },
];

export function isEventCategory(value: unknown): value is EventCategory {
  return typeof value === 'string' && (EVENT_CATEGORIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// CAMEO — the event ontology GDELT codes against.
// ---------------------------------------------------------------------------

/**
 * CAMEO root codes 01–20, in escalation order. GDELT gives us `EventRootCode`
 * as a zero-padded 2-char string; this maps it to our own taxonomy.
 *
 * Reference: GDELT Event Codebook V2.0, CAMEO Conflict and Mediation Event
 * Observations codebook.
 */
export const CAMEO_ROOT: Record<string, { label: string; category: EventCategory }> = {
  '01': { label: 'Make public statement', category: 'political' },
  '02': { label: 'Appeal', category: 'diplomacy' },
  '03': { label: 'Express intent to cooperate', category: 'diplomacy' },
  '04': { label: 'Consult', category: 'diplomacy' },
  '05': { label: 'Engage in diplomatic cooperation', category: 'diplomacy' },
  '06': { label: 'Engage in material cooperation', category: 'diplomacy' },
  '07': { label: 'Provide aid', category: 'humanitarian' },
  '08': { label: 'Yield', category: 'political' },
  '09': { label: 'Investigate', category: 'political' },
  '10': { label: 'Demand', category: 'political' },
  '11': { label: 'Disapprove', category: 'political' },
  '12': { label: 'Reject', category: 'political' },
  '13': { label: 'Threaten', category: 'political' },
  '14': { label: 'Protest', category: 'civil_unrest' },
  '15': { label: 'Exhibit force posture', category: 'armed_conflict' },
  '16': { label: 'Reduce relations', category: 'diplomacy' },
  '17': { label: 'Coerce', category: 'civil_unrest' },
  '18': { label: 'Assault', category: 'armed_conflict' },
  '19': { label: 'Fight', category: 'armed_conflict' },
  '20': { label: 'Use unconventional mass violence', category: 'terrorism' },
};

/**
 * GDELT QuadClass: a 4-way collapse of CAMEO along the
 * cooperation/conflict × verbal/material axes.
 */
export const QUAD_CLASS = {
  1: 'verbal_cooperation',
  2: 'material_cooperation',
  3: 'verbal_conflict',
  4: 'material_conflict',
} as const;

export type QuadClass = keyof typeof QUAD_CLASS;

export function cameoRootToCategory(rootCode: string | null | undefined): EventCategory {
  if (!rootCode) return 'other';
  return CAMEO_ROOT[rootCode.padStart(2, '0')]?.category ?? 'other';
}

export function cameoRootLabel(rootCode: string | null | undefined): string | null {
  if (!rootCode) return null;
  return CAMEO_ROOT[rootCode.padStart(2, '0')]?.label ?? null;
}

// ---------------------------------------------------------------------------
// Keyword classifier lexicon
// ---------------------------------------------------------------------------

/**
 * Weighted keyword cues per category, used by the lexical half of the hybrid
 * classifier in `@elessar/ml`. Deliberately high-precision: these fire on
 * unambiguous vocabulary only, because the embedding-based half of the
 * classifier handles everything fuzzy.
 *
 * Weights are relative within a category, so adding terms does not require
 * rebalancing the others.
 */
export const CATEGORY_LEXICON: Partial<Record<EventCategory, { term: string; weight: number }[]>> = {
  armed_conflict: [
    { term: 'airstrike', weight: 3 },
    { term: 'air strike', weight: 3 },
    { term: 'shelling', weight: 3 },
    { term: 'artillery', weight: 2.5 },
    { term: 'offensive', weight: 1.5 },
    { term: 'ceasefire', weight: 2 },
    { term: 'troops', weight: 1.5 },
    { term: 'military', weight: 1 },
    { term: 'combat', weight: 2 },
    { term: 'insurgent', weight: 2 },
    { term: 'militant', weight: 2 },
    { term: 'drone strike', weight: 3 },
    { term: 'missile', weight: 2.5 },
    { term: 'war', weight: 1.5 },
  ],
  civil_unrest: [
    { term: 'protest', weight: 3 },
    { term: 'demonstration', weight: 2.5 },
    { term: 'riot', weight: 3 },
    { term: 'strike action', weight: 2 },
    { term: 'unrest', weight: 2.5 },
    { term: 'clashes', weight: 2 },
    { term: 'crackdown', weight: 2 },
    { term: 'curfew', weight: 2 },
    { term: 'rally', weight: 1.5 },
  ],
  terrorism: [
    { term: 'terrorist', weight: 3 },
    { term: 'suicide bomb', weight: 3.5 },
    { term: 'car bomb', weight: 3 },
    { term: 'ied', weight: 2.5 },
    { term: 'hostage', weight: 2 },
    { term: 'claimed responsibility', weight: 2.5 },
  ],
  seismic: [
    { term: 'earthquake', weight: 3.5 },
    { term: 'magnitude', weight: 2.5 },
    { term: 'aftershock', weight: 3 },
    { term: 'tremor', weight: 2.5 },
    { term: 'epicenter', weight: 3 },
    { term: 'tsunami', weight: 3 },
    { term: 'volcan', weight: 2.5 },
  ],
  severe_weather: [
    { term: 'hurricane', weight: 3 },
    { term: 'typhoon', weight: 3 },
    { term: 'cyclone', weight: 3 },
    { term: 'tornado', weight: 3 },
    { term: 'flood', weight: 2.5 },
    { term: 'blizzard', weight: 2.5 },
    { term: 'heatwave', weight: 2.5 },
    { term: 'heat wave', weight: 2.5 },
    { term: 'drought', weight: 2 },
    { term: 'storm surge', weight: 3 },
  ],
  wildfire: [
    { term: 'wildfire', weight: 3.5 },
    { term: 'bushfire', weight: 3.5 },
    { term: 'forest fire', weight: 3 },
    { term: 'hectares burned', weight: 3 },
    { term: 'evacuation order', weight: 1.5 },
  ],
  health: [
    { term: 'outbreak', weight: 3 },
    { term: 'epidemic', weight: 3 },
    { term: 'pandemic', weight: 3 },
    { term: 'cholera', weight: 3 },
    { term: 'measles', weight: 3 },
    { term: 'ebola', weight: 3.5 },
    { term: 'infection', weight: 1.5 },
    { term: 'vaccine', weight: 1.5 },
    { term: 'quarantine', weight: 2 },
  ],
  cyber: [
    { term: 'ransomware', weight: 3.5 },
    { term: 'data breach', weight: 3 },
    { term: 'cyberattack', weight: 3.5 },
    { term: 'cyber attack', weight: 3.5 },
    { term: 'hacked', weight: 2.5 },
    { term: 'zero-day', weight: 3 },
    { term: 'ddos', weight: 3 },
    { term: 'malware', weight: 3 },
  ],
  economy: [
    { term: 'inflation', weight: 2.5 },
    { term: 'recession', weight: 3 },
    { term: 'central bank', weight: 2 },
    { term: 'interest rate', weight: 2.5 },
    { term: 'sanctions', weight: 2 },
    { term: 'tariff', weight: 2.5 },
    { term: 'default on debt', weight: 3 },
    { term: 'stock market', weight: 2 },
  ],
  infrastructure: [
    { term: 'power outage', weight: 3 },
    { term: 'blackout', weight: 3 },
    { term: 'pipeline', weight: 2 },
    { term: 'grid failure', weight: 3 },
    { term: 'bridge collapse', weight: 3 },
    { term: 'water supply', weight: 2 },
    { term: 'railway', weight: 1.5 },
  ],
  maritime: [
    { term: 'vessel', weight: 2 },
    { term: 'tanker', weight: 2.5 },
    { term: 'shipping lane', weight: 2.5 },
    { term: 'piracy', weight: 3 },
    { term: 'strait', weight: 1.5 },
    { term: 'port closure', weight: 2.5 },
  ],
  aviation: [
    { term: 'airspace', weight: 2.5 },
    { term: 'airport closed', weight: 3 },
    { term: 'flight diverted', weight: 2.5 },
    { term: 'plane crash', weight: 3.5 },
    { term: 'no-fly zone', weight: 3 },
  ],
  humanitarian: [
    { term: 'refugee', weight: 3 },
    { term: 'displaced', weight: 2.5 },
    { term: 'famine', weight: 3.5 },
    { term: 'humanitarian', weight: 2.5 },
    { term: 'aid convoy', weight: 3 },
    { term: 'malnutrition', weight: 3 },
  ],
  space: [
    { term: 'satellite launch', weight: 3 },
    { term: 'orbit', weight: 2 },
    { term: 'spacecraft', weight: 2.5 },
    { term: 'solar flare', weight: 3 },
    { term: 'geomagnetic storm', weight: 3 },
  ],
  natural_disaster: [
    { term: 'landslide', weight: 3 },
    { term: 'avalanche', weight: 3 },
    { term: 'sinkhole', weight: 2.5 },
    { term: 'disaster declaration', weight: 2.5 },
  ],
  diplomacy: [
    { term: 'summit', weight: 2 },
    { term: 'treaty', weight: 2.5 },
    { term: 'ambassador', weight: 2.5 },
    { term: 'negotiations', weight: 2 },
    { term: 'united nations', weight: 1.5 },
  ],
  political: [
    { term: 'election', weight: 2.5 },
    { term: 'parliament', weight: 2 },
    { term: 'impeachment', weight: 3 },
    { term: 'coup', weight: 3.5 },
    { term: 'referendum', weight: 2.5 },
    { term: 'resigned', weight: 2 },
  ],
};
