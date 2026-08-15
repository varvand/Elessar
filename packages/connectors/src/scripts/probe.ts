/**
 * Smoke-test every connector against live upstream data and print what came
 * back, so parser bugs surface as wrong values rather than as an empty globe.
 */
import { createHttpClient, resolveAvailableConnectors } from '@elessar/connectors';
import { createLogger } from '@elessar/core';

const log = createLogger({ module: 'probe' });

async function main() {
  const { available, skipped } = resolveAvailableConnectors();
  console.error(`\n=== ${available.length} available, ${skipped.length} skipped ===`);
  for (const s of skipped) console.error(`  SKIP ${s.id}: ${s.reason}`);

  for (const connector of available) {
    const http = createHttpClient({
      minRequestIntervalMs: connector.minRequestIntervalMs,
      log,
    });
    const controller = new AbortController();
    const started = Date.now();

    try {
      const result = await connector.fetch({
        cursor: null,
        http,
        signal: controller.signal,
        log: log.child({ source: connector.id }),
      });

      const ms = Date.now() - started;
      const obs = result.observations;
      const located = obs.filter((o) => o.geo != null).length;
      const categories = new Map<string, number>();
      for (const o of obs) categories.set(o.category ?? 'null', (categories.get(o.category ?? 'null') ?? 0) + 1);

      console.error(`\n--- ${connector.id} (${ms}ms) ---`);
      console.error(`  observations: ${obs.length}  located: ${located}`);
      console.error(`  categories: ${[...categories.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);

      const sample = obs[0];
      if (sample) {
        console.error(`  sample.title     : ${sample.title.slice(0, 110)}`);
        console.error(`  sample.externalId: ${sample.externalId}`);
        console.error(`  sample.occurredAt: ${sample.occurredAt instanceof Date ? sample.occurredAt.toISOString() : sample.occurredAt}`);
        console.error(`  sample.geo       : ${sample.geo ? `${sample.geo.point.lat.toFixed(3)},${sample.geo.point.lon.toFixed(3)} [${sample.geo.precision}] ${sample.geo.placeName ?? ''} ${sample.geo.countryCode ?? ''}` : 'null'}`);
        console.error(`  sample.magnitude : ${sample.magnitude}  tone: ${sample.tone}  reports: ${sample.reportCount}`);
        console.error(`  sample.actors    : ${JSON.stringify(sample.actors)}`);
        console.error(`  sample.url       : ${(sample.url ?? '').slice(0, 90)}`);
        console.error(`  sample.body      : ${(sample.body ?? '').slice(0, 160)}`);
      }

      // Invariant checks that would otherwise fail silently downstream.
      const problems: string[] = [];
      if (obs.some((o) => !o.externalId)) problems.push('missing externalId');
      if (obs.some((o) => !o.title)) problems.push('missing title');
      if (obs.some((o) => !(o.occurredAt instanceof Date) || Number.isNaN((o.occurredAt as Date).getTime())))
        problems.push('invalid occurredAt');
      if (obs.some((o) => o.geo && (Math.abs(o.geo.point.lat) > 90 || Math.abs(o.geo.point.lon) > 180)))
        problems.push('out-of-range coordinates');
      const ids = new Set(obs.map((o) => o.externalId));
      if (ids.size !== obs.length) problems.push(`duplicate externalIds (${obs.length - ids.size})`);
      console.error(problems.length ? `  !! PROBLEMS: ${problems.join('; ')}` : '  OK');
    } catch (error) {
      console.error(`\n--- ${connector.id} FAILED ---`);
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

void main();
