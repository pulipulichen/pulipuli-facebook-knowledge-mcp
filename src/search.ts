import { getConfig } from "./config";
import { excerpt } from "./http";
import { embedTexts, searchVectors } from "./qdrant";
import type { ArticleRow, ArticleSummary, Env, SearchMode } from "./types";

interface SearchResponse {
  query: string;
  mode: SearchMode;
  results: ArticleSummary[];
  count: number;
}

function tagsFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

type SummaryRow = Pick<ArticleRow, "id" | "title" | "canonical_url" | "published_at" | "tags_json" | "full_text">;

function toSummary(row: SummaryRow, score?: number): ArticleSummary {
  return {
    id: row.id,
    title: row.title,
    url: row.canonical_url,
    publishedAt: row.published_at,
    tags: tagsFromJson(row.tags_json),
    excerpt: excerpt(row.full_text),
    ...(score === undefined ? {} : { score }),
  };
}

function searchTerms(query: string): string[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  return (terms.length > 1 ? terms : [query.trim()]).slice(0, 8);
}

async function keywordRows(env: Env, query: string, limit: number): Promise<ArticleRow[]> {
  const terms = searchTerms(query);
  const termConditions = terms.flatMap(() => [
    "instr(lower(title), lower(?)) > 0",
    "instr(lower(full_text), lower(?)) > 0",
    "instr(lower(tags_json), lower(?)) > 0",
  ]);
  const orderTerm = terms[0] ?? query;
  const statement = env.DB.prepare(`
    SELECT * FROM articles
    WHERE status = 'published' AND (${termConditions.join(" OR ")})
    ORDER BY
      CASE
        WHEN instr(lower(title), lower(?)) > 0 THEN 0
        WHEN instr(lower(tags_json), lower(?)) > 0 THEN 1
        ELSE 2
      END,
      COALESCE(published_at, updated_at, fetched_at) DESC
    LIMIT ?
  `);
  const bindings: Array<string | number> = [];
  for (const term of terms) bindings.push(term, term, term);
  bindings.push(orderTerm, orderTerm, limit);
  const result = await statement.bind(...bindings).all<ArticleRow>();
  return result.results ?? [];
}

async function rowsByIds(env: Env, ids: string[]): Promise<Map<string, ArticleRow>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const result = await env.DB.prepare(`SELECT * FROM articles WHERE status = 'published' AND id IN (${placeholders})`)
    .bind(...ids)
    .all<ArticleRow>();
  return new Map((result.results ?? []).map((row) => [row.id, row]));
}

export async function searchArticles(
  env: Env,
  queryValue: string,
  limitValue?: number,
  modeValue: SearchMode = "hybrid",
): Promise<SearchResponse> {
  const query = queryValue.trim();
  if (query.length < 2) throw new SearchError(400, "Search query must contain at least 2 characters", "query_too_short");
  if (query.length > 300) throw new SearchError(400, "Search query must be 300 characters or fewer", "query_too_long");

  const config = getConfig(env);
  const limit = Math.min(config.maxSearchResults, Math.max(1, Math.trunc(limitValue ?? 10)));
  const mode: SearchMode = ["hybrid", "keyword", "semantic"].includes(modeValue) ? modeValue : "hybrid";
  const candidateLimit = Math.max(limit * 3, 30);

  const [keyword, semantic] = await Promise.all([
    mode === "semantic" ? Promise.resolve([] as ArticleRow[]) : keywordRows(env, query, candidateLimit),
    mode === "keyword"
      ? Promise.resolve([])
      : embedTexts(env, [query]).then((vectors) => searchVectors(env, vectors[0] ?? [], config.semanticCandidateLimit)),
  ]);

  const scores = new Map<string, number>();
  const addRanks = (ids: string[]) => {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank));
    }
  };

  addRanks(keyword.map((row) => row.id));
  const bestSemanticRank = new Map<string, number>();
  for (const hit of semantic) {
    const previous = bestSemanticRank.get(hit.articleId);
    if (previous === undefined || hit.score > previous) bestSemanticRank.set(hit.articleId, hit.score);
  }
  const semanticIds = [...bestSemanticRank.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  addRanks(semanticIds);

  const ids = [...scores.keys()].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  const rows = new Map<string, ArticleRow>(keyword.map((row) => [row.id, row]));
  const missingRows = await rowsByIds(env, ids.filter((id) => !rows.has(id)));
  for (const [id, row] of missingRows) rows.set(id, row);

  const results = ids
    .filter((id) => rows.has(id))
    .slice(0, limit)
    .map((id) => toSummary(rows.get(id)!, scores.get(id)));

  return { query, mode, results, count: results.length };
}

/** Lists newest indexed published posts directly from D1 (no embedding or vector search). */
export async function listRecentArticles(
  env: Env,
  n = 5,
): Promise<{ results: ArticleSummary[]; count: number; n: number }> {
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new SearchError(400, "n must be an integer between 1 and 50", "invalid_limit");
  }
  const query = `
    SELECT id, title, canonical_url, published_at, tags_json,
           substr(full_text, 1, 500) AS full_text
    FROM articles
    WHERE status = 'published'
    ORDER BY COALESCE(published_at, updated_at, fetched_at) DESC, id DESC
    LIMIT ?
  `;
  const result = await env.DB.prepare(query).bind(n).all<SummaryRow>();
  const results = (result.results ?? []).map((row) => toSummary(row));
  return { results, count: results.length, n };
}

export async function getArticle(env: Env, idOrUrl: string): Promise<ArticleRow | null> {
  return env.DB.prepare("SELECT * FROM articles WHERE id = ? OR canonical_url = ? LIMIT 1")
    .bind(idOrUrl, idOrUrl)
    .first<ArticleRow>();
}

export function articleToApi(row: ArticleRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    url: row.canonical_url,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    tags: tagsFromJson(row.tags_json),
    fullText: row.full_text,
    fetchedAt: row.fetched_at,
  };
}

export class SearchError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
    this.name = "SearchError";
  }
}
