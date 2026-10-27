-- Speed up recent read-only lists and exclude unpublished posts.
CREATE INDEX IF NOT EXISTS idx_articles_recent_published
  ON articles (COALESCE(published_at, updated_at, fetched_at) DESC, id DESC)
  WHERE status = 'published';
