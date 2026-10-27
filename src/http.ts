const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID";
const EXPOSED_HEADERS = "Mcp-Session-Id, WWW-Authenticate";

export function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function optionsResponse(): Response {
  return withCors(new Response(null, { status: 204 }));
}

export function errorResponse(message: string, status = 500, code = "internal_error"): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export async function readJsonBody(request: Request, maxBytes = 8_192): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) throw new HttpError(413, "Request body is too large", "body_too_large");

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new HttpError(413, "Request body is too large", "body_too_large");
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_json");
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "request_error") {
    super(message);
    this.name = "HttpError";
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

interface RateBucket {
  startedAt: number;
  count: number;
}

const rateBuckets = new Map<string, RateBucket>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const MAX_BUCKETS = 10_000;

export function isRateLimited(request: Request): boolean {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `${address}:${Math.floor(Date.now() / RATE_WINDOW_MS)}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;

  if (rateBuckets.size > MAX_BUCKETS) {
    for (const [bucketKey, item] of rateBuckets) {
      if (now - item.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(bucketKey);
    }
    while (rateBuckets.size > MAX_BUCKETS) {
      const oldest = rateBuckets.keys().next().value;
      if (!oldest) break;
      rateBuckets.delete(oldest);
    }
  }

  return bucket.count > RATE_LIMIT;
}

export function excerpt(text: string, maxLength = 260): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength).trimEnd()}…`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stableUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function splitIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const end = Math.min(chars.length, start + chunkSize);
    const chunk = chars.slice(start, end).join("").trim();
    if (chunk) chunks.push(chunk);
    if (end === chars.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}

export async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit = {}, retries = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("upstream timeout"), 20_000);
      let response: Response;
      try {
        response = await fetch(input, { ...init, signal: init.signal ?? controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === retries) {
        return response;
      }
      const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
      const delay = Number.isFinite(retryAfter)
        ? Math.min(10_000, Math.max(0, retryAfter * 1_000))
        : Math.min(8_000, 500 * 2 ** attempt + Math.random() * 300);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 500 * 2 ** attempt + Math.random() * 300)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Upstream request failed");
}
