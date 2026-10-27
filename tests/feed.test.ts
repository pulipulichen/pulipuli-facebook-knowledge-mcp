import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeedPage } from "../src/feed";

const baseUrl = "https://blog.pulipuli.info/";
const feedUrl = baseUrl + "feeds/posts/default?max-results=2&start-index=1";

function mockFeed(xml: string, status = 200): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(xml, {
    status, headers: { "Content-Type": "application/atom+xml" },
  })));
}

afterEach(() => vi.unstubAllGlobals());

describe("Blogger and RSS feed ingestion", () => {
  it("uses Blogger summary JSON while preserving a saved page's ordering and size", async () => {
    const savedUrl = baseUrl + "feeds/posts/default?start-index=101&max-results=100&orderby=updated";
    mockFeed(JSON.stringify({ feed: {
      link: [{ rel: "next", href: baseUrl + "feeds/posts/summary?alt=json&start-index=201&max-results=100" }],
      entry: [{
        title: { $t: "A small metadata feed" },
        published: { $t: "2026-10-26T07:30:00Z" },
        updated: { $t: "2026-10-26T08:30:00Z" },
        link: [{ rel: "self", href: baseUrl + "feeds/posts/default/123" }, { rel: "alternate", href: baseUrl + "post.html" }],
        category: [{ term: "MCP" }, { term: "MCP" }],
      }],
    } }));
    const page = await fetchFeedPage(savedUrl, baseUrl);
    const request = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(request.pathname).toBe("/feeds/posts/summary");
    expect(Object.fromEntries(request.searchParams)).toEqual({ "start-index": "101", "max-results": "100", orderby: "updated", alt: "json" });
    expect(page.entries).toEqual([{ title: "A small metadata feed", url: baseUrl + "post.html", publishedAt: "2026-10-26T07:30:00.000Z", updatedAt: "2026-10-26T08:30:00.000Z", tags: ["MCP"], content: "" }]);
    expect(page.nextUrl).toContain("start-index=201");
  });

  it("does not rewrite generic RSS feed URLs", async () => {
    mockFeed('<rss><channel><item><title>Post</title><link>https://blog.pulipuli.info/post.html</link></item></channel></rss>');
    const url = "https://example.test/feed.xml?category=test";
    await fetchFeedPage(url, baseUrl);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(url);
  });

  it("parses Atom entries, dates, unique tags, and same-origin pagination", async () => {
    mockFeed([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      '<link rel="next" href="/feeds/posts/default?start-index=3"/>',
      '<entry>',
      '<title>中文語意搜尋</title>',
      '<link rel="alternate" type="text/html" href="https://blog.pulipuli.info/2026/10/search.html"/>',
      '<published>2026-10-26T07:30:00Z</published>',
      '<updated>2026-10-26T08:30:00Z</updated>',
      '<category term="Cloudflare"/><category term="Cloudflare"/><category term="MCP"/>',
      '</entry></feed>',
    ].join(""));

    const result = await fetchFeedPage(feedUrl, baseUrl);
    expect(result.nextUrl).toBe("https://blog.pulipuli.info/feeds/posts/default?start-index=3");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      url: "https://blog.pulipuli.info/2026/10/search.html",
      title: "中文語意搜尋",
      publishedAt: "2026-10-26T07:30:00.000Z",
      updatedAt: "2026-10-26T08:30:00.000Z",
      tags: ["Cloudflare", "MCP"],
      content: "",
    });
  });

  it("parses an RSS item using pubDate and category", async () => {
    mockFeed([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0"><channel>',
      '<item><title>RSS 測試</title>',
      '<link>https://blog.pulipuli.info/2026/10/rss.html</link>',
      '<pubDate>Mon, 26 Oct 2026 00:00:00 GMT</pubDate>',
      '<category>測試</category></item>',
      '</channel></rss>',
    ].join(""));
    const result = await fetchFeedPage(feedUrl, baseUrl);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe("RSS 測試");
    expect(result.entries[0]?.publishedAt).toBe("2026-10-26T00:00:00.000Z");
    expect(result.entries[0]?.tags).toEqual(["測試"]);
    expect(result.nextUrl).toBeNull();
  });

  it("does not follow feed pagination redirects to another origin", async () => {
    mockFeed('<feed><link rel="next" href="https://other.example/steal"/><entry><title>Post</title><link rel="alternate" href="https://blog.pulipuli.info/post.html"/></entry></feed>');
    const result = await fetchFeedPage(feedUrl, baseUrl);
    expect(result.entries).toHaveLength(1);
    expect(result.nextUrl).toBeNull();
  });

  it("reports non-successful upstream feed responses", async () => {
    mockFeed("not found", 404);
    await expect(fetchFeedPage(feedUrl, baseUrl)).rejects.toThrow("Feed request returned HTTP 404");
  });
});
