CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"dedup_key" text NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"category" text,
	"grid_cell" text,
	"country_code" text,
	"place_name" text,
	"lat" double precision,
	"lon" double precision,
	"z_score" real,
	"observed" integer,
	"expected" real,
	"severity" smallint DEFAULT 0 NOT NULL,
	"event_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baselines" (
	"category" text NOT NULL,
	"grid_cell" text NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"mean" real DEFAULT 0 NOT NULL,
	"m2" real DEFAULT 0 NOT NULL,
	"last_bucket_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baselines_category_grid_cell_pk" PRIMARY KEY("category","grid_cell")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'unknown' NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_edges" (
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"co_occurrences" integer DEFAULT 0 NOT NULL,
	"pmi" real DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_edges_source_entity_id_target_entity_id_pk" PRIMARY KEY("source_entity_id","target_entity_id")
);
--> statement-breakpoint
CREATE TABLE "event_observations" (
	"event_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"similarity" real DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_observations_event_id_observation_id_pk" PRIMARY KEY("event_id","observation_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"category" text DEFAULT 'other' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"severity" smallint DEFAULT 0 NOT NULL,
	"confidence" smallint DEFAULT 0 NOT NULL,
	"velocity" real DEFAULT 0 NOT NULL,
	"lat" double precision,
	"lon" double precision,
	"geo_precision" text DEFAULT 'unknown' NOT NULL,
	"place_name" text,
	"country_code" text,
	"grid_cell" text,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"centroid" vector(384)
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"fetched" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "observation_entities" (
	"observation_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"mentions" integer DEFAULT 1 NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	CONSTRAINT "observation_entities_observation_id_entity_id_pk" PRIMARY KEY("observation_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision,
	"lon" double precision,
	"geo_precision" text DEFAULT 'unknown' NOT NULL,
	"place_name" text,
	"country_code" text,
	"admin1" text,
	"grid_cell" text,
	"category" text DEFAULT 'other' NOT NULL,
	"category_confidence" real DEFAULT 0 NOT NULL,
	"severity" smallint DEFAULT 0 NOT NULL,
	"confidence" smallint DEFAULT 0 NOT NULL,
	"magnitude" double precision,
	"tone" real,
	"report_count" integer,
	"embedding" vector(384),
	"raw" jsonb,
	"pipeline_stage" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"homepage" text NOT NULL,
	"license" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor" jsonb,
	"etag" text,
	"last_modified" text,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"observations_ingested" integer DEFAULT 0 NOT NULL,
	"last_run_duration_ms" integer,
	"last_run_observations" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_observations" ADD CONSTRAINT "event_observations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_observations" ADD CONSTRAINT "event_observations_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_entities" ADD CONSTRAINT "observation_entities_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_entities" ADD CONSTRAINT "observation_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_created_idx" ON "alerts" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alerts_open_idx" ON "alerts" USING btree ("acknowledged_at","severity" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedup_idx" ON "alerts" USING btree ("dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_key_kind_idx" ON "entities" USING btree ("key","kind");--> statement-breakpoint
CREATE INDEX "entities_mentions_idx" ON "entities" USING btree ("mention_count" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entities_name_trgm_idx" ON "entities" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "entity_edges_weight_idx" ON "entity_edges" USING btree ("co_occurrences" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entity_edges_pmi_idx" ON "entity_edges" USING btree ("pmi" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entity_edges_target_idx" ON "entity_edges" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX "event_observations_observation_idx" ON "event_observations" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "event_observations_event_added_idx" ON "event_observations" USING btree ("event_id","added_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_severity_idx" ON "events" USING btree ("severity" DESC NULLS LAST,"last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_last_seen_idx" ON "events" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_category_idx" ON "events" USING btree ("category","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status","severity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_country_idx" ON "events" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "events_geo_idx" ON "events" USING btree ("lat","lon");--> statement-breakpoint
CREATE INDEX "events_centroid_idx" ON "events" USING hnsw ("centroid" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "ingest_runs_source_started_idx" ON "ingest_runs" USING btree ("source_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observation_entities_entity_idx" ON "observation_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "observations_source_external_idx" ON "observations" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "observations_content_hash_idx" ON "observations" USING btree ("source_id","content_hash");--> statement-breakpoint
CREATE INDEX "observations_occurred_at_idx" ON "observations" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observations_stage_idx" ON "observations" USING btree ("pipeline_stage","ingested_at");--> statement-breakpoint
CREATE INDEX "observations_category_idx" ON "observations" USING btree ("category","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observations_country_idx" ON "observations" USING btree ("country_code","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observations_grid_idx" ON "observations" USING btree ("grid_cell","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observations_embedding_idx" ON "observations" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "observations_title_trgm_idx" ON "observations" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "sources_enabled_idx" ON "sources" USING btree ("enabled");