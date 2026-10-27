import { fetchArticleText, canonicalizeUrl } from "./article";
import { maxRowsPerD1Insert } from "./d1-limits";
import { getConfig, feedUrlWithPagination, nextStartIndexUrl } from "./config";
import { fetchFeedPage } from "./feed";
import { acquireIngestLease, type IngestLease } from "./ingest-lock";
import { HttpError, normalizeText, sha256Hex, sleep, splitIntoChunks, stableUuid } from "./http";
import { deletePoints, embedTexts, ensureCollection, makeVectorId, upsertPoints, type VectorPoint } from "./qdrant";
import type { ArticleRow, Env, FeedCursor, FeedEntry, IngestArticleLog, IngestProgress, IngestResult } from "./types";

interface IngestCounters {
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  retrying: number;
  errors: string[];
  articles: IngestArticleLog[];
}

async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

function stateStatement(env: Env, key: string, value: string): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, value, new Date().toISOString());
}

async function setState(env: Env, key: string, value: string): Promise<void> {
  await stateStatement(env, key, value).run();
}

/** Progress is advisory: Workers can terminate before the last heartbeat is cleared. */
export async function getIngestStatus(env: Env): Promise<IngestProgress> {
  const [lock, active] = await Promise.all([
    env.DB.prepare("SELECT token, expires_at FROM sync_lock WHERE id = 1")
      .first<{ token: string | null; expires_at: number }>(),
    env.DB.prepare("SELECT value FROM sync_state WHERE key = ?")
      .bind("ingest_active_articles")
      .first<{ value: string }>(),
  ]);
  const now = Math.floor(Date.now() / 1_000);
  const locked = Boolean(lock?.token) && (lock?.expires_at ?? 0) > now;
  let current: IngestProgress["current"] = null;
  if (locked && active?.value) {
    try {
      const parsed = JSON.parse(active.value) as (NonNullable<IngestProgress["current"]> & { token?: string }) | null;
      if (parsed && (!parsed.token || parsed.token === lock?.token) && typeof parsed.startedAt === "string" && Array.isArray(parsed.articles)) {
        current = {
          startedAt: parsed.startedAt,
          articles: parsed.articles.filter((item) => typeof item?.title === "string" && typeof item?.url === "string"),
          ...(typeof parsed.phase === "string" ? { phase: parsed.phase } : {}),
        };
      }
    } catch {
      // Treat a missing or corrupt progress heartbeat as unavailable.
    }
  }
  const remainingLockSeconds = locked ? Math.max(0, (lock?.expires_at ?? now) - now) : 0;
  return {
    locked,
    lockExpiresAt: locked ? new Date((lock?.expires_at ?? now) * 1_000).toISOString() : null,
    remainingLockSeconds,
    current,
  };
}

