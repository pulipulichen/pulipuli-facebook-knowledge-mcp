import { afterEach, describe, expect, it, vi } from "vitest";
import { embedTexts, ensureCollection, searchVectors } from "../src/qdrant";
import type { Env } from "../src/types";

function mockEnv(aiResult: unknown = { data: [[0.1, 0.2]] }): Env {
  return {
    BLOG_BASE_URL: "https://blog.pulipuli.info/",
    BLOG_FEED_URL: "https://blog.pulipuli.info/feeds/posts/default",
    QDRANT_URL: "https://qdrant.example.test/",
    QDRANT_API_KEY: "test-key",
    QDRANT_COLLECTION: "blog-test",
    AI: { run: vi.fn().mockResolvedValue(aiResult) },
  } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

describe("Workers AI embedding response validation", () => {
  it("accepts one vector for each text in a batch", async () => {
    const env = mockEnv({ data: [[0.1, 0.2], [0.3, 0.4]] });
    await expect(embedTexts(env, ["第一段", "第二段"])).resolves.toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(env.AI.run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["第一段", "第二段"], truncate_inputs: true,
    });
  });

  it("accepts a flat vector only for a single text", async () => {
    await expect(embedTexts(mockEnv({ data: [0.3, 0.5] }), ["文章"])).resolves.toEqual([[0.3, 0.5]]);
    await expect(embedTexts(mockEnv({ data: [0.3, 0.5] }), ["甲", "乙"]))
      .rejects.toThrow("flat vector");
  });

  it("rejects missing or non-finite embedding values", async () => {
    await expect(embedTexts(mockEnv({}), ["文章"])).rejects.toThrow("embedding data");
    await expect(embedTexts(mockEnv({ data: [[Number.NaN]] }), ["文章"]))
      .rejects.toThrow("unexpected number or shape");
  });
});

describe("Qdrant vector storage", () => {
  it("handles a collection that has not yet been created", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"status":"error"}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureCollection(mockEnv(), 1024)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body).toEqual({ vectors: { size: 1024, distance: "Cosine" } });
  });

  it("rejects existing collections with incompatible dimensions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { config: { params: { vectors: { size: 512, distance: "Cosine" } } } },
    }), { status: 200 })));
    await expect(ensureCollection(mockEnv(), 1024)).rejects.toThrow("vector size is 512");
  });

  it("maps Qdrant search points back to article identifiers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: {
        points: [
          { id: "point-1", score: 0.9, payload: { articleId: "article-1", ordinal: 2 } },
          { id: "missing-article", score: 0.8, payload: {} },
        ],
      },
    }), { status: 200 })));
    const hits = await searchVectors(mockEnv(), [0.1, 0.2], 5);
    expect(hits).toEqual([{ id: "point-1", score: 0.9, articleId: "article-1", ordinal: 2 }]);
  });

  it("returns no results when the collection does not exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    await expect(searchVectors(mockEnv(), [0.1], 5)).resolves.toEqual([]);
  });
});
