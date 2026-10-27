import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { getConfig } from "../src/config";
import { fetchWithRetry } from "../src/http";
import type { Env } from "../src/types";
import { createD1RestBinding } from "./d1-rest";

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key]?.trim();
  if (!value) throw new Error(`Missing Actions configuration: ${key}`);
  return value;
}

export function createRunnerEnv(source: NodeJS.ProcessEnv = process.env) {
  // Use the exact same public settings as deployment, without a local server.
  const template = parse(readFileSync(new URL("../wrangler.example.toml", import.meta.url), "utf8"));
  const vars = template.vars as Record<string, string>;
  const accountId = required(source, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = required(source, "CLOUDFLARE_API_TOKEN");
  const databaseId = required(source, "D1_DATABASE_ID");
  const ingestToken = required(source, "INGEST_TOKEN");
  const ingestUrl = new URL(required(source, "INGEST_URL"));
  if (ingestUrl.protocol !== "https:") throw new Error("INGEST_URL must use HTTPS");
  ingestUrl.pathname = `${ingestUrl.pathname.replace(/\/+$/, "")}/embedding`;
  ingestUrl.search = "";
  ingestUrl.hash = "";
  const env = {
    ...vars,
    DB: createD1RestBinding({ accountId, apiToken, databaseId }),
    QDRANT_URL: required(source, "QDRANT_URL"),
    QDRANT_API_KEY: required(source, "QDRANT_API_KEY"),
    QDRANT_COLLECTION: source.QDRANT_COLLECTION?.trim() || "pulipuli_blog",
  } as Env;
  const model = getConfig(env).embeddingModel;
  const request = async (text?: string) => {
    const response = await fetchWithRetry(ingestUrl, {
      method: text === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${ingestToken}`, "Content-Type": "application/json" },
      ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
      redirect: "error",
    });
    if (!response.ok) {
      const diagnostic = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
      throw new Error(`Embedding service returned HTTP ${response.status}; CF-Ray ${response.headers.get("cf-ray") ?? "unavailable"}; ${diagnostic}${response.status === 404 ? ". Deploy the current Worker before running ingestion." : ""}`);
    }
    const data = await response.json() as { model?: string; data?: number[][] };
    if (data.model !== model) throw new Error("Runner and deployed Worker embedding models differ; deploy the matching revision first");
    return data;
  };
  env.AI = {
    async run(requestedModel, input) {
      if (requestedModel !== model || !Array.isArray(input.text) || input.text.some((text) => typeof text !== "string")) {
        throw new Error("Invalid runner embedding request");
      }
      const vectors: number[][] = [];
      for (const text of input.text as string[]) {
        // Each call has its own small Worker CPU budget, even for long articles.
        const result = await request(text);
        if (!Array.isArray(result.data) || result.data.length !== 1 || !Array.isArray(result.data[0])) {
          throw new Error("Embedding service returned an invalid vector");
        }
        vectors.push(result.data[0]);
      }
      return { data: vectors };
    },
  };
  return { env, checkEmbeddingService: () => request() };
}
