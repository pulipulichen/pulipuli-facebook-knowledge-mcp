import { HttpError } from "./http";
import type { Env } from "./types";

// A terminated Worker cannot run finally. Keep its abandoned lease short,
// while renewing healthy requests that are waiting for upstream services.
export const INGEST_LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30_000;

export interface IngestLease {
  token: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export async function acquireIngestLease(env: Env): Promise<IngestLease> {
  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare("INSERT OR IGNORE INTO sync_lock (id, token, expires_at) VALUES (1, NULL, 0)").run();
  const result = await env.DB.prepare(`
    UPDATE sync_lock SET token = ?, expires_at = ?
    WHERE id = 1 AND (token IS NULL OR expires_at <= ?)
  `).bind(token, now + INGEST_LEASE_SECONDS, now).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new HttpError(409, "An ingestion run is already active", "ingestion_already_running");
  }

  let lost: Error | null = null;
  let pending: Promise<void> | null = null;
  const assertOwned = async (): Promise<void> => {
    if (lost) throw lost;
    if (!pending) {
      pending = (async () => {
        const time = Math.floor(Date.now() / 1_000);
        const renewed = await env.DB.prepare(`
          UPDATE sync_lock SET expires_at = ?
          WHERE id = 1 AND token = ? AND expires_at > ?
        `).bind(time + INGEST_LEASE_SECONDS, token, time).run();
        if ((renewed.meta?.changes ?? 0) === 0) {
          throw new HttpError(409, "Ingestion lease expired or changed owner; resume from the saved checkpoint", "ingestion_lease_lost");
        }
      })().catch((error: unknown) => {
        lost = error instanceof Error ? error : new Error("Could not renew ingestion lease");
        throw lost;
      }).finally(() => { pending = null; });
    }
    await pending;
  };
  const timer = setInterval(() => { void assertOwned().catch(() => undefined); }, HEARTBEAT_MS);

  return {
    token,
    assertOwned,
    async release() {
      clearInterval(timer);
      await pending?.catch(() => undefined);
      // Both cleanup operations are conditional on ownership. An old request
      // must not erase the progress or lock belonging to its replacement.
      await env.DB.prepare(`
        UPDATE sync_state SET value = '', updated_at = ?
        WHERE key = 'ingest_active_articles'
          AND EXISTS (SELECT 1 FROM sync_lock WHERE id = 1 AND token = ?)
      `).bind(new Date().toISOString(), token).run().catch(() => undefined);
      await env.DB.prepare("UPDATE sync_lock SET token = NULL, expires_at = 0 WHERE id = 1 AND token = ?")
        .bind(token).run();
    },
  };
}
