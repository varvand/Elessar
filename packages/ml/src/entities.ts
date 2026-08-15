import winkNlp, { type ItemEntity } from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import { normalizeKey, type EntityKind, type ExtractedEntity } from '@elessar/core';
import { findCountryByName, findPlaceByName } from './gazetteer';

/**
 * Named entity extraction.
 *
 * Uses wink-nlp (MIT) with its lite English model: a real POS tagger and entity
 * recognizer that runs in ~1 ms per document, pure JS, no native deps and no
 * network. A transformer NER model would be more accurate but roughly 100× slower
 * — and at GDELT's volume the pipeline has to keep up with a 15-minute cadence on
 * a laptop, so the tradeoff is decided by throughput.
 *
 * wink's own entity types are then reconciled against the gazetteer, which
 * matters because the entity graph is only useful if "Israel" the country and
 * "Israel" the person-name never collapse into one node.
 */

const nlp = winkNlp(model);
const its = nlp.its;

/**
 * wink entity types we keep, mapped to our own kinds.
 * ORDINAL/CARDINAL/DATE/TIME/MONEY etc. are dropped — they are not actors.
 */
const WINK_KIND: Record<string, EntityKind> = {
  PERSON: 'person',
  ORG: 'organization',
  GPE: 'place', // geopolitical entity
  LOC: 'place',
  FAC: 'place', // facility
  NORP: 'group', // nationalities, religious or political groups
  EVENT: 'unknown',
};

/**
 * Tokens that surface constantly in newswire copy and are never useful graph
 * nodes. Without this, "Reuters", "Monday" and "Getty Images" dominate the
 * entity graph's highest-degree nodes and bury the actual actors.
 */
const STOP_ENTITIES = new Set(
  [
    'reuters', 'ap', 'associated press', 'afp', 'bbc', 'cnn', 'getty', 'getty images',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
    'today', 'yesterday', 'tomorrow', 'this week', 'last week', 'the week',
    'twitter', 'x', 'facebook', 'instagram', 'youtube', 'tiktok', 'telegram',
    'read more', 'advertisement', 'subscribe', 'newsletter', 'copyright',
    'al jazeera', 'dw', 'france 24', 'the guardian', 'new york times',
  ].map(normalizeKey),
);

/** Minimum surface length; single letters and initials are noise. */
const MIN_SURFACE_LENGTH = 3;

export interface ExtractOptions {
  /** Actor names the source stated explicitly; trusted above anything inferred. */
  declaredActors?: string[];
  maxEntities?: number;
}

/**
 * Extract entities from text, merging model output with source-declared actors
 * and gazetteer knowledge.
 */
export function extractEntities(text: string, options: ExtractOptions = {}): ExtractedEntity[] {
  const found = new Map<string, ExtractedEntity>();

  const add = (surface: string, kind: EntityKind, confidence: number) => {
    const trimmed = surface.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, '');
    if (trimmed.length < MIN_SURFACE_LENGTH) return;

    const key = normalizeKey(trimmed);
    if (key.length < MIN_SURFACE_LENGTH || STOP_ENTITIES.has(key)) return;
    // Pure numbers slip through the model's ORG detection surprisingly often.
    if (/^\d+$/.test(key)) return;

    const existing = found.get(key);
    if (existing) {
      existing.mentions += 1;
      // Keep the highest-confidence reading of the kind.
      if (confidence > existing.confidence) {
        existing.confidence = confidence;
        existing.kind = kind;
      }
      return;
    }

    found.set(key, { surface: trimmed, key, kind, mentions: 1, confidence });
  };

  // 1. Source-declared actors. GDELT names them structurally, so no inference
  //    is involved and they get top confidence.
  for (const actor of options.declaredActors ?? []) {
    add(actor, classifyKnownName(actor) ?? 'organization', 0.95);
  }

  // 2. Model-detected entities.
  if (text.trim() !== '') {
    const doc = nlp.readDoc(text.slice(0, 8000));
    // Annotated explicitly: wink's `each` overload is a union of two callback
    // shapes, which defeats parameter inference under `noImplicitAny`.
    doc.entities().each((entity: ItemEntity) => {
      const type = entity.out(its.type);
      const kind = WINK_KIND[type ?? ''];
      if (!kind) return;

      const surface = entity.out();
      // Reconcile against the gazetteer: it overrules the model on place-ness,
      // since a confirmed populated place is not a guess.
      const gazetteerKind = classifyKnownName(surface);
      add(surface, gazetteerKind ?? kind, gazetteerKind ? 0.85 : 0.65);
    });
  }

  const limit = options.maxEntities ?? 25;
  return [...found.values()]
    .sort((a, b) => b.mentions * b.confidence - a.mentions * a.confidence)
    .slice(0, limit);
}

/**
 * Ask the gazetteer whether a surface form is a known country or populated
 * place. Returns null when unknown, meaning "no opinion" rather than "not a place".
 */
function classifyKnownName(surface: string): EntityKind | null {
  try {
    if (findCountryByName(surface)) return 'place';
    const place = findPlaceByName(surface);
    // Require a substantial place: small towns share names with many surnames,
    // and misclassifying a person as a place corrupts the graph.
    if (place && place.population >= 100_000) return 'place';
  } catch {
    // Gazetteer not loaded (e.g. in a unit test) — fall back to the model.
    return null;
  }
  return null;
}

/**
 * Pointwise mutual information for an entity pair.
 *
 *   PMI = log2( P(a,b) / (P(a)·P(b)) )
 *
 * This is what makes the entity graph readable. Ranking edges by raw
 * co-occurrence yields a hairball centred on whichever country appears most
 * often; PMI instead surfaces pairs that appear together *more than their
 * individual frequencies predict*, which is the definition of a meaningful link.
 *
 * `totalDocuments` must be the same corpus the counts were taken from, or the
 * probabilities are incommensurable and the ranking is meaningless.
 */
export function pointwiseMutualInformation(
  coOccurrences: number,
  countA: number,
  countB: number,
  totalDocuments: number,
): number {
  if (coOccurrences <= 0 || countA <= 0 || countB <= 0 || totalDocuments <= 0) return 0;

  const pAB = coOccurrences / totalDocuments;
  const pA = countA / totalDocuments;
  const pB = countB / totalDocuments;
  const ratio = pAB / (pA * pB);
  if (ratio <= 0) return 0;

  const pmi = Math.log2(ratio);

  // Normalize by -log2(pAB) to get NPMI in [-1, 1], which keeps the score
  // comparable as the corpus grows. Raw PMI drifts upward with corpus size and
  // would make thresholds tuned today wrong next month.
  const denominator = -Math.log2(pAB);
  if (denominator <= 0) return pmi > 0 ? 1 : 0;
  return Math.max(-1, Math.min(1, pmi / denominator));
}

/**
 * Canonical ordering for an undirected edge, so a pair always writes to exactly
 * one row. `entity_edges` depends on this invariant; without it each pair
 * accumulates two half-weight rows.
 */
export function orderEdge(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