async function saveFailure(env: Env, entry: FeedEntry, error: unknown): Promise<void> {
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(entry.url, env.BLOG_BASE_URL);
  } catch {
    return;
  }
  const current = await env.DB.prepare("SELECT attempts FROM failed_articles WHERE canonical_url = ?")
    .bind(canonicalUrl)
    .first<{ attempts: number }>();
  const attempts = (current?.attempts ?? 0) + 1;
  const retrySeconds = Math.min(86_400, 60 * 2 ** Math.min(attempts, 10));
  const message = error instanceof Error ? error.message : "Unknown ingestion error";
  await env.DB.prepare(`
    INSERT INTO failed_articles (canonical_url, entry_json, attempts, next_retry_at, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_url) DO UPDATE SET
      entry_json = excluded.entry_json,
      attempts = excluded.attempts,
      next_retry_at = excluded.next_retry_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).bind(
    canonicalUrl,
    JSON.stringify(entry),
    attempts,
    Math.floor(Date.now() / 1_000) + retrySeconds,
    message.slice(0, 300),
    new Date().toISOString(),
  ).run();
}

async function clearFailure(env: Env, canonicalUrl: string): Promise<void> {
  await env.DB.prepare("DELETE FROM failed_articles WHERE canonical_url = ?").bind(canonicalUrl).run();
}

async function embedChunks(env: Env, articleId: string, contentHash: string, chunks: string[]): Promise<VectorPoint[]> {
  const config = getConfig(env);
  const points: VectorPoint[] = [];
  let vectorSize = 0;
  for (let start = 0; start < chunks.length; start += config.embeddingBatchSize) {
    const batch = chunks.slice(start, start + config.embeddingBatchSize);
    const vectors = await embedTexts(env, batch);
    for (let offset = 0; offset < vectors.length; offset += 1) {
      const vector = vectors[offset]!;
      if (vectorSize && vector.length !== vectorSize) throw new Error("Workers AI returned embeddings with inconsistent dimensions");
      vectorSize = vector.length;
      const ordinal = start + offset;
      points.push({
        id: await makeVectorId(articleId, contentHash, ordinal, config.embeddingModel),
        vector,
        payload: { articleId, contentHash, embeddingModel: config.embeddingModel, ordinal },
      });
    }
  }
  if (points.length === 0 || vectorSize === 0) throw new Error("No embeddings were generated for this article");
  await ensureCollection(env, vectorSize);
  return points;
}

type ArticleReader = (url: string, entry: FeedEntry, env: Env) => Promise<string>;

async function indexEntry(env: Env, entry: FeedEntry, lease: IngestLease, readArticle: ArticleReader): Promise<"inserted" | "updated" | "unchanged"> {
  const config = getConfig(env);
  const canonicalUrl = canonicalizeUrl(entry.url, config.blogBaseUrl);
  const canonicalOrigin = new URL(canonicalUrl).origin;
  if (canonicalOrigin !== new URL(config.blogBaseUrl).origin) {
    throw new Error("Feed article URL is outside the configured blog origin");
  }

  const articleId = await stableUuid(`article:${canonicalUrl}`);
  const fullText = normalizeText(await readArticle(canonicalUrl, entry, env)).slice(0, config.maxFullTextChars);
  const title = normalizeText(entry.title).slice(0, 500) || canonicalUrl;
  const tagsJson = JSON.stringify([...new Set(entry.tags.map((tag) => normalizeText(tag)).filter(Boolean))].slice(0, 30));
  const contentHash = await sha256Hex(`${title}\n${entry.publishedAt ?? ""}\n${tagsJson}\n${fullText}`);
  const fetchedAt = new Date().toISOString();

  const existing = await env.DB.prepare("SELECT * FROM articles WHERE canonical_url = ?")
    .bind(canonicalUrl)
    .first<ArticleRow>();
  const indexedModel = existing
    ? await env.DB.prepare("SELECT embedding_model FROM chunks WHERE article_id = ? LIMIT 1")
      .bind(articleId)
      .first<{ embedding_model: string }>()
    : null;
  if (existing?.content_hash === contentHash && indexedModel?.embedding_model === config.embeddingModel) {
    await lease.assertOwned();
    await env.DB.prepare("UPDATE articles SET fetched_at = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?")
      .bind(fetchedAt, entry.updatedAt, existing.id)
      .run();
    await clearFailure(env, canonicalUrl);
    return "unchanged";
  }

  const chunks = splitIntoChunks(fullText, config.chunkSizeChars, config.chunkOverlapChars);
  if (chunks.length === 0) throw new Error("Article has no indexable text");
  await lease.assertOwned();
  const points = await embedChunks(env, articleId, contentHash, chunks);
  const oldChunkRows = existing
    ? await env.DB.prepare("SELECT vector_id FROM chunks WHERE article_id = ?").bind(articleId).all<{ vector_id: string }>()
    : { results: [] as Array<{ vector_id: string }> };
  const oldVectorIds = (oldChunkRows.results ?? []).map((row) => row.vector_id);
  const newChunkRows = await Promise.all(chunks.map(async (text, ordinal) => ({
    id: await stableUuid(`chunk:${articleId}:${contentHash}:${ordinal}`),
    articleId,
    ordinal,
    text,
    vectorId: points[ordinal]!.id,
  })));

  await lease.assertOwned();
  try {
    await upsertPoints(env, points);
  } catch (error) {
    await lease.assertOwned();
    await deletePoints(env, points.map((point) => point.id)).catch(() => undefined);
    throw error;
  }

  const articleStatement = env.DB.prepare(`
    INSERT INTO articles (
      id, source_id, canonical_url, title, published_at, updated_at,
      tags_json, full_text, content_hash, fetched_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')
    ON CONFLICT(canonical_url) DO UPDATE SET
      title = excluded.title,
      published_at = excluded.published_at,
      updated_at = excluded.updated_at,
      tags_json = excluded.tags_json,
      full_text = excluded.full_text,
      content_hash = excluded.content_hash,
      fetched_at = excluded.fetched_at,
      status = 'published'
  `).bind(
    articleId,
    "pulipuli-blog",
    canonicalUrl,
    title,
    entry.publishedAt,
    entry.updatedAt,
    tagsJson,
    fullText,
    contentHash,
    fetchedAt,
  );
  const chunkStatements: D1PreparedStatement[] = [];
  // Eight bound values per chunk; D1 permits at most 100 per statement.
  // Batch multiple small INSERTs transactionally instead of one oversized INSERT.
  const rowsPerInsert = maxRowsPerD1Insert(8);
  for (let start = 0; start < newChunkRows.length; start += rowsPerInsert) {
    const batch = newChunkRows.slice(start, start + rowsPerInsert);
    const values: Array<string | number> = [];
    const placeholders = batch.map((chunk) => {
      values.push(chunk.id, chunk.articleId, chunk.ordinal, chunk.text, contentHash, config.embeddingModel, chunk.vectorId, fetchedAt);
      return "(?, ?, ?, ?, ?, ?, ?, ?)";
    });
    chunkStatements.push(env.DB.prepare(`
      INSERT INTO chunks (id, article_id, ordinal, text, content_hash, embedding_model, vector_id, created_at)
      VALUES ${placeholders.join(", ")}
    `).bind(...values));
  }
  const statements = [
    articleStatement,
    env.DB.prepare("DELETE FROM chunks WHERE article_id = ?").bind(articleId),
    ...chunkStatements,
  ];

  // Renew immediately before committing article data, so a request that lost
  // ownership while waiting for AI/Qdrant cannot overwrite its replacement.
  await lease.assertOwned();
  try {
    await env.DB.batch(statements);
  } catch (error) {
    await lease.assertOwned();
    await deletePoints(env, points.map((point) => point.id)).catch(() => undefined);
    throw error;
  }

  await lease.assertOwned();
  await deletePoints(env, oldVectorIds).catch(() => undefined);
  await clearFailure(env, canonicalUrl);
  return existing ? "updated" : "inserted";
}

function parseCursor(value: string | null): FeedCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<FeedCursor>;
    if (typeof parsed.url === "string" && Number.isInteger(parsed.offset) && (parsed.offset ?? -1) >= 0) {
      return { url: parsed.url, offset: parsed.offset! };
    }
  } catch {
    // A corrupt checkpoint starts from the feed root again; URL upserts remain idempotent.
  }
  return null;
}

async function recordRun(
  env: Env,
  id: string,
  mode: "backfill" | "incremental",
  counters: IngestCounters,
  status: "succeeded" | "partial" | "failed",
  errorSummary: string | null = null,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE sync_runs SET finished_at = ?, status = ?, scanned = ?, inserted = ?, updated = ?,
      unchanged = ?, failed = ?, error_summary = ? WHERE id = ?
  `).bind(
    new Date().toISOString(),
    status,
    counters.scanned,
    counters.inserted,
    counters.updated,
    counters.unchanged,
    counters.failed,
    errorSummary,
    id,
  ).run();
}

