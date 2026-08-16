import type { EventDto } from './api-types';

export type MarketDirection = 'positive' | 'negative' | 'mixed' | 'unclear';
export type MarketChannel = 'security' | 'supply' | 'policy' | 'operations' | 'macro';

export interface MarketExposure {
  id: string;
  label: string;
  channel: MarketChannel;
  direction: MarketDirection;
  materiality: number;
  confidence: number;
  horizon: string;
  rationale: string;
}

export interface EventMarketImpact {
  eventId: string;
  materiality: number;
  confidence: number;
  exposures: MarketExposure[];
}

interface ExposureRule {
  categories?: string[];
  keywords?: RegExp;
  exposures: Omit<MarketExposure, 'materiality' | 'confidence'>[];
  baseMateriality: number;
  specificity: number;
}

const RULES: ExposureRule[] = [
  {
    categories: ['armed_conflict', 'terrorism'],
    exposures: [
      exposure(
        'defense',
        'Defense',
        'security',
        'positive',
        'days to weeks',
        'Security demand can increase during sustained conflict.',
      ),
      exposure(
        'regional-equities',
        'Regional equities',
        'security',
        'negative',
        'hours to days',
        'Conflict can raise local risk premiums and disrupt business activity.',
      ),
      exposure(
        'gold',
        'Gold',
        'security',
        'positive',
        'hours to days',
        'Risk aversion can increase demand for defensive assets.',
      ),
    ],
    baseMateriality: 82,
    specificity: 0.78,
  },
  {
    categories: ['civil_unrest', 'political'],
    exposures: [
      exposure(
        'regional-equities',
        'Regional equities',
        'policy',
        'negative',
        'hours to weeks',
        'Political uncertainty can raise local risk premiums.',
      ),
      exposure(
        'gold',
        'Gold',
        'policy',
        'positive',
        'hours to days',
        'Elevated uncertainty can support defensive positioning.',
      ),
    ],
    baseMateriality: 62,
    specificity: 0.62,
  },
  {
    categories: ['economy'],
    keywords: /\b(sanction|tariff|export control|embargo|designation|trade restriction)\w*\b/i,
    exposures: [
      exposure(
        'affected-exporters',
        'Affected exporters',
        'policy',
        'negative',
        'days to months',
        'Trade restrictions can reduce market access and raise compliance costs.',
      ),
      exposure(
        'banks',
        'Banks',
        'policy',
        'mixed',
        'days to weeks',
        'Sanctions can change payment flows and increase compliance risk.',
      ),
      exposure(
        'semiconductors',
        'Semiconductors',
        'supply',
        'mixed',
        'days to months',
        'Export controls can alter access to components and end markets.',
      ),
    ],
    baseMateriality: 76,
    specificity: 0.88,
  },
  {
    categories: ['economy'],
    keywords: /\b(interest rate|rate cut|rate hike|central bank|inflation|monetary policy)\b/i,
    exposures: [
      exposure(
        'banks',
        'Banks',
        'macro',
        'mixed',
        'hours to months',
        'Rate changes affect lending margins, credit demand and asset quality.',
      ),
      exposure(
        'growth-equities',
        'Growth equities',
        'macro',
        'mixed',
        'hours to months',
        'Discount-rate expectations can materially change growth valuations.',
      ),
    ],
    baseMateriality: 78,
    specificity: 0.86,
  },
  {
    categories: ['maritime'],
    exposures: [
      exposure(
        'marine-shipping',
        'Marine shipping',
        'supply',
        'negative',
        'hours to weeks',
        'Route or port disruption can raise transit times and operating costs.',
      ),
      exposure(
        'energy',
        'Energy producers',
        'supply',
        'positive',
        'hours to weeks',
        'Transport disruption can tighten available energy supply.',
      ),
      exposure(
        'airlines',
        'Airlines',
        'supply',
        'negative',
        'days to weeks',
        'Higher fuel costs can pressure airline margins.',
      ),
    ],
    baseMateriality: 68,
    specificity: 0.68,
  },
  {
    categories: ['aviation'],
    exposures: [
      exposure(
        'airlines',
        'Airlines',
        'operations',
        'negative',
        'hours to days',
        'Airspace and airport disruption can reduce capacity and raise costs.',
      ),
    ],
    baseMateriality: 62,
    specificity: 0.66,
  },
  {
    categories: ['cyber'],
    exposures: [
      exposure(
        'cybersecurity',
        'Cybersecurity',
        'operations',
        'positive',
        'days to weeks',
        'A major incident can accelerate defensive security spending.',
      ),
      exposure(
        'critical-operators',
        'Critical infrastructure operators',
        'operations',
        'negative',
        'hours to weeks',
        'Operational outages can create direct costs and service disruption.',
      ),
    ],
    baseMateriality: 70,
    specificity: 0.72,
  },
  {
    categories: ['infrastructure'],
    exposures: [
      exposure(
        'utilities',
        'Utilities',
        'operations',
        'negative',
        'hours to weeks',
        'Physical disruption can interrupt service and require unplanned spending.',
      ),
      exposure(
        'regional-equities',
        'Regional equities',
        'operations',
        'negative',
        'hours to days',
        'Infrastructure outages can interrupt regional economic activity.',
      ),
    ],
    baseMateriality: 66,
    specificity: 0.65,
  },
  {
    categories: ['natural_disaster', 'severe_weather', 'wildfire', 'seismic'],
    exposures: [
      exposure(
        'insurance',
        'Insurance',
        'operations',
        'negative',
        'days to months',
        'Damage can increase insured losses and claims uncertainty.',
      ),
      exposure(
        'utilities',
        'Regional utilities',
        'operations',
        'negative',
        'hours to weeks',
        'Damage can interrupt service and require restoration spending.',
      ),
      exposure(
        'regional-equities',
        'Regional equities',
        'operations',
        'negative',
        'hours to weeks',
        'Physical damage can interrupt local production and consumption.',
      ),
    ],
    baseMateriality: 72,
    specificity: 0.7,
  },
  {
    categories: ['natural_disaster', 'severe_weather'],
    keywords: /\b(drought|flood|crop|harvest|heatwave|heat wave)\b/i,
    exposures: [
      exposure(
        'agriculture',
        'Agriculture',
        'supply',
        'mixed',
        'days to months',
        'Crop and transport disruption can change regional supply expectations.',
      ),
    ],
    baseMateriality: 73,
    specificity: 0.82,
  },
  {
    categories: ['health'],
    exposures: [
      exposure(
        'healthcare',
        'Healthcare',
        'operations',
        'mixed',
        'days to months',
        'Demand may rise while health systems and supply chains face disruption.',
      ),
      exposure(
        'travel',
        'Travel and leisure',
        'operations',
        'negative',
        'days to months',
        'Outbreak controls and risk aversion can reduce travel demand.',
      ),
    ],
    baseMateriality: 60,
    specificity: 0.58,
  },
  {
    categories: ['space'],
    exposures: [
      exposure(
        'satellite-comms',
        'Satellite and communications',
        'operations',
        'negative',
        'hours to days',
        'Space weather can degrade satellite, navigation and radio services.',
      ),
      exposure(
        'utilities',
        'Utilities',
        'operations',
        'negative',
        'hours to days',
        'Geomagnetic activity can stress power-grid operations.',
      ),
      exposure(
        'airlines',
        'Airlines',
        'operations',
        'negative',
        'hours to days',
        'Polar routes and communications can require operational changes.',
      ),
    ],
    baseMateriality: 60,
    specificity: 0.76,
  },
];

