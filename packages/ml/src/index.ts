export { embedBatch, embedOne, warmUpEmbeddings, EMBEDDING_DIM } from './embeddings';

export {
  loadGazetteer,
  isGazetteerSeeded,
  gazetteerStats,
  gazetteerFiles,
  findPlaceByName,
  findPlaceInText,
  findLocationInText,
  findNearestPlace,
  findCountryByName,
  getCountryByIso2,
  fipsToIso2,
  type Place,
  type Country,
  type TextLocation,
} from './gazetteer';

export {
  resolveLocation,
  resolveObservationLocation,
  cellFor,
  type GeocodeInput,
} from './geocode';

export {
  initClassifier,
  classify,
  classifyWithPrior,
  priorStrengthFor,
  lexicalScores,
  type Classification,
} from './classify';

export {
  extractEntities,
  pointwiseMutualInformation,
  orderEdge,
  type ExtractOptions,
} from './entities';

export {
  findBestCluster,
  computeVelocity,
  deriveStatus,
  BASE_SIMILARITY_THRESHOLD,
  type ClusterCandidate,
  type ClusterSubject,
  type MatchResult,
} from './cluster';

export {
  updateBaseline,
  detectAnomaly,
  describeAnomaly,
  alertDedupKey,
  standardDeviation,
  DEFAULT_Z_THRESHOLD,
  type BaselineState,
  type BaselineUpdate,
  type AnomalySignal,
} from './anomaly';

export {
  selectSummarySentences,
  candidateSentences,
  selectEventTitle,
  type SummaryCandidate,
} from './summarize';

/**
 * One-shot initialization for everything in this package that has startup cost:
 * the gazetteer index and the classifier prototype embeddings (which need the
 * model loaded). Call once, before the first pipeline run.
 */
export async function initMl(): Promise<void> {
  const [{ loadGazetteer }, { initClassifier }] = await Promise.all([
    import('./gazetteer'),
    import('./classify'),
  ]);
  await loadGazetteer();
  await initClassifier();
}
