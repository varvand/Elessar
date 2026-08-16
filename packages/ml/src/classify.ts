import {
  CATEGORY_LEXICON,
  EVENT_CATEGORIES,
  cosineSimilarity,
  normalizeKey,
  type EventCategory,
} from '@elessar/core';
import { embedBatch } from './embeddings';

/**
 * Hybrid category classifier: lexical rules + embedding similarity to category
 * prototypes.
 *
 * Why hybrid rather than either alone:
 *
 *   - Pure lexicon is high precision, low recall. "Magnitude 6.2 offshore" is
 *     obviously seismic; "the ground shook for thirty seconds" is invisible to it.
 *   - Pure embedding similarity is the reverse: good recall, but it happily
 *     scores a football match as `armed_conflict` because sports writing borrows
 *     the vocabulary of battle.
 *
 * Combining them lets each cover the other's failure mode, and — importantly for
 * a system an analyst has to trust — the lexical half is fully inspectable. When
 * a classification looks wrong you can see exactly which terms fired.
 *
 * This is zero-shot: no labelled training data, no training step, nothing to
 * retrain when the taxonomy changes. Adding a category means adding a prototype
 * sentence and some keywords.
 */

/**
 * Prototype descriptions, embedded once at startup. These are written as
 * *newswire sentences* rather than category names, because the embedding space
 * places "armed_conflict" nowhere near an actual report of fighting, while a
 * representative sentence sits right in the middle of the cluster we want.
 */
const CATEGORY_PROTOTYPES: Record<EventCategory, string[]> = {
  armed_conflict: [
    'Military forces exchanged fire and launched airstrikes, killing soldiers and civilians in the contested region.',
    'Troops advanced on the city as artillery shelling intensified along the front line.',
  ],
  civil_unrest: [
    'Thousands of demonstrators marched through the capital and clashed with riot police, who responded with tear gas.',
    'A general strike shut down the city amid growing protests against the government.',
  ],
  terrorism: [
    'A suicide bombing at a crowded market killed dozens; a militant group claimed responsibility for the attack.',
    'Gunmen stormed the building and took hostages in a coordinated terrorist assault.',
  ],
  political: [
    'The parliament voted on a contested bill as the president faced impeachment proceedings and the cabinet resigned.',
    'Election results were disputed and the opposition demanded a recount.',
  ],
  diplomacy: [
    'Foreign ministers met for talks at a summit and signed a bilateral cooperation treaty.',
    'The ambassador was recalled as the two countries negotiated a new agreement.',
  ],
  natural_disaster: [
    'A landslide buried homes after days of heavy rain, and rescue teams searched the debris for survivors.',
    'A volcano erupted, prompting mass evacuations from surrounding villages.',
  ],
  severe_weather: [
    'A powerful hurricane made landfall with destructive winds and storm surge, flooding coastal towns.',
    'Torrential rain caused widespread flooding and a tornado damaged hundreds of buildings.',
  ],
  wildfire: [
    'A fast-moving wildfire burned thousands of hectares of forest, forcing evacuation orders for nearby communities.',
    'Firefighters battled a bushfire that destroyed homes amid extreme heat and wind.',
  ],
  seismic: [
    'A strong earthquake of magnitude 6.5 struck at shallow depth, collapsing buildings and triggering a tsunami warning.',
    'Aftershocks continued near the epicentre following the quake.',
  ],
  health: [
    'Health authorities reported a growing outbreak of cholera, with hundreds of confirmed infections and a rising death toll.',
    'The epidemic spread across the region as hospitals were overwhelmed and vaccination campaigns began.',
  ],
  humanitarian: [
    'Hundreds of thousands of refugees fled the region, facing famine and acute malnutrition as aid convoys were blocked.',
    'Displaced families in camps lack clean water and emergency food assistance.',
  ],
  cyber: [
    'A ransomware attack breached the network and encrypted systems, exposing sensitive data of millions of users.',
    'Hackers exploited a zero-day vulnerability in a coordinated cyberattack on critical infrastructure.',
  ],
  economy: [
    'The central bank raised interest rates as inflation surged and the currency fell sharply against the dollar.',
    'Markets tumbled amid recession fears, new tariffs and a sovereign debt default.',
  ],
  infrastructure: [
    'A widespread power outage left millions without electricity after the grid failed.',
    'A bridge collapsed and the pipeline ruptured, disrupting water supply and rail transport.',
  ],
  maritime: [
    'A tanker was seized in the strait as piracy incidents rose along the shipping lane, and the port was closed.',
    'A cargo vessel ran aground, blocking the channel to commercial traffic.',
  ],
  aviation: [
    'A passenger plane crashed shortly after takeoff, and the airport was closed as airspace restrictions took effect.',
    'Flights were diverted after a no-fly zone was declared over the region.',
  ],
  space: [
    'A satellite was launched into orbit while a severe geomagnetic storm from a solar flare disrupted communications.',
    'The spacecraft completed its orbital manoeuvre around the planet.',
  ],
  other: [
    'A cultural festival, sporting fixture or routine local announcement of limited wider significance.',
    'A celebrity appearance, entertainment release or human interest feature story.',
  ],
};

