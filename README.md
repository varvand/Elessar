# Elessar

<img width="3600" height="2338" alt="main" src="https://github.com/user-attachments/assets/b9d69384-7b4d-4480-9460-2bb5a6623768" />

Elessar is an open source situational awareness platform. It collects reports
from public event and news feeds, enriches them with local machine learning, and
presents the results on a live global dashboard.

The project is designed to turn a large stream of individual reports into a
smaller set of useful events. Reports about the same earthquake, fire, storm, or
conflict are correlated into one event while preserving links to the original
sources.

Elessar does not require a paid service. Most data sources work without an API
key, and the embedding and classification pipeline runs locally.

## What Elessar does

- Collects events and news from public feeds
- Geolocates reports and records the precision of each location
- Classifies reports into operational categories
- Correlates related reports into shared events
- Scores severity and confidence independently
- Detects unusual activity against regional baselines
- Shows events on a globe alongside a feed, timeline, alerts, and source health
- Preserves the observations behind each event for traceability

## How it works

Data moves through five stages:

1. Connectors fetch and normalize reports from external sources.
2. The ingest worker geolocates, classifies, embeds, and scores each report.
3. Related observations are correlated into events.
4. Regional baselines are used to detect unusual activity.
5. The Next.js application reads the processed data and refreshes the dashboard.

PostgreSQL stores both the original observations and the derived events. The
machine learning models run through ONNX on the local machine. See
[ARCHITECTURE.md](ARCHITECTURE.md) for a detailed explanation of the pipeline,
data model, and design decisions.

## Requirements

Install these tools before starting:

- Node.js 22 or newer
- pnpm 10 or newer
- Docker with Docker Compose
- Git

The first ingest downloads a local embedding model of about 90 MB. The gazetteer
setup downloads about 3 MB of place data.

## Run Elessar locally

### 1. Clone the repository


```bash
git clone git@github.com:varvand/Elessar.git
cd Elessar
```

### 2. Install dependencies

If pnpm is not already available, Corepack can install the version declared by
the project.

```bash
corepack enable
pnpm install
```

### 3. Create the local configuration

```bash
cp .env.example .env
```

Open `.env` and update `ELESSAR_USER_AGENT` with a real contact address. Several
public APIs ask clients to identify themselves and may reject generic user
agents. The local `.env` file is ignored by Git.

The default database settings match the included Docker Compose service, so no
other configuration is required for a standard local setup.

### 4. Start PostgreSQL

```bash
pnpm infra:up
```

This starts PostgreSQL 17 with pgvector and exposes it on local port 5433.

### 5. Prepare the database and local data

```bash
pnpm db:migrate
pnpm db:seed-gazetteer
```

### 6. Run the first ingest

```bash
pnpm ingest:once
```

The first run takes longer because it downloads the embedding model and processes
the initial batch of observations. Later runs reuse the cached model.

### 7. Start the dashboard

```bash
pnpm web
```

