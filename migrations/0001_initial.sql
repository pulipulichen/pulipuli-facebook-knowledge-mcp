CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  full_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'unavailable', 'blocked'))
);

CREATE INDEX IF NOT EXISTS idx_articles_published_at
  ON articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source_id
  ON articles (source_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
  UNIQUE (article_id, ordinal, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_chunks_article_id
  ON chunks (article_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  mode TEXT NOT NULL CHECK (mode IN ('backfill', 'incremental')),
  scanned INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_lock (id, token, expires_at) VALUES (1, NULL, 0);

CREATE TABLE IF NOT EXISTS failed_articles (
  canonical_url TEXT PRIMARY KEY,
  entry_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_failed_articles_retry
  ON failed_articles (next_retry_at);