/**
 * Weight of the semantic signal versus the lexical one.
 *
 * Tuned toward the lexicon (0.45) because its false positives are rare and
 * explainable, whereas embedding similarity between newswire sentences is
 * compressed into a narrow band — most real text scores 0.2–0.5 against several
 * prototypes at once, so it discriminates weakly on its own.
 */
const SEMANTIC_WEIGHT = 0.45;
const LEXICAL_WEIGHT = 0.55;

/** Below this, we decline to guess and return `other` with low confidence. */
const MIN_CONFIDENCE = 0.18;

interface Prototype {
  category: EventCategory;
  vectors: number[][];
}

let prototypes: Prototype[] | null = null;

/** Embed the prototypes. Called once during pipeline startup. */
export async function initClassifier(): Promise<void> {
  if (prototypes) return;

  const flat: { category: EventCategory; text: string }[] = [];
  for (const category of EVENT_CATEGORIES) {
    for (const text of CATEGORY_PROTOTYPES[category]) {
      flat.push({ category, text });
    }
  }

  const vectors = await embedBatch(flat.map((f) => f.text));
  const grouped = new Map<EventCategory, number[][]>();

  for (let i = 0; i < flat.length; i += 1) {
    const entry = flat[i]!;
    const vector = vectors[i];
    if (!vector) continue;
    const list = grouped.get(entry.category) ?? [];
    list.push(vector);
    grouped.set(entry.category, list);
  }

  prototypes = [...grouped.entries()].map(([category, vecs]) => ({
    category,
    vectors: vecs,
  }));
}

/**
 * Lexical scores, normalized to 0..1 per category.
 *
 * Matching is done on the normalized text with space padding so that terms match
 * on word boundaries — an unpadded `includes('war')` fires on "warehouse",
 * "warning" and "toward", which is exactly the kind of error that erodes trust
 * in the whole classification.
 */
export function lexicalScores(text: string): Map<EventCategory, number> {
  const haystack = ` ${normalizeKey(text)} `;
  const scores = new Map<EventCategory, number>();

  for (const [category, terms] of Object.entries(CATEGORY_LEXICON)) {
    if (!terms) continue;
    let score = 0;
    let maxPossible = 0;

    for (const { term, weight } of terms) {
      maxPossible += weight;
      if (haystack.includes(` ${normalizeKey(term)} `)) {
        score += weight;
      } else if (term.length > 6 && haystack.includes(normalizeKey(term))) {
        // Long terms are allowed to match as a prefix so "volcan" catches
        // "volcanic"/"volcano"; short ones are not, to avoid substring noise.
        score += weight * 0.8;
      }
    }

    if (score > 0 && maxPossible > 0) {
      // Saturating: three strong hits should not score triple a single one.
      scores.set(category as EventCategory, Math.min(1, Math.sqrt(score / maxPossible) * 1.6));
    }
  }

  return scores;
}

export interface Classification {
  category: EventCategory;
  confidence: number;
  /** Runner-up categories with their scores, for the UI's "also matched" hint. */
  alternatives: { category: EventCategory; score: number }[];
}

