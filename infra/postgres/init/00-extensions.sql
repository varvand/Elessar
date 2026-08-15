-- Runs once, on first cluster init. Drizzle migrations assume these exist.
CREATE EXTENSION IF NOT EXISTS vector;   -- embedding storage + HNSW ANN search
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- fuzzy entity-name matching
CREATE EXTENSION IF NOT EXISTS btree_gin;
