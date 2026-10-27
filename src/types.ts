export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  AI: AiBinding;
  BLOG_FEED_URL: string;
  BLOG_BASE_URL: string;
  EMBEDDING_MODEL?: string;
  MAX_ARTICLES_PER_REQUEST?: string;
  FEED_PAGE_SIZE?: string;
  INGEST_CONCURRENCY?: string;
  REQUEST_DELAY_MS?: string;
  CHUNK_SIZE_CHARS?: string;
  CHUNK_OVERLAP_CHARS?: string;
  SEARCH_MAX_RESULTS?: string;
  INGEST_TOKEN?: string;
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  QDRANT_COLLECTION?: string;
}

export type SearchMode = "hybrid" | "keyword" | "semantic";

export interface ArticleRow {
  id: string;
  source_id: string;
  canonical_url: string;
  title: string;
  published_at: string | null;
  updated_at: string | null;
  tags_json: string;
  full_text: string;
  content_hash: string;
  fetched_at: string;
  status: string;
}

export interface ArticleSummary {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  tags: string[];
  excerpt: string;
  score?: number;
}

export interface FeedEntry {
  url: string;
  title: string;
  publishedAt: string | null;
  updatedAt: string | null;
  tags: string[];
  content?: string;
}

export interface FeedCursor {
  url: string;
  offset: number;
}

export type IngestArticleStatus = "inserted" | "updated" | "unchanged" | "failed";

export interface IngestArticleLog {
  title: string;
  url: string;
  status: IngestArticleStatus;
  error?: string;
}

export interface IngestProgress {
  locked: boolean;
  lockExpiresAt: string | null;
  remainingLockSeconds: number;
  current: { startedAt: string; phase?: string; articles: Array<{ title: string; url: string }> } | null;
}

export interface IngestResult {
  done: boolean;
  mode: "backfill" | "incremental";
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  retrying: number;
  errors: string[];
  articles: IngestArticleLog[];
}
