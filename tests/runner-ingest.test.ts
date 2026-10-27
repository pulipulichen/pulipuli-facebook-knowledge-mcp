import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestOnRunner } from "../scripts/ingest";
import { createRunnerEnv } from "../scripts/runner-env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";
import { extractArticleText } from "../scripts/html-text";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("cloud runner ingestion", () => {
  it("extracts article content from a large Blogger template without scripts, navigation, or an HTMLRewriter", () => {
    const content = "Readable 中文 article &amp; entities. ".repeat(100);
    const html = `<html><head><script>${"template data ".repeat(40_000)}</script><style>junk</style></head><body><nav>MENU</nav><article><div class='post-body'><p>${content}</p><script>hidden()</script><p>Last paragraph 😀</p></div></article><footer>FOOTER</footer></body></html>`;
    const text = extractArticleText(html);
    expect(text).toContain("Readable 中文 article & entities.");
    expect(text).toContain("\nLast paragraph 😀");
    for (const unwanted of ["template data", "hidden()", "MENU", "FOOTER", "junk"]) expect(text).not.toContain(unwanted);
  });

  it("resumes a Facebook RSS post and advances the saved cursor", async () => {
    const store = sqliteD1();
    try {
      const feedUrl = "https://example.com/facebook.atom";
      const cursor = { url: feedUrl, offset: 0 };
      store.sqlite.prepare("INSERT INTO sync_state VALUES ('ingest_cursor', ?, '')").run(JSON.stringify(cursor));
      const title = "Facebook RSS post";
      const url = "https://www.facebook.com/pulipuli.blogspot/posts/123";
      const content = "正文 😀 Facebook post text. ".repeat(100);
      const xml = `<rss><channel><item><title>${title}</title><link>${url}</link><description>${content}</description></item><item><title>Next</title><link>https://www.facebook.com/pulipuli.blogspot/posts/456</link><description>Next post content</description></item></channel></rss>`;
      const embeddingCalls: string[] = [];
      const upserts: unknown[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input, init: RequestInit = {}) => {
        const target = input.toString();
        if (target === feedUrl) return new Response(xml);
        if (target.endsWith("/embedding")) {
          const body = JSON.parse(init.body as string);
          embeddingCalls.push(body.text);
          return new Response(JSON.stringify({ model: "@cf/baai/bge-m3", data: [[0.1, 0.2]] }));
        }
        if (target.includes("/collections/pulipuli_blog/points?")) { upserts.push(JSON.parse(init.body as string)); return new Response('{"status":"ok"}'); }
        if (target.endsWith("/collections/pulipuli_blog")) return new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 2 } } } } }));
        throw new Error(`Unexpected network request ${target}`);
      }));
      const { env } = createRunnerEnv({
        CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "secret", D1_DATABASE_ID: "database",
        INGEST_URL: "https://worker.example.test/internal/ingest", INGEST_TOKEN: "secret",
        QDRANT_URL: "https://qdrant.example.test", QDRANT_API_KEY: "secret",
      });
      env.DB = store.db;
      env.BLOG_FEED_URL = feedUrl;
      env.BLOG_BASE_URL = "https://www.facebook.com/pulipuli.blogspot/";
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const result = await ingestOnRunner(env, { INGEST_MAX_BATCHES: "1" });
      expect(result, JSON.stringify(logs.mock.calls)).toMatchObject({ done: false, totals: { inserted: 1, scanned: 1, failed: 0 } });
      expect(embeddingCalls.length).toBeGreaterThan(0);
      expect(embeddingCalls.every((text) => Array.from(text).length <= 900)).toBe(true);
      expect(upserts).toHaveLength(1);
      expect(store.sqlite.prepare("SELECT title FROM articles").get()?.title).toBe(title);
      expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM chunks").get()?.count).toBe(embeddingCalls.length);
      expect(JSON.parse(store.sqlite.prepare("SELECT value FROM sync_state WHERE key = 'ingest_cursor'").get()?.value as string)).toEqual({ ...cursor, offset: 1 });
      expect(store.sqlite.prepare("SELECT token FROM sync_lock").get()?.token).toBeNull();
      expect(logs.mock.calls[0][0]).toContain(title);
      expect(logs.mock.calls[0][0]).toContain(url);
    } finally { store.sqlite.close(); }
  });
});
