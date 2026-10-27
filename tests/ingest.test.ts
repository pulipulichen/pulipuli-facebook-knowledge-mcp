import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIngest } from "../src/ingest";
import { fetchFeedPage } from "../src/feed";
import { fetchArticleText } from "../src/article";
import { upsertPoints } from "../src/qdrant";
import type { Env, FeedEntry } from "../src/types";
import { sqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/feed", () => ({ fetchFeedPage: vi.fn() }));
vi.mock("../src/article", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/article")>(), fetchArticleText: vi.fn(),
}));
vi.mock("../src/qdrant", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/qdrant")>(),
  embedTexts: vi.fn(async (_env, texts: string[]) => texts.map(() => [0.1, 0.2])),
  ensureCollection: vi.fn(async () => undefined), upsertPoints: vi.fn(async () => undefined), deletePoints: vi.fn(async () => undefined),
}));

let store: ReturnType<typeof sqliteD1>;
let env: Env;
const entries: FeedEntry[] = ["one", "two", "three"].map((name) => ({
  title: name, url: `https://blog.pulipuli.info/${name}.html`, tags: ["test"], publishedAt: null, updatedAt: null,
}));
const cursor = { url: "https://blog.pulipuli.info/feeds/posts/default?max-results=100&start-index=101", offset: 1 };
function state(key: string) { return store.sqlite.prepare("SELECT value FROM sync_state WHERE key = ?").get(key)?.value; }
beforeEach(() => {
  vi.clearAllMocks();
  store = sqliteD1();
  env = { DB: store.db, BLOG_FEED_URL: "https://blog.pulipuli.info/feeds/posts/default", BLOG_BASE_URL: "https://blog.pulipuli.info/", REQUEST_DELAY_MS: "0" } as Env;
  store.sqlite.prepare("INSERT INTO sync_state VALUES ('ingest_cursor', ?, '')").run(JSON.stringify(cursor));
  vi.mocked(fetchFeedPage).mockResolvedValue({ entries, nextUrl: null });
  vi.mocked(fetchArticleText).mockResolvedValue("Readable article text ".repeat(20));
});
afterEach(() => { store.sqlite.close(); });

describe("ingestion checkpoints and resource budgets with real SQLite", () => {
  it("resumes an existing 100-entry Atom cursor one article at a time", async () => {
    const result = await runIngest(env);
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ done: false, scanned: 1, inserted: 1, failed: 0, articles: [{ title: "two", status: "inserted" }] });
    expect(JSON.parse(state("ingest_cursor") as string)).toEqual({ ...cursor, offset: 2 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM chunks").get()?.count).toBe(1);
    expect(store.sqlite.prepare("SELECT token FROM sync_lock").get()?.token).toBeNull();
    expect(state("ingest_active_articles")).toBe("");
    const last = await runIngest(env);
    expect(last).toMatchObject({ done: true, scanned: 1, inserted: 1 });
    expect(state("backfill_complete")).toBe("1");
  });

  it("leaves the checkpoint unchanged and releases the lease on feed failure", async () => {
    vi.mocked(fetchFeedPage).mockRejectedValueOnce(new Error("Upstream feed failed"));
    await expect(runIngest(env)).rejects.toThrow("Upstream feed failed");
    expect(JSON.parse(state("ingest_cursor") as string)).toEqual(cursor);
    expect(store.sqlite.prepare("SELECT token FROM sync_lock").get()?.token).toBeNull();
    expect(store.sqlite.prepare("SELECT status FROM sync_runs").get()?.status).toBe("failed");
  });

  it("does not commit articles, skip a cursor, or erase replacement progress after losing the lease", async () => {
    vi.mocked(fetchArticleText).mockImplementationOnce(async () => {
      store.sqlite.prepare("UPDATE sync_lock SET token = 'replacement', expires_at = ?").run(Math.floor(Date.now() / 1000) + 120);
      store.sqlite.prepare("UPDATE sync_state SET value = 'replacement progress' WHERE key = 'ingest_active_articles'").run();
      return "Readable article text ".repeat(20);
    });
    await expect(runIngest(env)).rejects.toMatchObject({ code: "ingestion_lease_lost" });
    expect(upsertPoints).not.toHaveBeenCalled();
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM articles").get()?.count).toBe(0);
    expect(JSON.parse(state("ingest_cursor") as string)).toEqual(cursor);
    expect(state("ingest_active_articles")).toBe("replacement progress");
    expect(store.sqlite.prepare("SELECT token FROM sync_lock").get()?.token).toBe("replacement");
  });

  it("shares the one-article budget with due retries without skipping fresh entries", async () => {
    const retry = { ...entries[0], title: "Retry", url: "https://blog.pulipuli.info/retry.html" };
    store.sqlite.prepare("INSERT INTO failed_articles VALUES (?, ?, 1, 0, 'previous error', '')").run(retry.url, JSON.stringify(retry));
    const result = await runIngest(env);
    expect(result).toMatchObject({ scanned: 0, retrying: 1, inserted: 1, done: false, articles: [{ title: "Retry" }] });
    expect(fetchArticleText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(state("ingest_cursor") as string)).toEqual(cursor);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM failed_articles").get()?.count).toBe(0);
    expect(await runIngest(env)).toMatchObject({ scanned: 1, retrying: 0, articles: [{ title: "two" }] });
  });

  it("persists failed articles before advancing the cursor", async () => {
    vi.mocked(fetchArticleText).mockRejectedValueOnce(new Error("Article fetch failed"));
    expect(await runIngest(env)).toMatchObject({ failed: 1, done: false, articles: [{ title: "two", status: "failed" }] });
    expect(store.sqlite.prepare("SELECT canonical_url, last_error FROM failed_articles").get()).toMatchObject({ canonical_url: entries[1].url, last_error: "Article fetch failed" });
    expect(JSON.parse(state("ingest_cursor") as string).offset).toBe(2);
  });

  it("retains the cursor when persisting a failed article also fails", async () => {
    store.sqlite.exec("CREATE TRIGGER reject_failure BEFORE INSERT ON failed_articles BEGIN SELECT RAISE(ABORT, 'retry storage unavailable'); END");
    vi.mocked(fetchArticleText).mockRejectedValueOnce(new Error("Article fetch failed"));
    await expect(runIngest(env)).rejects.toThrow("retry storage unavailable");
    expect(JSON.parse(state("ingest_cursor") as string)).toEqual(cursor);
    expect(store.sqlite.prepare("SELECT token FROM sync_lock").get()?.token).toBeNull();
  });

  it("checks ownership again after vector upsert before committing article data", async () => {
    vi.mocked(upsertPoints).mockImplementationOnce(async () => {
      store.sqlite.prepare("UPDATE sync_lock SET token = 'replacement', expires_at = ?").run(Math.floor(Date.now() / 1000) + 120);
    });
    await expect(runIngest(env)).rejects.toMatchObject({ code: "ingestion_lease_lost" });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM articles").get()?.count).toBe(0);
    expect(JSON.parse(state("ingest_cursor") as string)).toEqual(cursor);
  });
});
