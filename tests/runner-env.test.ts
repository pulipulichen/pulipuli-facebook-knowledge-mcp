import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunnerEnv } from "../scripts/runner-env";

const source = {
  CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "cf-secret", D1_DATABASE_ID: "database",
  INGEST_URL: "https://worker.example.test/internal/ingest/", INGEST_TOKEN: "ingest-secret",
  QDRANT_URL: "https://qdrant.example.test", QDRANT_API_KEY: "qdrant-secret",
};
afterEach(() => vi.unstubAllGlobals());

describe("Actions environment and small embedding requests", () => {
  it("validates the deployed model and splits embedding batches into one text per Worker request", async () => {
    const fetcher = vi.fn(async (_url, options: RequestInit) => new Response(JSON.stringify({
      model: "@cf/baai/bge-m3", ...(options.method === "POST" ? { data: [[0.1, 0.2]] } : {}),
    })));
    vi.stubGlobal("fetch", fetcher);
    const { env, checkEmbeddingService } = createRunnerEnv(source);
    await checkEmbeddingService();
    expect(await env.AI.run("@cf/baai/bge-m3", { text: ["第一段", "第二段"] })).toEqual({ data: [[0.1, 0.2], [0.1, 0.2]] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => url.toString())).toEqual(Array(3).fill("https://worker.example.test/internal/ingest/embedding"));
    expect(fetcher.mock.calls.slice(1).map(([, options]) => JSON.parse(options.body as string))).toEqual([{ text: "第一段" }, { text: "第二段" }]);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer ingest-secret");
    expect(env.CHUNK_SIZE_CHARS).toBe("900");
  });

  it("fails before ingestion when deployment or configuration is missing", async () => {
    expect(() => createRunnerEnv({ ...source, D1_DATABASE_ID: "" })).toThrow("D1_DATABASE_ID");
    expect(() => createRunnerEnv({ ...source, INGEST_URL: "http://worker.example.test" })).toThrow("HTTPS");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    await expect(createRunnerEnv(source).checkEmbeddingService()).rejects.toThrow("Deploy");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "different" }))));
    await expect(createRunnerEnv(source).checkEmbeddingService()).rejects.toThrow("models differ");
  });
});
