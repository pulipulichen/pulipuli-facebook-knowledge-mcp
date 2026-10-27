import { fetchWithRetry, normalizeText } from "./http";
import { getConfig } from "./config";
import type { Env, FeedEntry } from "./types";

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface RobotsCacheEntry {
  expiresAt: number;
  rules: RobotsRule[];
}

const robotsCache = new Map<string, RobotsCacheEntry>();
const CONTENT_SELECTORS = [
  "[itemprop='articleBody']",
  ".post-body",
  ".entry-content",
  "article",
  "main",
  "body",
];
const REMOVE_SELECTOR = "script,style,noscript,svg,nav,header,footer,aside,form,button,iframe";

export function canonicalizeUrl(value: string, baseUrl: string): string {
  const url = new URL(value, baseUrl);
  url.hash = "";
  // Collect first so deleting parameters cannot skip entries during iteration.
  // URLSearchParams.forEach works without iterable DOM type declarations.
  const trackingKeys: string[] = [];
  url.searchParams.forEach((_value, key) => {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) trackingKeys.push(key);
  });
  for (const key of trackingKeys) url.searchParams.delete(key);
  return url.toString();
}

function ruleMatches(rulePath: string, target: string): boolean {
  const anchored = rulePath.endsWith("$");
  const path = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = path
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(target);
  } catch {
    return target.startsWith(rulePath);
  }
}

function parseRobots(text: string): RobotsRule[] {
  const selected: RobotsRule[] = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  const flush = () => {
    if (agents.some((agent) => agent === "*")) selected.push(...rules);
    agents = [];
    rules = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0]?.trim() ?? "";
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "user-agent") {
      if (rules.length) flush();
      agents.push(value.toLowerCase());
    } else if ((name === "allow" || name === "disallow") && value && agents.length) {
      rules.push({ allow: name === "allow", path: value });
    }
  }
  flush();
  return selected;
}

async function robotsRules(origin: string): Promise<RobotsRule[]> {
  const cached = robotsCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached.rules;

  const response = await fetchWithRetry(new URL("/robots.txt", origin), {
    headers: { "User-Agent": "PulipuliBlogKnowledgeBot/0.1" },
  }, 1);
  let rules: RobotsRule[] = [];
  if (response.status === 404) {
    rules = [];
  } else if (response.ok) {
    rules = parseRobots((await response.text()).slice(0, 100_000));
  } else {
    throw new Error(`Could not check robots.txt (HTTP ${response.status})`);
  }

  robotsCache.set(origin, { expiresAt: Date.now() + 6 * 60 * 60 * 1_000, rules });
  return rules;
}

async function assertAllowedByRobots(url: URL): Promise<void> {
  const rules = await robotsRules(url.origin);
  const target = `${url.pathname}${url.search}`;
  const matches = rules.filter((rule) => ruleMatches(rule.path, target));
  if (matches.length === 0) return;
  matches.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  if (!matches[0]?.allow) throw new Error("robots.txt disallows this article path");
}

async function extractReadableText(html: string): Promise<string> {
  const candidates = new Map<string, { pieces: string[]; total: number }>();
  let rewriter = new HTMLRewriter()
    .on(REMOVE_SELECTOR, { element(element) { element.remove(); } });
  for (const selector of CONTENT_SELECTORS) {
    const candidate = { pieces: [] as string[], total: 0 };
    candidates.set(selector, candidate);
    rewriter = rewriter.on(selector, {
      text(text) {
        if (candidate.total >= 120_000) return;
        candidate.pieces.push(text.text);
        candidate.total += text.text.length;
      },
    });
  }
  const transformed = rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  await transformed.text();

  let best = "";
  for (const selector of CONTENT_SELECTORS) {
    const candidate = normalizeText(candidates.get(selector)?.pieces.join(" ") ?? "");
    if (candidate.length > best.length) best = candidate;
    if (candidate.length >= 300 && selector !== "body") return candidate;
  }
  return best;
}

export async function fetchArticleText(
  urlValue: string,
  entry: FeedEntry,
  env: Env,
  extractText: (html: string) => string | Promise<string> = extractReadableText,
): Promise<string> {
  const config = getConfig(env);
  const url = new URL(urlValue);
  const blogOrigin = new URL(config.blogBaseUrl).origin;
  if (url.origin !== blogOrigin) throw new Error("Article URL is outside the configured blog origin");
  await assertAllowedByRobots(url);

  const response = await fetchWithRetry(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "User-Agent": "PulipuliBlogKnowledgeBot/0.1 (+https://github.com/pulipulichen/pulipuli-blog-knowledge-mcp)",
    },
  });
  if (!response.ok) throw new Error(`Article request returned HTTP ${response.status}`);
  const finalUrl = response.url ? new URL(response.url) : url;
  if (finalUrl.origin !== blogOrigin) throw new Error("Article redirected outside the configured blog origin");

  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (contentLength > config.maxHtmlChars) throw new Error("Article HTML exceeded the 2 MB limit");
  const html = await response.text();
  if (html.length > config.maxHtmlChars) throw new Error("Article HTML exceeded the 2 MB limit");
  if (!/html|xhtml/i.test(response.headers.get("content-type") ?? "text/html")) {
    throw new Error("Article URL did not return HTML");
  }

  const best = await extractText(html);
  if (best.length < 80) {
    throw new Error(`Could not extract readable article text: ${entry.title.slice(0, 100)}`);
  }
  return best.slice(0, config.maxFullTextChars);
}

