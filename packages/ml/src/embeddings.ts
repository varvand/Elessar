import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { loadEnv, createLogger } from '@elessar/core';
import { resolve } from 'node:path';

/**
 * Sentence embeddings, computed locally.
 *
 * Running the model in-process rather than calling a hosted embedding API is a
 * deliberate architectural choice, not a cost optimization:
 *
 *   - It keeps Elessar genuinely free to operate, which is the whole premise.
 *   - It removes a hard dependency on a third party for the pipeline's hot path.
 *   - It means no observation text ever leaves the operator's machine. For a
 *     tool whose users may be tracking sensitive situations, that matters.
 *
 * Model: all-MiniLM-L6-v2 (Apache-2.0), 384 dimensions, ONNX int8. Chosen for
 * the throughput/quality tradeoff — roughly 90 MB on disk, thousands of short
 * texts per second on a laptop CPU, and mean-pooled + L2-normalized output so
 * cosine similarity is just a dot product.
 *
 * Measured on an M-series laptop: ~10 s cold load, then <2 ms per short text in
 * batches of 32.
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/**
 * Must match `EMBEDDING_DIMENSIONS` in the DB schema. Asserted at load time
 * rather than trusted: a model swap that changes width would otherwise fail
 * deep inside a Postgres insert with an opaque error.
 */
export const EMBEDDING_DIM = 384;

/** Texts per forward pass. Larger batches help until memory traffic dominates. */
const BATCH_SIZE = 32;

const log = createLogger({ module: 'embeddings' });

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= (async () => {
    const cacheDir = resolve(process.cwd(), loadEnv().ELESSAR_MODEL_CACHE);

    // Cache locally so the ~90 MB download happens exactly once, and keep the
    // browser-oriented cache off since we always run under Node.
    env.cacheDir = cacheDir;
    env.useBrowserCache = false;
    env.allowLocalModels = true;

    const started = Date.now();
    log.info({ model: MODEL_ID, cacheDir }, 'loading embedding model (first run downloads ~90MB)');

    const extractor = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
    });

    log.info({ ms: Date.now() - started }, 'embedding model ready');
    return extractor;
  })();

  return extractorPromise;
}

/**
 * Embed a batch of texts. Output vectors are mean-pooled and L2-normalized, so
 * `dot(a, b) === cosineSimilarity(a, b)`.
 *
 * Empty and whitespace-only inputs get a zero vector rather than an exception:
 * the pipeline must never fail a whole batch because one feed served an empty
 * body, and a zero vector has similarity 0 to everything, which is the correct
 * semantics for "no information".
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getExtractor();
  const results: number[][] = new Array(texts.length);

  // Route blanks around the model entirely.
  const liveIndices: number[] = [];
  const liveTexts: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i]?.trim() ?? '';
    if (text === '') {
      results[i] = new Array<number>(EMBEDDING_DIM).fill(0);
    } else {
      liveIndices.push(i);
      liveTexts.push(text);
    }
  }

  for (let start = 0; start < liveTexts.length; start += BATCH_SIZE) {
    const slice = liveTexts.slice(start, start + BATCH_SIZE);
    const tensor = await extractor(slice, { pooling: 'mean', normalize: true });
    const vectors = tensor.tolist() as number[][];

    for (let j = 0; j < vectors.length; j += 1) {
      const vector = vectors[j];
      if (!vector) continue;
      if (vector.length !== EMBEDDING_DIM) {
        throw new Error(
          `Embedding width ${vector.length} does not match the schema's ${EMBEDDING_DIM}. ` +
            'Changing models requires a migration and a re-embed.',
        );
      }
      const targetIndex = liveIndices[start + j];
      if (targetIndex !== undefined) results[targetIndex] = vector;
    }
  }

  return results;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text]);
  return vector ?? new Array<number>(EMBEDDING_DIM).fill(0);
}

/** Warm the model before the first real batch, so timings are not misleading. */
export async function warmUpEmbeddings(): Promise<void> {
  await embedBatch(['warmup']);
}
