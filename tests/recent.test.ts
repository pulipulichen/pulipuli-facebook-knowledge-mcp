import { describe, expect, it, vi } from "vitest";
import { listRecentArticles } from "../src/search";
import { sqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";

function createEnv() {
  const { db, sqlite } = sqliteD1();
  const ai = { run: vi.fn() };
  const insert = sqlite.prepare(`
    INSERT INTO articles
      (id, source_id, canonical_url, title, published_at, updated_at,
       tags_json, full_text, content_hash, fetched_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  function add(id: string, publishedAt: string | null, status = "published", updatedAt: string | null = null) {
    insert.run(
      id, "pulipuli-blog", "https://blog.pulipuli.info/" + id + ".html",
      "Post " + id, publishedAt, updatedAt, '["MCP","Cloudflare"]',
      ("Post " + id + " excerpt. ").repeat(40), "hash-" + id,
      "2026-10-27T01:00:00.000Z", status,
    );
  }
  for (let day = 1; day <= 7; day++) {
    add("post-" + day, `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`);
  }
  add("missing-published", null, "published", "2026-10-06T12:00:00.000Z");
  add("unpublished", "2026-10-31T00:00:00.000Z", "blocked");
  return { env: { DB: db, AI: ai } as unknown as Env, ai, sqlite };
}

describe("recently published articles", () => {
  it("defaults to five articles and orders by publication/fallback time", async () => {
    const { env, ai, sqlite } = createEnv();
    try {
      const response = await listRecentArticles(env);
      expect(response.n).toBe(5);
      expect(response.count).toBe(5);
      expect(response.results.map((article) => article.id)).toEqual([
        "post-7", "missing-published", "post-6", "post-5", "post-4",
      ]);
      expect(response.results[0]).toMatchObject({
        title: "Post post-7",
        url: "https://blog.pulipuli.info/post-7.html",
        tags: ["MCP", "Cloudflare"],
      });
      expect(response.results[0].excerpt.length).toBeLessThanOrEqual(261);
      expect(ai.run).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it("accepts N and excludes unpublished articles", async () => {
    const { env, sqlite } = createEnv();
    try {
      expect((await listRecentArticles(env, 2)).results.map((article) => article.id)).toEqual([
        "post-7", "missing-published",
      ]);
      const all = await listRecentArticles(env, 50);
      expect(all.count).toBe(8);
      expect(all.results.some((article) => article.id === "unpublished")).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("rejects invalid N values", async () => {
    const { env, sqlite } = createEnv();
    try {
      for (const n of [0, 51, -1, 1.5, NaN]) {
        await expect(listRecentArticles(env, n)).rejects.toMatchObject({
          status: 400, code: "invalid_limit",
        });
      }
    } finally {
      sqlite.close();
    }
  });
});
