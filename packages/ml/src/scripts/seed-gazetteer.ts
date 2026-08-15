/**
 * Downloads the GeoNames gazetteer used for offline geocoding.
 *
 * Two files, ~3.3 MB total, fetched once:
 *   cities15000.txt  — 34k populated places of 15,000+ inhabitants
 *   countryInfo.txt  — country names plus the authoritative FIPS→ISO crosswalk
 *
 * GeoNames is CC BY 4.0. Attribution is surfaced in the dashboard's sources
 * panel; keep it there if you fork this.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { unzipSync } from 'fflate';
import { createLogger, loadEnv } from '@elessar/core';
import { gazetteerFiles } from '../gazetteer';

const log = createLogger({ module: 'seed-gazetteer' });

const CITIES_ZIP = 'https://download.geonames.org/export/dump/cities15000.zip';
const COUNTRY_INFO = 'https://download.geonames.org/export/dump/countryInfo.txt';

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.size > 0;
  } catch {
    return false;
  }
}

async function fetchWithUserAgent(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { 'user-agent': loadEnv().ELESSAR_USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} → HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function main(): Promise<void> {
  const files = gazetteerFiles();
  const force = process.argv.includes('--force');

  await mkdir(dirname(files.cities), { recursive: true });

  if (!force && (await exists(files.cities)) && (await exists(files.countries))) {
    log.info({ dir: dirname(files.cities) }, 'gazetteer already present (use --force to refresh)');
    return;
  }

  log.info({ url: CITIES_ZIP }, 'downloading cities15000');
  const zipped = await fetchWithUserAgent(CITIES_ZIP);
  const archive = unzipSync(zipped);

  const member = Object.keys(archive).find((name) => name.endsWith('cities15000.txt'));
  if (!member) {
    throw new Error('cities15000.txt not found inside the downloaded archive');
  }
  await writeFile(files.cities, archive[member]!);

  log.info({ url: COUNTRY_INFO }, 'downloading countryInfo');
  await writeFile(files.countries, await fetchWithUserAgent(COUNTRY_INFO));

  // Prove the files are usable now rather than failing on the first ingest run.
  const { loadGazetteer, gazetteerStats, fipsToIso2, findPlaceByName } = await import('../gazetteer');
  await loadGazetteer();
  const stats = gazetteerStats();

  // FIPS SG is Senegal while ISO SG is Singapore — if this resolves correctly
  // the crosswalk is wired up right, which is the whole reason we load this file.
  const senegal = fipsToIso2('SG');
  const kyiv = findPlaceByName('Kyiv');

  log.info(
    {
      ...stats,
      dir: dirname(files.cities),
      checkFipsSG: senegal,
      checkKyiv: kyiv ? `${kyiv.name} ${kyiv.countryCode}` : null,
    },
    'gazetteer ready',
  );

  if (senegal !== 'SN') {
    log.warn({ got: senegal }, 'FIPS crosswalk sanity check failed — expected SN for FIPS SG');
  }
}

main().catch((error: unknown) => {
  log.error({ err: error instanceof Error ? error.message : String(error) }, 'seed failed');
  process.exitCode = 1;
});

export { main, CITIES_ZIP, COUNTRY_INFO, resolve };