Open [http://localhost:3210](http://localhost:3210) in a browser.

To keep collecting new reports, open another terminal and run:

```bash
pnpm ingest
```

## Faster setup

After creating `.env`, the bootstrap command installs dependencies, starts the
database, applies migrations, downloads the gazetteer, and performs one ingest
cycle.

```bash
pnpm bootstrap
pnpm web
```

Run `pnpm ingest` in another terminal if you want continuous updates.

## Configuration

| Variable               | Required    | Purpose                                      |
| ---------------------- | ----------- | -------------------------------------------- |
| `DATABASE_URL`         | Yes         | PostgreSQL connection string                 |
| `ELESSAR_LOG_LEVEL`    | No          | Logging level from `trace` through `error`   |
| `ELESSAR_USER_AGENT`   | Recommended | Identifies requests to public data providers |
| `ELESSAR_MODEL_CACHE`  | No          | Directory used for downloaded ONNX models    |
| `FIRMS_MAP_KEY`        | No          | Enables NASA FIRMS active fire data          |
| `RELIEFWEB_APPNAME`    | No          | Identifies requests made to ReliefWeb        |
| `NEXT_PUBLIC_APP_NAME` | No          | Name displayed by the web application        |

Keep real keys and credentials in `.env`. Do not add secrets to `.env.example` or
to variables whose names begin with `NEXT_PUBLIC_`.

## Common commands

| Command                  | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `pnpm web`               | Start the dashboard on port 3210                     |
| `pnpm ingest`            | Run the ingest worker continuously                   |
| `pnpm ingest:once`       | Run one ingest cycle and exit                        |
| `pnpm dev`               | Start workspace development tasks through Turborepo  |
| `pnpm test`              | Run the test suite                                   |
| `pnpm typecheck`         | Type-check every workspace package                   |
| `pnpm lint`              | Run ESLint                                           |
| `pnpm format:check`      | Check formatting without changing files              |
| `pnpm format`            | Format the repository with Prettier                  |
| `pnpm build`             | Create production builds                             |
| `pnpm probe`             | Test connectors against their live upstream feeds    |
| `pnpm infra:up`          | Start PostgreSQL                                     |
| `pnpm infra:down`        | Stop PostgreSQL                                      |
| `pnpm infra:logs`        | Follow PostgreSQL logs                               |
| `pnpm infra:nuke`        | Remove PostgreSQL containers and local database data |
| `pnpm db:migrate`        | Apply database migrations                            |
| `pnpm db:generate`       | Generate a migration after schema changes            |
| `pnpm db:studio`         | Open Drizzle Studio                                  |
| `pnpm db:seed-gazetteer` | Download and prepare GeoNames data                   |

`pnpm infra:nuke` deletes the local database volume. Use it only when you are
comfortable losing the local data.

## Data sources

Elessar currently uses the following public sources:

| Source                                                                 | Data                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [GDELT 2.0](https://www.gdeltproject.org/)                             | Global news events with locations and conflict metadata            |
| [USGS](https://earthquake.usgs.gov/earthquakes/feed/)                  | Significant earthquakes and earthquakes at magnitude 4.5 or higher |
| [GDACS](https://www.gdacs.org/)                                        | Multi-hazard alerts and humanitarian impact estimates              |
| [NASA EONET](https://eonet.gsfc.nasa.gov/)                             | Curated natural events with satellite references                   |
| [NOAA and NWS](https://www.weather.gov/documentation/services-web-api) | Severe weather alerts in the United States                         |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)                    | Active fire detections with a free optional key                    |
| BBC, Al Jazeera, DW, France 24, and UN News                            | International reporting through RSS feeds                          |
| [GeoNames](https://www.geonames.org/)                                  | Place names and country reference data                             |

Source attribution remains visible in the dashboard. Data from each provider
continues to be governed by that provider's license and terms.

## Repository structure

```text
apps/
  ingest/       Worker and pipeline stages
  web/          Next.js dashboard and API routes
packages/
  connectors/   External source integrations and shared HTTP code
  core/         Domain types, taxonomy, scoring, and geographic helpers
  db/           Drizzle schema, migrations, and database queries
  ml/           Geocoding, embeddings, classification, and correlation
infra/          Docker Compose and PostgreSQL initialization
docs/           Design notes and supporting documentation
```

## Contributing

Contributions are welcome. Small fixes, new connectors, tests, documentation,
and improvements to the data pipeline are all useful.

Before making a large change, read [ARCHITECTURE.md](ARCHITECTURE.md). The project
keeps original observations as an audit trail and treats derived state as
rebuildable. Changes that cross package boundaries should preserve those ideas.

### Contribution workflow

1. Fork the repository and create a focused branch.
2. Make the smallest change that fully solves the problem.
3. Add or update tests for behavior that can regress.
4. Update documentation when commands, configuration, or behavior change.
5. Run the local checks.
6. Open a pull request that explains the problem and the reasoning behind the
   solution.

Run these checks before submitting a pull request:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Connector changes should also be checked against live upstream data:

```bash
pnpm probe
```

Live feeds can be unreliable, so mention any upstream failure in the pull request
instead of hiding it or weakening a test.

### Adding a data source

Each connector exports a `SourceDefinition` and is registered in
`packages/connectors/src/index.ts`. A connector should only fetch and normalize
data. Geocoding, classification, embedding, correlation, and scoring belong in
the shared pipeline.

When adding a connector:

- Use the shared HTTP client for rate limiting, retries, and conditional requests
- Respect the provider's terms, attribution requirements, and request limits
- Give the source a stable identifier
- Return normalized observations with useful prose titles
- Add parser tests with local fixtures
- Never make the automated test suite depend on a live network request
- Add optional credentials to `.env.example` with an empty value
- Register the connector in `ALL_CONNECTORS`

### Pull request guidelines

A good pull request is easy to understand and verify. Include:

- A short explanation of the user or operator problem
- A description of the chosen solution
- The checks you ran
- Screenshots for visible interface changes
- Notes about migrations, new configuration, or source attribution

Keep unrelated cleanup in a separate pull request. Do not commit `.env`, API keys,
downloaded models, gazetteer data, logs, or generated build output.

## Troubleshooting

### The dashboard has no events

Confirm that PostgreSQL is running and that at least one ingest cycle completed.

```bash
pnpm infra:logs
pnpm ingest:once
```

### Port 5433 is already in use

Stop the service using that port or update both `DATABASE_URL` and the port mapping
in `infra/docker-compose.yml`.

### A connector is being rejected

Check that `ELESSAR_USER_AGENT` contains a real contact address. For NASA FIRMS,
also confirm that `FIRMS_MAP_KEY` is configured.

### The first ingest appears slow

The initial run downloads the embedding model and processes the first group of
observations. Check the worker output for progress before stopping it.

## Project status

Elessar is functional but still under active development. It is currently aimed
at local use and experimentation. Authentication, a retention policy for raw
observations, and a user interface for the entity graph are not yet implemented.

## License

The project is licensed under Apache 2.0. Source data remains under the terms of
its original provider.
