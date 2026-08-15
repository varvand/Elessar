export * as schema from './schema';
export {
  sources,
  observations,
  events,
  eventObservations,
  entities,
  observationEntities,
  entityEdges,
  baselines,
  alerts,
  ingestRuns,
  EMBEDDING_DIMENSIONS,
  type SourceRow,
  type ObservationRow,
  type NewObservation,
  type EventRow,
  type NewEvent,
  type EntityRow,
  type AlertRow,
  type BaselineRow,
} from './schema';
export {
  createDatabase,
  getDatabase,
  closeDatabase,
  toVector,
  fromVector,
  type Database,
} from './client';
export * from './queries';
