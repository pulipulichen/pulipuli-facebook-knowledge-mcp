import { getConfig } from "./config";
import { fetchWithRetry, stableUuid } from "./http";
import type { Env } from "./types";

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: {
    articleId: string;
    contentHash: string;
    embeddingModel: string;
    ordinal: number;
  };
}

export interface VectorHit {
  id: string;
  score: number;
  articleId: string;
  ordinal: number;
}

interface QdrantEnvelope<T> {
  status?: string;
  result?: T;
  time?: number;
  error?: string;
}

function qdrantSettings(env: Env): { baseUrl: string; apiKey: string; collection: string } {
  if (!env.QDRANT_URL || !env.QDRANT_API_KEY) {
    throw new Error("Qdrant is not configured. Set QDRANT_URL and QDRANT_API_KEY as Worker secrets.");
  }
  return {
    baseUrl: env.QDRANT_URL.replace(/\/+$/, ""),
    apiKey: env.QDRANT_API_KEY,
    collection: env.QDRANT_COLLECTION || "pulipuli_blog",
  };
}

async function qdrantRequest<T>(env: Env, path: string, init: RequestInit = {}): Promise<{ response: Response; data: QdrantEnvelope<T> | null }> {
  const settings = qdrantSettings(env);
  const response = await fetchWithRetry(`${settings.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "api-key": settings.apiKey,
      ...(init.headers ?? {}),
    },
  });
  let data: QdrantEnvelope<T> | null = null;
  try {
    data = await response.json() as QdrantEnvelope<T>;
  } catch {
    data = null;
  }
  return { response, data };
}

function collectionPath(collection: string): string {
  return `/collections/${encodeURIComponent(collection)}`;
}

export async function ensureCollection(env: Env, vectorSize: number): Promise<void> {
  const { collection } = qdrantSettings(env);
  const path = collectionPath(collection);
  const existing = await qdrantRequest<Record<string, unknown>>(env, path);

  if (existing.response.ok) {
    const config = existing.data?.result as Record<string, unknown> | undefined;
    const params = config?.config as Record<string, unknown> | undefined;
    const collectionParams = params?.params as Record<string, unknown> | undefined;
    const vectors = collectionParams?.vectors as Record<string, unknown> | undefined;
    const size = typeof vectors?.size === "number" ? vectors.size : undefined;
    if (size !== undefined && size !== vectorSize) {
      throw new Error(`Qdrant collection vector size is ${size}, but Workers AI returned ${vectorSize}. Create a new collection before changing embedding models.`);
    }
    return;
  }
  if (existing.response.status !== 404) {
    throw new Error(`Could not inspect Qdrant collection (HTTP ${existing.response.status})`);
  }

  const created = await qdrantRequest(env, path, {
    method: "PUT",
    body: JSON.stringify({ vectors: { size: vectorSize, distance: "Cosine" } }),
  });
  if (created.response.ok) return;

  // Two first-ingest requests can race to create the collection. Accept the
  // losing request only if the collection now exists and has the right size.
  if (created.response.status === 409) {
    const raced = await qdrantRequest<Record<string, unknown>>(env, path);
    if (raced.response.ok) {
      const config = raced.data?.result as Record<string, unknown> | undefined;
      const params = config?.config as Record<string, unknown> | undefined;
      const collectionParams = params?.params as Record<string, unknown> | undefined;
      const vectors = collectionParams?.vectors as Record<string, unknown> | undefined;
      if (typeof vectors?.size === "number" && vectors.size === vectorSize) return;
    }
  }
  throw new Error(`Could not create Qdrant collection (HTTP ${created.response.status})`);
}

export async function makeVectorId(articleId: string, contentHash: string, ordinal: number, embeddingModel: string): Promise<string> {
  return stableUuid(`${articleId}:${contentHash}:${embeddingModel}:${ordinal}`);
}

export async function upsertPoints(env: Env, points: VectorPoint[]): Promise<void> {
  if (points.length === 0) return;
  const { collection } = qdrantSettings(env);
  const path = `${collectionPath(collection)}/points?wait=true`;
  for (let start = 0; start < points.length; start += 64) {
    const batch = points.slice(start, start + 64);
    const result = await qdrantRequest(env, path, {
      method: "PUT",
      body: JSON.stringify({ points: batch }),
    });
    if (!result.response.ok) {
      throw new Error(`Qdrant vector upsert failed (HTTP ${result.response.status})`);
    }
  }
}

export async function deletePoints(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { collection } = qdrantSettings(env);
  const path = `${collectionPath(collection)}/points/delete?wait=true`;
  for (let start = 0; start < ids.length; start += 100) {
    const result = await qdrantRequest(env, path, {
      method: "POST",
      body: JSON.stringify({ points: ids.slice(start, start + 100) }),
    });
    if (!result.response.ok) {
      throw new Error(`Qdrant vector cleanup failed (HTTP ${result.response.status})`);
    }
  }
}

export async function searchVectors(env: Env, vector: number[], limit: number): Promise<VectorHit[]> {
  const { collection } = qdrantSettings(env);
  const path = `${collectionPath(collection)}/points/query`;
  const result = await qdrantRequest<{ points?: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }> }>(env, path, {
    method: "POST",
    body: JSON.stringify({ query: vector, limit, with_payload: true, with_vector: false }),
  });
  if (result.response.status === 404) return [];
  if (!result.response.ok) throw new Error(`Qdrant vector search failed (HTTP ${result.response.status})`);

  const hits = result.data?.result?.points ?? [];
  return hits.flatMap((point) => {
    const articleId = point.payload?.articleId;
    if (typeof articleId !== "string" || typeof point.score !== "number") return [];
    return [{
      id: String(point.id),
      score: point.score,
      articleId,
      ordinal: typeof point.payload?.ordinal === "number" ? point.payload.ordinal : 0,
    }];
  });
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const config = getConfig(env);
  const raw = await env.AI.run(config.embeddingModel, { text: texts, truncate_inputs: true });
  if (!raw || typeof raw !== "object") throw new Error("Workers AI returned an invalid embedding response");

  const value = raw as { data?: unknown; embeddings?: unknown; shape?: unknown };
  const data = value.data ?? value.embeddings;
  if (!Array.isArray(data)) throw new Error("Workers AI response did not contain embedding data");

  let vectors: number[][];
  if (data.length > 0 && typeof data[0] === "number") {
    if (texts.length !== 1) throw new Error("Workers AI returned a flat vector for a batch request");
    vectors = [data as number[]];
  } else {
    vectors = data as number[][];
  }
  if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.some((n) => typeof n !== "number" || !Number.isFinite(n)))) {
    throw new Error("Workers AI returned an unexpected number or shape of embeddings");
  }
  return vectors;
}
