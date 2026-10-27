import { XMLParser } from "fast-xml-parser";
import { fetchWithRetry, parseDate } from "./http";
import type { FeedEntry } from "./types";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  // Article bodies are fetched separately. Avoid XML entity processing for
  // unused full-text fields in non-Blogger feeds as well.
  stopNodes: ["*.content", "*.summary", "*.description", "*.encoded"],
});

export interface FeedPage {
  entries: FeedEntry[];
  nextUrl: string | null;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  return textValue(object["#text"] ?? object["#cdata"] ?? object.$t ?? object.value ?? "");
}

function parseLinks(value: unknown): Array<{ rel: string; href: string }> {
  return asArray(value as Record<string, unknown> | Record<string, unknown>[] | string | undefined)
    .map((item) => {
      if (typeof item === "string") return { rel: "alternate", href: item.trim() };
      const record = item as Record<string, unknown>;
      return {
        rel: textValue(record["@_rel"] ?? record.rel) || "alternate",
        href: textValue(record["@_href"] ?? record.href ?? record["#text"]),
      };
    })
    .filter((link) => Boolean(link.href));
}

function parseTags(value: unknown): string[] {
  return [...new Set(asArray(value as unknown | unknown[])
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const record = item as Record<string, unknown>;
      return textValue(record["@_term"] ?? record.term ?? record["#text"] ?? record.name);
    })
    .filter((tag) => tag.length > 0))].slice(0, 30);
}

function parseEntry(raw: Record<string, unknown>, baseUrl: string): FeedEntry | null {
  const atomLinks = parseLinks(raw.link);
  const rssLink = textValue(raw.link);
  const candidate = atomLinks.find((link) => link.rel === "alternate")?.href
    ?? atomLinks.find((link) => link.rel === "self")?.href
    ?? rssLink;
  if (!candidate) return null;

  let url: string;
  try {
    url = new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }

  const publishedAt = parseDate(textValue(raw.published ?? raw.pubDate ?? raw.date ?? raw["dc:date"]));
  const updatedAt = parseDate(textValue(raw.updated ?? raw["lastBuildDate"] ?? raw.modified));
  return {
    url,
    title: textValue(raw.title) || url,
    publishedAt,
    updatedAt,
    tags: parseTags(raw.category ?? raw.categories),
  };
}

export async function fetchFeedPage(feedUrl: string, blogBaseUrl: string): Promise<FeedPage> {
  const requestUrl = new URL(feedUrl);
  if (requestUrl.origin === new URL(blogBaseUrl).origin && /^\/feeds\/posts\/(default|summary)(\/|$)/.test(requestUrl.pathname)) {
    // Blogger's full Atom feed can approach 2 MB for 100 posts. Parsing it on
    // every one-article batch exceeds the Free Worker's CPU budget. Its summary
    // JSON feed has the same ordering/pagination and keeps existing cursors valid.
    requestUrl.pathname = requestUrl.pathname.replace("/feeds/posts/default", "/feeds/posts/summary");
    requestUrl.searchParams.set("alt", "json");
    requestUrl.searchParams.delete("callback");
  }
  const response = await fetchWithRetry(requestUrl, {
    headers: {
      Accept: "application/json, application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      "User-Agent": "PulipuliBlogKnowledgeBot/0.1 (+https://github.com/pulipulichen/pulipuli-blog-knowledge-mcp)",
    },
  });
  if (!response.ok) throw new Error(`Feed request returned HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("Feed response exceeded the 2 MB limit");

  const parsed = (/^\s*\{/.test(body) ? JSON.parse(body) : xmlParser.parse(body)) as Record<string, unknown>;
  const feed = (parsed.feed ?? parsed.rss ?? parsed.RDF ?? parsed) as Record<string, unknown>;
  const channel = (feed.channel ?? feed) as Record<string, unknown>;
  const rawEntries = feed.entry ?? channel.item ?? feed.item ?? [];
  const entries = asArray(rawEntries as Record<string, unknown> | Record<string, unknown>[])
    .map((entry) => parseEntry(entry, blogBaseUrl))
    .filter((entry): entry is FeedEntry => entry !== null);

  const nextLink = parseLinks(feed.link).find((link) => link.rel.toLowerCase() === "next");
  let nextUrl: string | null = null;
  if (nextLink) {
    try {
      const candidate = new URL(nextLink.href, feedUrl);
      if (candidate.origin !== new URL(feedUrl).origin) {
        throw new Error("Feed pagination link changed origin");
      }
      nextUrl = candidate.toString();
    } catch {
      nextUrl = null;
    }
  }

  return { entries, nextUrl };
}
