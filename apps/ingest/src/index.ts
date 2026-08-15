import { createLogger, loadEnv, sleep, type SourceDefinition } from '@elessar/core';
import { closeDatabase, createDatabase, sources } from '@elessar/db';
import { resolveAvailableConnectors } from '@elessar/connectors';
import { initMl, isGazetteerSeeded, warmUpEmbeddings } from '@elessar/ml';
import { eq } from 'drizzle-orm';
import { backoffSeconds, collectFromSource } from './stages/collect';
import { enrichPending } from './stages/enrich';
import { ageEvents, correlatePending } from './stages/correlate';
import { detectAnomalies } from './stages/detect';

/**
 * The ingest worker.
 *
 * A single process running one loop. Deliberately not a distributed job queue:
 * the whole workload is a few thousand observations per hour, which one process
 * handles comfortably, and a queue would add operational surface (broker, dead
 * letters, at-least-once semantics) for no throughput Elessar needs. The staged
 * `pipeline_stage` marker gives crash recovery without any of that.
 *
 * Each cycle:
 *   1. Collect from every source whose interval has elapsed
 *   2. Enrich   — geocode, embed, classify, extract entities, score
 *   3. Correlate — cluster into events, update the entity graph
 *   4. Detect   — fold hourly baselines, raise anomaly alerts
 *   5. Age      — retire events that have gone quiet
 *
 * Stages run in order because each consumes the previous stage's output, and a
 * source that fails never blocks the rest — its observations simply are not
 * there this cycle.
 */

const log = createLogger({ module: 'ingest' });

/** How often the loop wakes to check for due sources. */
const TICK_SECONDS = 30;

interface SourceSchedule {
  connector: SourceDefinition;
  nextRunAt: number;
}

async function main(): Promise<void> {
  const runOnce = process.argv.includes('--once');
  loadEnv();

  if (!isGazetteerSeeded()) {
    log.error('Gazetteer missing. Run `pnpm db:seed-gazetteer` first.');
    process.exitCode = 1;
    return;
  }

  const db = createDatabase({ max: 6 });
  const controller = new AbortController();

  // Graceful shutdown: finish the in-flight stage, then exit. Killing mid-batch
  // is safe thanks to pipeline_stage, but a clean exit avoids a torn HTTP fetch
  // being logged as a source failure and triggering pointless backoff.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      log.warn({ signal }, 'second signal — exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, 'shutting down after current stage');
    controller.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const { available, skipped } = resolveAvailableConnectors();
  for (const entry of skipped) {
    log.warn({ source: entry.id, reason: entry.reason }, 'source unavailable');
  }

  log.info(
    { sources: available.length, mode: runOnce ? 'once' : 'continuous' },
    'starting ingest worker',
  );

  // Load the gazetteer and embed the classifier prototypes before the first
  // cycle, so the initial run is not competing with a 90 MB model download.
  const initStarted = Date.now();
  await initMl();
  await warmUpEmbeddings();
  log.info({ ms: Date.now() - initStarted }, 'models and gazetteer ready');

  // Honour each source's own interval, offset so they do not all fire together
  // on a cold start and saturate the network.
  const schedule: SourceSchedule[] = available.map((connector, index) => ({
    connector,
    nextRunAt: Date.now() + (runOnce ? 0 : index * 1500),
  }));

  try {
    do {
      const cycleStarted = Date.now();
      const due = shuttingDown
        ? []
        : schedule.filter((entry) => entry.nextRunAt <= Date.now());

      // --- 1. Collect -----------------------------------------------------
      for (const entry of due) {
        if (controller.signal.aborted && !runOnce) break;

        const sourceLog = log.child({ source: entry.connector.id });
        const result = await collectFromSource(db, entry.connector, sourceLog, controller.signal);

        // Reschedule: healthy sources on their own interval, failing ones on
        // exponential backoff read back from the persisted failure count.
        if (result.outcome === 'error') {
          const [state] = await db
            .select({ failures: sources.consecutiveFailures })
            .from(sources)
            .where(eq(sources.id, entry.connector.id))
            .limit(1);
          const backoff = backoffSeconds(state?.failures ?? 1);
          entry.nextRunAt = Date.now() + backoff * 1000;
          sourceLog.warn({ backoffSeconds: backoff }, 'backing off after failure');
        } else {
          entry.nextRunAt = Date.now() + entry.connector.intervalSeconds * 1000;
        }
      }

      // --- 2-5. Process whatever arrived ----------------------------------
      // Bounded batches per cycle so a large backlog drains progressively
      // instead of blocking the loop (and therefore collection) for minutes.
      const enriched = await enrichPending(db, log, { maxBatches: runOnce ? 50 : 8 });
      const correlated = await correlatePending(db, log, { maxBatches: runOnce ? 50 : 8 });

      if (enriched.processed > 0 || correlated.processed > 0) {
        await detectAnomalies(db, log);
      }
      await ageEvents(db, log);

      log.info(
        {
          collected: due.length,
          enriched: enriched.processed,
          correlated: correlated.processed,
          eventsCreated: correlated.eventsCreated,
          ms: Date.now() - cycleStarted,
        },
        'cycle complete',
      );

      if (runOnce) break;

      try {
        await sleep(TICK_SECONDS * 1000, controller.signal);
      } catch {
        // Abort during sleep is the normal shutdown path.
        break;
      }
      // The loop condition is the shutdown signal, so `--once` and a SIGTERM
      // during the cycle both exit through it rather than via a bare `true`.
    } while (!controller.signal.aborted);
  } catch (error) {
    log.error(
      { err: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
      'fatal error in ingest loop',
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase(db);
    log.info('ingest worker stopped');
  }
}

void main();
