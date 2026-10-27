import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedTexts, searchVectors } from "../src/qdrant";
import { articleToApi, getArticle, searchArticles } from "../src/search";
import type { ArticleRow, Env } from "../src/types";

vi.mock("../src/qdrant", () => ({
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
}));

const makeArticle = (id: string, title: string): ArticleRow => ({
  id,
  source_id: "pulipuli-blog",
  canonical_url: "https://blog.pulipuli.info/" + id + ".html",
  title,
  published_at: "2026-10-26T00:00:00.000Z",
  updated_at: null,
  tags_json: title.includes("MCP") ? '["MCP","Cloudflare"]' : '["Podman"]',
  full_text: title + "：這是一篇部落格文章。",
  content_hash: "hash-" + id,
  fetched_at: "2026-10-26T00:00:00.000Z",
  status: "published",
});

const alpha = makeArticle("alpha", "MCP 文章");
const beta = makeArticle("beta", "MCP 測試");
const gamma = makeArticle("gamma", "Podman 開發");
const articles = [alpha, beta, gamma];

function mockEnv(): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              if (sql.includes("id IN (")) {
                return { results: articles.filter((article) => values.includes(article.id)) };
              }
              const query = String(values[0] ?? "").toLowerCase();
              return {
                results: articles.filter((article) =>
                  (article.title + " " + article.full_text + " " + article.tags_json)
                    .toLowerCase().includes(query)),
              };
            },
            async first() {
              const identifier = String(values[0] ?? "");
              return articles.find((article) =>
                article.id === identifier || article.canonical_url === identifier) ?? null;
            },
          };
        },
      };
    },
  };
  return {
    BLOG_BASE_URL: "https://blog.pulipuli.info/",
    BLOG_FEED_URL: "https://blog.pulipuli.info/feeds/posts/default",
    DB: db,
    AI: { run: vi.fn() },
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(embedTexts).mockResolvedValue([[0.1, 0.2]]);
  vi.mocked(searchVectors).mockResolvedValue([]);
});

describe("search request and ranking", () => {
  it("rejects empty, too-short, and oversized queries", async () => {
    const env = mockEnv();
    await expect(searchArticles(env, "a")).rejects.toMatchObject({
      status: 400, code: "query_too_short",
    });
    await expect(searchArticles(env, "a".repeat(301))).rejects.toMatchObject({
      status: 400, code: "query_too_long",
    });
  });

  it("performs keyword search without calling paid AI services", async () => {
    const result = await searchArticles(mockEnv(), "MCP", 10, "keyword");
    expect(result.count).toBe(2);
    expect(result.results.map((article) => article.id)).toEqual(["alpha", "beta"]);
    expect(result.results[0]?.tags).toEqual(["MCP", "Cloudflare"]);
    expect(embedTexts).not.toHaveBeenCalled();
    expect(searchVectors).not.toHaveBeenCalled();
  });

  it("uses reciprocal-rank fusion and deduplicates article-level semantic hits", async () => {
    vi.mocked(searchVectors).mockResolvedValue([
      { id: "chunk-gamma", articleId: "gamma", ordinal: 0, score: 0.95 },
      { id: "chunk-alpha", articleId: "alpha", ordinal: 0, score: 0.85 },
      { id: "chunk-alpha-2", articleId: "alpha", ordinal: 1, score: 0.80 },
    ]);
    const result = await searchArticles(mockEnv(), "MCP", 10, "hybrid");
    expect(result.results.map((article) => article.id)).toEqual(["alpha", "gamma", "beta"]);
    expect(new Set(result.results.map((article) => article.id)).size).toBe(3);
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(searchVectors).toHaveBeenCalledTimes(1);
    expect(result.results[0]!.score).toBeGreaterThan(result.results[1]!.score!);
  });

  it("sorts semantic-only results by similarity", async () => {
    vi.mocked(searchVectors).mockResolvedValue([
      { id: "chunk-alpha", articleId: "alpha", ordinal: 0, score: 0.2 },
      { id: "chunk-gamma", articleId: "gamma", ordinal: 0, score: 0.9 },
    ]);
    const result = await searchArticles(mockEnv(), "容器", 10, "semantic");
    expect(result.results.map((article) => article.id)).toEqual(["gamma", "alpha"]);
  });

  it("enforces the configured result count", async () => {
    const result = await searchArticles(mockEnv(), "MCP", 1, "keyword");
    expect(result.results).toHaveLength(1);
  });
});

describe("article details", () => {
  it("retrieves by either ID or canonical URL", async () => {
    const env = mockEnv();
    await expect(getArticle(env, "alpha")).resolves.toEqual(alpha);
    await expect(getArticle(env, alpha.canonical_url)).resolves.toEqual(alpha);
    await expect(getArticle(env, "missing")).resolves.toBeNull();
  });

  it("converts database JSON tags into the public article shape", () => {
    const result = articleToApi(alpha);
    expect(result).toMatchObject({
      title: "MCP 文章",
      url: alpha.canonical_url,
      tags: ["MCP", "Cloudflare"],
      fullText: alpha.full_text,
    });
  });
});
