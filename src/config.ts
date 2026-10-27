import type { Env } from "./types";

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getConfig(env: Env) {
  const chunkSizeChars = boundedInteger(env.CHUNK_SIZE_CHARS, 900, 200, 3000);
  return {
    feedUrl: env.BLOG_FEED_URL || "http://fetchrss.com/rss/5ff67856db94f676db0c0fc262239753566b5039276f8e22.xml",
    blogBaseUrl: env.BLOG_BASE_URL || "https://www.facebook.com/pulipuli.blogspot",
    embeddingModel: env.EMBEDDING_MODEL || "@cf/baai/bge-m3",
    maxArticlesPerRequest: boundedInteger(env.MAX_ARTICLES_PER_REQUEST, 1, 1, 25),
    feedPageSize: boundedInteger(env.FEED_PAGE_SIZE, 100, 10, 100),
    concurrency: boundedInteger(env.INGEST_CONCURRENCY, 1, 1, 4),
    requestDelayMs: boundedInteger(env.REQUEST_DELAY_MS, 1_000, 0, 5_000),
    chunkSizeChars,
    chunkOverlapChars: Math.min(chunkSizeChars - 1, boundedInteger(env.CHUNK_OVERLAP_CHARS, 150, 0, 500)),
    maxSearchResults: boundedInteger(env.SEARCH_MAX_RESULTS, 20, 1, 50),
    maxFullTextChars: 100_000,
    maxHtmlChars: 2_000_000,
    embeddingBatchSize: 16,
    semanticCandidateLimit: 60,
  };
}

export function feedUrlWithPagination(feedUrl: string, pageSize: number, startIndex = 1): string {
  const url = new URL(feedUrl);
  if (!/blogspot|blogger/i.test(url.hostname)) return url.toString();
  if (!url.searchParams.has("max-results")) url.searchParams.set("max-results", String(pageSize));
  if (!url.searchParams.has("start-index")) url.searchParams.set("start-index", String(startIndex));
  else if (startIndex > 1) url.searchParams.set("start-index", String(startIndex));
  return url.toString();
}

export function nextStartIndexUrl(currentUrl: string, pageSize: number): string {
  const url = new URL(currentUrl);
  const current = Number.parseInt(url.searchParams.get("start-index") ?? "1", 10);
  url.searchParams.set("max-results", String(pageSize));
  url.searchParams.set("start-index", String((Number.isFinite(current) ? current : 1) + pageSize));
  return url.toString();
}
