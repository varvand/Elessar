import { describe, expect, it } from 'vitest';
import { cosineSimilarity, dot, magnitude, normalize, updateCentroid } from './vector';

describe('dot', () => {
  it('computes the inner product', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('throws on a dimension mismatch instead of silently truncating', () => {
    // A mismatch means a model change or a corrupt row. Comparing the overlap
    // would produce a plausible-looking similarity from incompatible vectors.
    expect(() => dot([1, 2], [1, 2, 3])).toThrow(/mismatch/i);
  });
});

describe('magnitude / normalize', () => {
  it('measures and rescales to unit length', () => {
    expect(magnitude([3, 4])).toBe(5);
    expect(magnitude(normalize([3, 4]))).toBeCloseTo(1, 12);
  });

  it('leaves the zero vector alone rather than dividing by zero', () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
    expect(magnitude([0, 0, 0])).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposed', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
  });

  it('ignores magnitude, as a cosine must', () => {
    expect(cosineSimilarity([1, 1], [5, 5])).toBeCloseTo(1, 12);
  });

  it('normalizes defensively rather than assuming unit inputs', () => {
    // Production embeddings are L2-normalized, but an unnormalized vector must
    // not silently turn every similarity into garbage — the failure is invisible.
    expect(cosineSimilarity([3, 4], [3, 4])).toBeCloseTo(1, 12);
  });

  it('returns 0 against the zero vector', () => {
    // A blank document has no information; similarity 0 to everything is correct.
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('updateCentroid', () => {
  it('REGRESSION: matches the batch mean exactly', () => {
    // Clusters grow one observation at a time, and event centroids are maintained
    // incrementally to avoid O(n^2) re-averaging across a run. If the incremental
    // update drifts from the true mean, every clustering decision degrades
    // gradually and invisibly as an event accumulates members.
    const members = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [2, 1, 0],
      [0, 0, 6],
    ];

    let centroid = members[0]!;
    for (let i = 1; i < members.length; i += 1) {
      centroid = updateCentroid(centroid, i, members[i]!);
    }

    const batch = [0, 1, 2].map(
      (dim) => members.reduce((sum, m) => sum + m[dim]!, 0) / members.length,
    );

    for (let dim = 0; dim < 3; dim += 1) {
      expect(centroid[dim]).toBeCloseTo(batch[dim]!, 10);
    }
  });

  it('adopts the incoming vector when the cluster is empty', () => {
    expect(updateCentroid([0, 0], 0, [5, 7])).toEqual([5, 7]);
    expect(updateCentroid([9, 9], -1, [5, 7])).toEqual([5, 7]);
  });

  it('moves the centroid less as the cluster grows', () => {
    const near = updateCentroid([0, 0], 1, [10, 10]);
    const far = updateCentroid([0, 0], 100, [10, 10]);
    expect(near[0]!).toBeGreaterThan(far[0]!);
  });

  it('does not mutate its inputs', () => {
    const centroid = [1, 1];
    const incoming = [3, 3];
    updateCentroid(centroid, 1, incoming);
    expect(centroid).toEqual([1, 1]);
    expect(incoming).toEqual([3, 3]);
  });
});
