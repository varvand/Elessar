/**
 * Vector maths for the correlation stage.
 *
 * Embeddings from `@elessar/ml` are L2-normalized on production, which makes
 * cosine similarity equal to the dot product. `cosineSimilarity` does not assume
 * that — it normalizes defensively — because a silently unnormalized vector
 * turns every similarity into garbage and the failure is invisible.
 */

export function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
}

export function magnitude(a: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const denom = magnitude(a) * magnitude(b);
  if (denom === 0) return 0;
  return dot(a, b) / denom;
}

/** L2-normalize in place-safe fashion, returning a new array. */
export function normalize(a: readonly number[]): number[] {
  const mag = magnitude(a);
  if (mag === 0) return [...a];
  return a.map((v) => v / mag);
}

/**
 * Incremental centroid update. Clusters grow one observation at a time, and
 * recomputing a mean over every member on each arrival is O(n²) across a run —
 * at GDELT's volume that is the difference between seconds and minutes.
 */
export function updateCentroid(
  centroid: readonly number[],
  count: number,
  incoming: readonly number[],
): number[] {
  if (count <= 0) return [...incoming];
  const next = new Array<number>(centroid.length);
  for (let i = 0; i < centroid.length; i += 1) {
    next[i] = ((centroid[i] as number) * count + (incoming[i] as number)) / (count + 1);
  }
  return next;
}