async function processEntrySafely(env: Env, entry: FeedEntry, counters: IngestCounters, lease: IngestLease, readArticle: ArticleReader): Promise<void> {
  const article = { title: entry.title, url: entry.url };
  try {
    const status = await indexEntry(env, entry, lease, readArticle);
    counters[status] += 1;
    counters.articles.push({ ...article, status });
  } catch (error) {
    // A lost lease is a batch failure, not a failed article to checkpoint past.
    await lease.assertOwned();
    counters.failed += 1;
    const message = error instanceof Error ? error.message : "Unknown ingestion error";
    if (counters.errors.length < 5) counters.errors.push(`${entry.title.slice(0, 80)}: ${message.slice(0, 160)}`);
    counters.articles.push({ ...article, status: "failed", error: message.slice(0, 200) });
    await saveFailure(env, entry, error);
  }
}

export async function runIngest(env: Env, options: { reset?: boolean; readArticle?: ArticleReader } = {}): Promise<IngestResult> {
  if (!env.BLOG_FEED_URL || !env.BLOG_BASE_URL) {
    throw new HttpError(500, "BLOG_FEED_URL and BLOG_BASE_URL must be configured", "missing_blog_config");
  }

  const config = getConfig(env);
  const readArticle = options.readArticle ?? fetchArticleText;
  const lease = await acquireIngestLease(env);
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const counters: IngestCounters = { scanned: 0, inserted: 0, updated: 0, unchanged: 0, failed: 0, retrying: 0, errors: [], articles: [] };
  let mode: "backfill" | "incremental" = "backfill";

  try {
    await setState(env, "ingest_active_articles", JSON.stringify({
      token: lease.token, startedAt, phase: "fetching_feed", articles: [],
    }));
    if (options.reset) {
      await env.DB.batch([
        stateStatement(env, "backfill_complete", "0"),
        stateStatement(env, "ingest_cursor", ""),
        stateStatement(env, "ingest_mode", ""),
      ]);
    }

    const backfillComplete = (await getState(env, "backfill_complete")) === "1";
    const savedMode = await getState(env, "ingest_mode");
    const savedCursor = parseCursor(await getState(env, "ingest_cursor"));
    mode = savedMode === "backfill" || savedMode === "incremental"
      ? savedMode
      : backfillComplete ? "incremental" : "backfill";
    const cursor = savedCursor ?? {
      url: feedUrlWithPagination(config.feedUrl, config.feedPageSize, 1),
      offset: 0,
    };

    await env.DB.prepare(`
      INSERT INTO sync_runs (id, started_at, status, mode) VALUES (?, ?, 'running', ?)
    `).bind(runId, startedAt, mode).run();

    const page = await fetchFeedPage(cursor.url, config.blogBaseUrl);
    await lease.assertOwned();
    const start = Math.min(cursor.offset, page.entries.length);
    const dueFailures = await env.DB.prepare(`
      SELECT entry_json FROM failed_articles WHERE next_retry_at <= ? ORDER BY next_retry_at LIMIT ?
    `).bind(Math.floor(Date.now() / 1_000), config.maxArticlesPerRequest).all<{ entry_json: string }>();
    const retries: FeedEntry[] = [];
    for (const row of dueFailures.results ?? []) {
      try {
        const entry = JSON.parse(row.entry_json) as FeedEntry;
        if (typeof entry?.url === "string" && typeof entry.title === "string" && Array.isArray(entry.tags)) retries.push(entry);
      } catch {
        // Invalid records must not consume the entire per-request article budget.
      }
    }
    // Retries share the article budget. Previously two hidden retries could
    // triple a one-article request's CPU, embedding, and subrequest load.
    const batch = page.entries.slice(start, start + config.maxArticlesPerRequest - retries.length);
    for (let offset = 0; offset < batch.length; offset += config.concurrency) {
      const group = batch.slice(offset, offset + config.concurrency);
      await lease.assertOwned();
      counters.scanned += group.length;
      await setState(env, "ingest_active_articles", JSON.stringify({
        token: lease.token, phase: "indexing_articles",
        startedAt: new Date().toISOString(),
        articles: group.map(({ title, url }) => ({ title, url })),
      }));
      await Promise.all(group.map((entry) => processEntrySafely(env, entry, counters, lease, readArticle)));
      if (config.requestDelayMs > 0 && offset + group.length < batch.length) {
        await sleep(config.requestDelayMs);
      }
    }

    for (const entry of retries) {
      await lease.assertOwned();
      counters.retrying += 1;
      await setState(env, "ingest_active_articles", JSON.stringify({
        token: lease.token, phase: "retrying_article",
        startedAt: new Date().toISOString(),
        articles: [{ title: entry.title, url: entry.url }],
      }));
      await processEntrySafely(env, entry, counters, lease, readArticle);
    }

    const reachedPageEnd = start + batch.length >= page.entries.length;
    let nextCursor: FeedCursor | null = null;
    if (page.entries.length > 0 && !reachedPageEnd) {
      nextCursor = { url: cursor.url, offset: start + batch.length };
    } else if (mode === "backfill" && page.entries.length > 0) {
      const minimumFullPage = Math.min(config.feedPageSize, 25);
      const nextUrl = page.nextUrl ?? (page.entries.length >= minimumFullPage
        ? nextStartIndexUrl(cursor.url, page.entries.length)
        : null);
      if (nextUrl && nextUrl !== cursor.url) nextCursor = { url: nextUrl, offset: 0 };
    }

    const done = nextCursor === null;
    await lease.assertOwned();
    // D1 batch is transactional: a terminated request cannot save a cleared
    // cursor while leaving backfill_complete or ingest_mode at the old value.
    await env.DB.batch([
      stateStatement(env, "ingest_cursor", done ? "" : JSON.stringify(nextCursor)),
      stateStatement(env, "ingest_mode", done ? "" : mode),
      ...(done && mode === "backfill" ? [stateStatement(env, "backfill_complete", "1")] : []),
    ]);

    await recordRun(env, runId, mode, counters, counters.failed > 0 ? "partial" : "succeeded");
    return { ...counters, done, mode };
  } catch (error) {
    const summary = error instanceof Error ? error.message : "Unknown ingestion failure";
    await recordRun(env, runId, mode, counters, "failed", summary.slice(0, 500)).catch(() => undefined);
    throw error;
  } finally {
    await lease.release().catch(() => undefined);
  }
}

