import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizeUrl } from "../src/article";
import {
  bearerToken,
  constantTimeEqual,
  escapeHtml,
  fetchWithRetry,
  normalizeText,
  parseDate,
  readJsonBody,
  sha256Hex,
  splitIntoChunks,
  stableUuid,
} from "../src/http";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP request validation", () => {
  it("accepts a bearer token and rejects other schemes", () => {
    expect(bearerToken(new Request("https://example.test", {
      headers: { Authorization: "Bearer example-secret" },
    }))).toBe("example-secret");
    expect(bearerToken(new Request("https://example.test", {
      headers: { Authorization: "Basic example-secret" },
    }))).toBeNull();
  });

  it("compares tokens without accepting prefixes or changed characters", () => {
    expect(constantTimeEqual("same-token", "same-token")).toBe(true);
    expect(constantTimeEqual("same-token", "same")).toBe(false);
    expect(constantTimeEqual("same-token", "same-tokEn")).toBe(false);
  });

  it("rejects invalid JSON and oversized request bodies", async () => {
    const invalid = new Request("https://example.test", { method: "POST", body: "{" });
    await expect(readJsonBody(invalid)).rejects.toMatchObject({
      status: 400, code: "invalid_json",
    });

    const oversized = new Request("https://example.test", {
      method: "POST",
      body: "hello world",
    });
    await expect(readJsonBody(oversized, 5)).rejects.toMatchObject({
      status: 413, code: "body_too_large",
    });
  });

  it("parses a valid JSON body", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({ reset: true }),
    });
    await expect(readJsonBody(request)).resolves.toEqual({ reset: true });
  });

  it("retries a 429 response with Retry-After and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", {
        status: 429, headers: { "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/feed", {}, 1);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("article text and identifiers", () => {
  it("removes common tracking query parameters and fragments", () => {
    expect(canonicalizeUrl(
      "/2026/10/post.html?utm_source=rss&fbclid=abc&keep=yes#comments",
      "https://blog.pulipuli.info/",
    )).toBe("https://blog.pulipuli.info/2026/10/post.html?keep=yes");
  });

  it("removes adjacent and repeated tracking keys without skipping other parameters", () => {
    expect(canonicalizeUrl(
      "/post?utm_source=rss&fbclid=1&utm_medium=email&keep=first&gclid=2&keep=second&mc_cid=3&mc_eid=4&UTM_CAMPAIGN=launch",
      "https://blog.pulipuli.info/",
    )).toBe("https://blog.pulipuli.info/post?keep=first&keep=second");
  });

  it("normalizes whitespace without losing Chinese text", () => {
    expect(normalizeText("  Hello   world \n\n  中文  測試  \n")).toBe("Hello world\n中文 測試");
  });

  it("preserves Unicode code points when splitting overlapping chunks", () => {
    expect(splitIntoChunks("😀中文語意", 3, 1)).toEqual(["😀中文", "文語意"]);
  });

  it("escapes potentially unsafe text in the search page", () => {
    expect(escapeHtml("<script>\"&'")).toBe("&lt;script&gt;&quot;&amp;&#39;");
  });

  it("produces deterministic hashes and UUIDs", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const id = await stableUuid("same article");
    expect(await stableUuid("same article")).toBe(id);
    expect(await stableUuid("another article")).not.toBe(id);
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });

  it("rejects invalid dates and normalizes valid dates", () => {
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("2026-10-26T00:00:00Z")).toBe("2026-10-26T00:00:00.000Z");
  });
});
