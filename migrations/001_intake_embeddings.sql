-- Semantic search over intake notes (pgvector). Same SQL runs on Azure Database for PostgreSQL with pgvector.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE intake_notes ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Cosine distance (<=>), to match the similar-notes query. Rows with a NULL embedding are not indexed.
-- ivfflat learns its centroids from the rows present when the index is built, so `npm run backfill`
-- rebuilds it (REINDEX) after filling the embeddings.
CREATE INDEX IF NOT EXISTS intake_notes_embedding_idx
  ON intake_notes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