function exposure(
  id: string,
  label: string,
  channel: MarketChannel,
  direction: MarketDirection,
  horizon: string,
  rationale: string,
): Omit<MarketExposure, 'materiality' | 'confidence'> {
  return { id, label, channel, direction, horizon, rationale };
}

function clampScore(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function deriveMarketImpact(event: EventDto): EventMarketImpact | null {
  const text = `${event.title} ${event.summary ?? ''}`;
  const matching = RULES.filter(
    (rule) =>
      (!rule.categories || rule.categories.includes(event.category)) &&
      (!rule.keywords || rule.keywords.test(text)),
  );
  if (matching.length === 0) return null;

  const eventStrength = Math.min(
    1,
    0.3 + event.severity / 250 + event.confidence / 500 + Math.min(2, event.velocity) / 20,
  );
  const byExposure = new Map<string, MarketExposure>();

  for (const rule of matching) {
    const materiality = clampScore(rule.baseMateriality * eventStrength);
    const confidence = clampScore(event.confidence * rule.specificity);
    for (const candidate of rule.exposures) {
      const current = byExposure.get(candidate.id);
      const next = { ...candidate, materiality, confidence };
      if (!current || next.materiality > current.materiality) byExposure.set(candidate.id, next);
    }
  }

  const exposures = [...byExposure.values()]
    .filter((item) => item.materiality >= 30 && item.confidence >= 20)
    .sort((a, b) => b.materiality - a.materiality || b.confidence - a.confidence);
  if (exposures.length === 0) return null;

  return {
    eventId: event.id,
    materiality: exposures[0]?.materiality ?? 0,
    confidence: clampScore(
      exposures.reduce((sum, item) => sum + item.confidence, 0) / exposures.length,
    ),
    exposures,
  };
}

export function deriveMarketImpacts(events: EventDto[]): EventMarketImpact[] {
  return events
    .map(deriveMarketImpact)
    .filter((impact): impact is EventMarketImpact => impact !== null)
    .sort((a, b) => b.materiality - a.materiality || b.confidence - a.confidence);
}
