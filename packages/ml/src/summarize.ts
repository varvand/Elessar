import { cleanText, cosineSimilarity, sentences, truncate } from '@elessar/core';

/**
 * Extractive summarization for event clusters.
 *
 * Extractive, not generative, and that is a deliberate constraint rather than a
 * limitation to apologize for. An event summary in this system is evidence: it
 * has to be attributable to a specific source sentence an analyst can go read.
 * A generated paraphrase can smooth over a contradiction between two sources or
 * invent a casualty figure, and in a situational-awareness context that failure
 * mode is unacceptable. Every sentence in the output appeared verbatim in a
 * source document.
 *
 * Method: score each candidate sentence by cosine similarity to the cluster
 * centroid, then greedily select high-scoring sentences while suppressing ones
 * too similar to what is already chosen (a small MMR-style redundancy penalty).
 * Without that penalty the output is the same fact restated by three outlets,
 * which is what the cluster already told you.
 */

export interface SummaryCandidate {
  text: string;
  /** Embedding of this sentence. */
  embedding: readonly number[];
  /** Source severity, used to break ties toward more consequential reporting. */
  severity: number;
}

export interface SummarizeOptions {
  maxSentences?: number;
  maxChars?: number;
  /** How strongly to penalize similarity to already-selected sentences. */
  redundancyPenalty?: number;
}

/**
 * Select representative sentences from a cluster.
 *
 * `centroid` should be the event centroid — the mean of member embeddings — so
 * the selected sentences are the ones most typical of the cluster as a whole
 * rather than of any single document.
 */
export function selectSummarySentences(
  candidates: SummaryCandidate[],
  centroid: readonly number[],
  options: SummarizeOptions = {},
): string[] {
  const maxSentences = options.maxSentences ?? 3;
  const redundancyPenalty = options.redundancyPenalty ?? 0.65;
  const maxChars = options.maxChars ?? 600;

  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      relevance:
        cosineSimilarity(candidate.embedding, centroid) + candidate.severity / 1000,
    }))
    .sort((a, b) => b.relevance - a.relevance);

  const selected: SummaryCandidate[] = [];
  let totalChars = 0;

  for (const candidate of scored) {
    if (selected.length >= maxSentences) break;
    if (totalChars + candidate.text.length > maxChars && selected.length > 0) continue;

    // Maximal marginal relevance: skip anything that mostly repeats a sentence
    // already chosen.
    const maxOverlap = selected.reduce(
      (max, chosen) => Math.max(max, cosineSimilarity(candidate.embedding, chosen.embedding)),
      0,
    );
    if (maxOverlap > redundancyPenalty) continue;

    selected.push(candidate);
    totalChars += candidate.text.length;
  }

  return selected.map((s) => s.text);
}

/**
 * Split documents into summary candidates.
 *
 * Very short fragments are dropped (bylines, "Read more", datelines) and very
 * long ones truncated, since a 400-character sentence is usually a parsing
 * artefact rather than prose.
 */
export function candidateSentences(
  documents: { body: string | null; title: string; severity: number }[],
  maxPerDocument = 4,
): { text: string; severity: number }[] {
  const out: { text: string; severity: number }[] = [];

  for (const document of documents) {
    // The title is always a candidate: it is a human-written summary already.
    const title = cleanText(document.title);
    if (title.length >= 25) {
      out.push({ text: title, severity: document.severity });
    }

    if (!document.body) continue;

    let taken = 0;
    for (const sentence of sentences(document.body)) {
      if (taken >= maxPerDocument) break;
      if (sentence.length < 40 || sentence.length > 400) continue;
      out.push({ text: truncate(sentence, 320), severity: document.severity });
      taken += 1;
    }
  }

  return out;
}

/**
 * Pick the event's display headline.
 *
 * Prefers a real, human-written headline over a machine-synthesized one: GDELT
 * titles are assembled from CAMEO codes and read like database rows, so when a
 * news observation joined the same cluster its headline is the better label.
 */
export function selectEventTitle(
  members: { title: string; sourceId: string; severity: number; occurredAt: Date }[],
): string {
  if (members.length === 0) return 'Unnamed event';

  const scored = members.map((member) => {
    const isSynthetic = member.sourceId.startsWith('gdelt.');
    const isEditorial = member.sourceId.startsWith('rss.');
    // Severity is the primary signal; provenance adjusts it.
    let score = member.severity;
    if (isEditorial) score += 25;
    if (isSynthetic) score -= 20;
    // Prefer titles of a readable length; very short ones lack context and very
    // long ones are usually a whole lede paragraph.
    const length = member.title.length;
    if (length >= 40 && length <= 140) score += 10;
    if (length < 20) score -= 15;
    return { title: member.title, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return truncate(scored[0]!.title, 200);
}
