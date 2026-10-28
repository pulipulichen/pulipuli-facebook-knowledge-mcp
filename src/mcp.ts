import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { articleToApi, getArticle, listRecentArticles, searchArticles } from "./search";
import { withCors } from "./http";
import type { Env, SearchMode } from "./types";

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const server = new McpServer({
    name: "pulipuli-facebook-knowledge-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "search_facebook_posts",
    {
      description: "Search ONLY public Facebook posts (not blog articles) from Pulipuli's Facebook page (布丁布丁吃什麼？) by keyword or semantic similarity. Returns titles, dates, tags, excerpts, scores, and original Facebook post URLs.",
      inputSchema: {
        query: z.string().min(2).max(300),
        limit: z.number().int().min(1).max(20).optional(),
        mode: z.enum(["hybrid", "keyword", "semantic"]).optional(),
      },
    },
    async ({ query, limit, mode }) => {
      try {
        const result = await searchArticles(env, query, limit, (mode ?? "hybrid") as SearchMode);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Search failed";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  server.registerTool(
    "list_recent_facebook_posts",
    {
      description: "List the N most recently published indexed Facebook posts (not blog articles) from Pulipuli Facebook page (default 5), newest first, without a search query or embedding request. Returns titles, original Facebook post URLs, publication dates, tags, and excerpts.",
      inputSchema: { n: z.number().int().min(1).max(50).optional() },
    },
    async ({ n }) => {
      try {
        const result = await listRecentArticles(env, n);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Recent Facebook posts lookup failed";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  server.registerTool(
    "get_facebook_post",
    {
      description: "Read the indexed text and source metadata for one public Facebook post (not a blog article) using its result ID or canonical post URL.",
      inputSchema: { id: z.string().min(1).max(2_000) },
    },
    async ({ id }) => {
      try {
        const article = await getArticle(env, id);
        if (!article) return { isError: true, content: [{ type: "text", text: "Facebook post not found" }] };
        return { content: [{ type: "text", text: JSON.stringify(articleToApi(article), null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Facebook post lookup failed";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request));
}