/**
 * Classify pre-embedded text. The embedding is passed in rather than computed
 * here because the pipeline already needs it for clustering — embedding twice
 * would double the single most expensive step.
 */
export function classify(text: string, embedding: readonly number[]): Classification {
  if (!prototypes) {
    throw new Error('Classifier not initialised. Call initClassifier() during startup.');
  }

  const lexical = lexicalScores(text);
  const combined = new Map<EventCategory, number>();

  for (const prototype of prototypes) {
    // Max, not mean, over a category's prototypes: they describe genuinely
    // different facets (a hurricane and a flood are both severe_weather), and
    // averaging would penalize a text that matches one facet strongly.
    let semantic = 0;
    for (const vector of prototype.vectors) {
      const similarity = cosineSimilarity(embedding, vector);
      if (similarity > semantic) semantic = similarity;
    }

    const lexicalScore = lexical.get(prototype.category) ?? 0;
    combined.set(
      prototype.category,
      SEMANTIC_WEIGHT * Math.max(0, semantic) + LEXICAL_WEIGHT * lexicalScore,
    );
  }

  const ranked = [...combined.entries()]
    .map(([category, score]) => ({ category, score }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top || top.score < MIN_CONFIDENCE) {
    return {
      category: 'other',
      confidence: top ? top.score : 0,
      alternatives: ranked.slice(0, 3),
    };
  }

  // Confidence reflects *margin*, not absolute score. A text scoring 0.6 for
  // both armed_conflict and terrorism is genuinely ambiguous and should not be
  // reported as confident, whereas 0.4 with nothing else above 0.1 is clear.
  const runnerUp = ranked[1]?.score ?? 0;
  const margin = (top.score - runnerUp) / Math.max(top.score, 0.0001);
  const confidence = Math.min(1, top.score * (0.55 + 0.45 * margin));

  return {
    category: top.category,
    confidence,
    alternatives: ranked.slice(1, 4),
  };
}

/**
 * Classify with a connector-supplied category taken as a strong prior.
 *
 * Sources like USGS and GDACS know what they are reporting far better than any
 * classifier can infer — a USGS record is seismic, full stop. But GDELT's CAMEO
 * mapping is coarse (every statement becomes `political`), so its hint is worth
 * overriding when the text clearly says otherwise.
 */
export function classifyWithPrior(
  text: string,
  embedding: readonly number[],
  prior: EventCategory | null,
  priorStrength: 'authoritative' | 'weak' | 'none',
): Classification {
  const inferred = classify(text, embedding);

  if (!prior || priorStrength === 'none') return inferred;

  if (priorStrength === 'authoritative') {
    return {
      category: prior,
      confidence: Math.max(inferred.confidence, 0.9),
      // Surface what the classifier thought only when it disagreed — that
      // disagreement is the interesting signal for tuning the lexicon.
      alternatives:
        inferred.category === prior
          ? []
          : [{ category: inferred.category, score: inferred.confidence }],
    };
  }

  // Weak prior: it wins ties but loses to a confident disagreement.
  if (inferred.category === prior) {
    return { ...inferred, confidence: Math.min(1, inferred.confidence + 0.15) };
  }
  if (inferred.confidence < 0.35) {
    return { category: prior, confidence: 0.4, alternatives: inferred.alternatives };
  }
  return inferred;
}

/** How much to trust each source's own category assignment. */
export function priorStrengthFor(sourceId: string): 'authoritative' | 'weak' | 'none' {
  switch (sourceId) {
    // Instrument readings and official hazard bulletins: the source is right.
    case 'usgs.quakes':
    case 'gdacs.alerts':
    case 'nws.alerts':
    case 'firms.fires':
    case 'nasa.eonet':
    case 'noaa.swpc':
    case 'us.ofac':
      return 'authoritative';
    // GDELT's CAMEO mapping and ReliefWeb's structured metadata are useful but
    // coarse, so they should guide rather than override classification.
    case 'gdelt.events':
    case 'ocha.reliefweb':
      return 'weak';
    default:
      return 'none';
  }
}
