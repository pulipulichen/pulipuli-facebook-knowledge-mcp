import { sleep } from "../src/http";

type Parameter = string | number | null;
interface Query { sql: string; params: Parameter[] }
interface QueryResult {
  success?: boolean;
  results?: Record<string, unknown>[];
  meta?: Record<string, unknown>;
  error?: string;
}

/** Adapt the existing ingestion SQL to D1's REST API on the Actions runner. */
export function createD1RestBinding(options: {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetcher?: typeof fetch;
  minIntervalMs?: number;
}): D1Database {
  const { accountId, databaseId, apiToken, fetcher = fetch, minIntervalMs = 300 } = options;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  let nextRequestAt = 0;
  async function query(queries: Query[], batch: boolean): Promise<QueryResult[]> {
    for (let attempt = 0; ; attempt += 1) {
      // Stay below the Cloudflare API rate limit, including heartbeat queries.
      const requestAt = Math.max(Date.now(), nextRequestAt);
      nextRequestAt = requestAt + minIntervalMs;
      await sleep(requestAt - Date.now());
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(batch ? { batch: queries } : queries[0]),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 429 && attempt < 3) {
        const delay = Number(response.headers.get("retry-after") ?? "5");
        await response.body?.cancel();
        await sleep(Math.min(60, Math.max(1, Number.isFinite(delay) ? delay : 5)) * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`D1 API returned HTTP ${response.status}; check CLOUDFLARE_API_TOKEN D1 permissions and database configuration`);
      const data = await response.json() as { success?: boolean; result?: QueryResult[]; errors?: Array<{ code?: number; message?: string }> };
      if (!data.success || !Array.isArray(data.result) || data.result.length !== queries.length || data.result.some((item) => item.success === false)) {
        const message = data.errors?.map((item) => `${item.code ?? ""} ${item.message ?? ""}`).join("; ")
          || data.result?.find((item) => item.success === false)?.error || "Invalid D1 API response";
        throw new Error(`D1 query failed: ${message.slice(0, 500)}`);
      }
      return data.result;
    }
    // Do not blindly retry writes on network/5xx errors: a committed response
    // may have been lost. The next ingestion batch resumes from persisted state.
  }
  class Statement {
    constructor(readonly sql: string, readonly params: Parameter[] = []) {}
    bind(...params: Parameter[]) { return new Statement(this.sql, params); }
    async all() { return (await query([this], false))[0]!; }
    async run() { return this.all(); }
    async first(column?: string) {
      const row = (await this.all()).results?.[0];
      return column ? row?.[column] ?? null : row ?? null;
    }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    // One REST batch preserves the transaction boundaries used by DB.batch().
    batch: (statements: Statement[]) => query(statements, true),
  } as unknown as D1Database;
}
