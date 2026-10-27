import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function mockEnv(): Env {
  const db = {
    prepare(sql: string) {
      const first = vi.fn(async () => sql.includes("SELECT 1 AS ok") ? { ok: 1 } : null);
      return {
        first,
        bind: () => ({
          first,
          all: vi.fn(async () => ({ results: [] })),
        }),
      };
    },
  };
  return {
    DB: db,
    BLOG_FEED_URL: "https://blog.pulipuli.info/feeds/posts/default",
    BLOG_BASE_URL: "https://blog.pulipuli.info/",
    INGEST_TOKEN: "unit-test-token",
    AI: { run: vi.fn() },
  } as unknown as Env;
}

describe("public Worker routes (without Cloudflare credentials)", () => {
  it("serves a search page with a content security policy", async () => {
    const response = await worker.fetch(new Request("https://worker.example.test/"), mockEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain('id="recent-button"');
  });

  it("reports D1 health", async () => {
    const response = await worker.fetch(new Request("https://worker.example.test/health"), mockEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok", database: "ok", mcp: "/mcp",
    });
  });

  it("rejects bad search input with a 400 error", async () => {
    const response = await worker.fetch(new Request("https://worker.example.test/api/search?q=a"), mockEnv());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "query_too_short" },
    });
  });

  it("performs a keyword search without external network calls", async () => {
    const response = await worker.fetch(new Request(
      "https://worker.example.test/api/search?q=MCP&mode=keyword",
    ), mockEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ count: 0, mode: "keyword" });
  });

  it("lists recent posts with a default of five", async () => {
    const response = await worker.fetch(new Request("https://worker.example.test/api/recent"), mockEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [], count: 0, n: 5 });
  });

  it("rejects invalid recent counts", async () => {
    for (const n of ["0", "51", "-2", "1.5", "wat", ""]) {
      const response = await worker.fetch(new Request("https://worker.example.test/api/recent?n=" + n), mockEnv());
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_limit" } });
    }
  });

  it("rejects non-GET recent requests", async () => {
    const response = await worker.fetch(new Request("https://worker.example.test/api/recent", { method: "POST" }), mockEnv());
    expect(response.status).toBe(405);
  });

  it("does not permit ingestion with a missing or invalid bearer token", async () => {
    const url = "https://worker.example.test/internal/ingest";
    for (const authorization of [undefined, "Bearer wrong-token"]) {
      const response = await worker.fetch(new Request(url, {
        method: "POST",
        ...(authorization ? { headers: { authorization } } : {}),
        body: "{}",
      }), mockEnv());
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "unauthorized" },
      });
    }
  });

  it("keeps the live import status protected by the ingest token", async () => {
    const env = mockEnv();
    const endpoint = "https://worker.example.test/internal/ingest/status";
    const unauthorized = await worker.fetch(new Request(endpoint), env);
    expect(unauthorized.status).toBe(401);

    env.DB = {
      prepare(sql: string) {
        if (sql.includes("SELECT token, expires_at FROM sync_lock")) {
          return { first: async () => ({ token: "other-run", expires_at: Math.floor(Date.now() / 1000) + 120 }) };
        }
        if (sql.includes("SELECT value FROM sync_state")) {
          return { bind: () => ({ first: async () => ({
            value: JSON.stringify({
              startedAt: "2026-10-26T15:00:00.000Z",
              articles: [{ title: "Sample Article", url: "https://blog.pulipuli.info/article.html" }],
            }),
          }) }) };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    } as unknown as D1Database;

    const authorized = await worker.fetch(new Request(endpoint, {
      headers: { authorization: "Bearer unit-test-token" },
    }), env);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      locked: true,
      current: { articles: [{ title: "Sample Article", url: "https://blog.pulipuli.info/article.html" }] },
    });
  });

  it("protects the runner embedding service and limits each call to one small text", async () => {
    const env = mockEnv();
    const endpoint = "https://worker.example.test/internal/ingest/embedding";
    expect((await worker.fetch(new Request(endpoint), env)).status).toBe(401);
    const headers = { authorization: "Bearer unit-test-token" };
    const info = await worker.fetch(new Request(endpoint, { headers }), env);
    await expect(info.json()).resolves.toMatchObject({ model: "@cf/baai/bge-m3", maxTextChars: 3000 });
    for (const body of [{ text: ["one", "two"] }, { text: "x".repeat(3001) }, {}, null]) {
      const response = await worker.fetch(new Request(endpoint, { method: "POST", headers, body: JSON.stringify(body) }), env);
      expect(response.status).toBe(400);
    }
    expect(env.AI.run).not.toHaveBeenCalled();
    vi.mocked(env.AI.run).mockResolvedValue({ data: [[0.1, 0.2]] });
    const response = await worker.fetch(new Request(endpoint, { method: "POST", headers, body: JSON.stringify({ text: "中文文章 😀" }) }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ model: "@cf/baai/bge-m3", data: [[0.1, 0.2]] });
    expect(env.AI.run).toHaveBeenCalledWith("@cf/baai/bge-m3", { text: ["中文文章 😀"], truncate_inputs: true });
    const invalid = await worker.fetch(new Request(endpoint, { method: "POST", headers, body: "{" }), env);
    expect(invalid.status).toBe(400);
    const oversized = await worker.fetch(new Request(endpoint, { method: "POST", headers, body: JSON.stringify({ text: "x".repeat(17_000) }) }), env);
    expect(oversized.status).toBe(413);
  });

  it("returns Retry-After on an ingestion lock conflict", async () => {
    const env = mockEnv();
    env.DB = {
      prepare(sql: string) {
        if (sql.includes("INSERT OR IGNORE INTO sync_lock")) {
          return { run: async () => ({ success: true }) };
        }
        if (sql.includes("UPDATE sync_lock SET token")) {
          return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    } as unknown as D1Database;

    const response = await worker.fetch(new Request(
      "https://worker.example.test/internal/ingest",
      { method: "POST", headers: { authorization: "Bearer unit-test-token" }, body: "{}" },
    ), env);
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("20");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ingestion_already_running" },
    });
  });

  it("responds to CORS preflight without credentials", async () => {
    const response = await worker.fetch(new Request("https://worker.example.test/mcp", {
      method: "OPTIONS",
    }), mockEnv());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("Mcp-Protocol-Version");
  });

  it("returns a not-found response for unindexed article IDs", async () => {
    const response = await worker.fetch(new Request(
      "https://worker.example.test/api/articles/missing",
    ), mockEnv());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "article_not_found" },
    });
  });
});

