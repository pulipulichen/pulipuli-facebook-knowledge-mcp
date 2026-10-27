import { getIngestStatus, runIngest } from "./ingest";
import { bearerToken, constantTimeEqual, errorResponse, HttpError, isRateLimited, jsonResponse, optionsResponse, readJsonBody, withCors } from "./http";
import { handleMcpRequest } from "./mcp";
import { articleToApi, getArticle, listRecentArticles, SearchError, searchArticles } from "./search";
import { INDEX_HTML } from "./web";
import { getConfig } from "./config";
import { embedTexts } from "./qdrant";
import type { Env, SearchMode } from "./types";

function methodNotAllowed(allow: string): Response {
  return jsonResponse({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405, { Allow: allow });
}

function rateLimitResponse(): Response {
  return jsonResponse(
    { error: { code: "rate_limited", message: "Too many requests. Please try again in a minute." } },
    429,
    { "Retry-After": "60" },
  );
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return optionsResponse();

  if (path === "/" || path === "/index.html") {
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    return new Response(INDEX_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      },
    });
  }

  if (path === "/health") {
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      return jsonResponse({ status: "ok", database: "ok", mcp: "/mcp" });
    } catch {
      return jsonResponse({ status: "degraded", database: "unavailable" }, 503);
    }
  }

  if (path === "/mcp") {
    if (!["GET", "POST", "DELETE"].includes(request.method)) return methodNotAllowed("GET, POST, DELETE, OPTIONS");
    if (isRateLimited(request)) return withCors(rateLimitResponse());
    return handleMcpRequest(request, env);
  }

  if (path === "/api/search") {
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    if (isRateLimited(request)) return withCors(rateLimitResponse());
    const query = url.searchParams.get("q") ?? "";
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 10 : Number.parseInt(rawLimit, 10);
    const modeValue = url.searchParams.get("mode") ?? "hybrid";
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return errorResponse("limit must be an integer between 1 and 50", 400, "invalid_limit");
    }
    if (!["hybrid", "keyword", "semantic"].includes(modeValue)) {
      return errorResponse("mode must be hybrid, keyword, or semantic", 400, "invalid_mode");
    }
    try {
      return jsonResponse(await searchArticles(env, query, limit, modeValue as SearchMode));
    } catch (error) {
      if (error instanceof SearchError) return errorResponse(error.message, error.status, error.code);
      return errorResponse("Search service is temporarily unavailable", 503, "search_unavailable");
    }
  }

  if (path === "/api/recent") {
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    if (isRateLimited(request)) return withCors(rateLimitResponse());
    const rawN = url.searchParams.get("n");
    const n = rawN === null ? 5 : Number(rawN);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return errorResponse("n must be an integer between 1 and 50", 400, "invalid_limit");
    }
    try {
      return jsonResponse(await listRecentArticles(env, n));
    } catch {
      return errorResponse("Recent articles are temporarily unavailable", 503, "recent_unavailable");
    }
  }

  if (path.startsWith("/api/articles/")) {
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    const rawId = path.slice("/api/articles/".length);
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return errorResponse("Article ID is not valid URL encoding", 400, "invalid_article_id");
    }
    if (!id || id.length > 2_000) return errorResponse("Article ID is invalid", 400, "invalid_article_id");
    const article = await getArticle(env, id);
    if (!article) return errorResponse("Article not found", 404, "article_not_found");
    return jsonResponse(articleToApi(article));
  }

  if (path === "/internal/ingest/embedding") {
    if (!["GET", "POST"].includes(request.method)) return methodNotAllowed("GET, POST, OPTIONS");
    const supplied = bearerToken(request);
    if (!env.INGEST_TOKEN || !supplied || !constantTimeEqual(supplied, env.INGEST_TOKEN)) {
      return errorResponse("Valid bearer token required", 401, "unauthorized");
    }
    const model = getConfig(env).embeddingModel;
    if (request.method === "GET") return jsonResponse({ model, maxTextChars: 3000 });
    const body = await readJsonBody(request, 16_384) as { text?: unknown } | null;
    if (typeof body?.text !== "string" || !body.text.trim() || Array.from(body.text).length > 3000) {
      return errorResponse("text must contain 1 to 3000 characters", 400, "invalid_embedding_text");
    }
    // A single small vector per invocation keeps JSON/AI processing within the
    // Free Worker's CPU budget. HTML, chunking, and Qdrant writes run in Actions.
    return jsonResponse({ model, data: await embedTexts(env, [body.text]) });
  }

  if (path === "/internal/ingest/status") {
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    const supplied = bearerToken(request);
    if (!env.INGEST_TOKEN || !supplied || !constantTimeEqual(supplied, env.INGEST_TOKEN)) {
      return errorResponse("Valid bearer token required", 401, "unauthorized");
    }
    return jsonResponse(await getIngestStatus(env));
  }

  if (path === "/internal/ingest") {
    if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS");
    const expected = env.INGEST_TOKEN;
    const supplied = bearerToken(request);
    if (!expected || !supplied || !constantTimeEqual(supplied, expected)) {
      return errorResponse("Valid bearer token required", 401, "unauthorized");
    }
    try {
      const body = await readJsonBody(request);
      const reset = Boolean(body && typeof body === "object" && "reset" in body && (body as { reset?: unknown }).reset === true);
      return jsonResponse(await runIngest(env, { reset }));
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.code === "ingestion_already_running") {
          const progress = await getIngestStatus(env).catch(() => null);
          return jsonResponse(
            { error: { code: error.code, message: error.message }, progress },
            409,
            { "Retry-After": "20" },
          );
        }
        return errorResponse(error.message, error.status, error.code);
      }
      return errorResponse(error instanceof Error ? error.message : "Ingestion failed", 500, "ingestion_failed");
    }
  }

  return errorResponse("Route not found", 404, "not_found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withCors(await route(request, env));
    } catch (error) {
      if (error instanceof HttpError) return withCors(errorResponse(error.message, error.status, error.code));
      return withCors(errorResponse("Unexpected server error", 500, "internal_error"));
    }
  },
};

