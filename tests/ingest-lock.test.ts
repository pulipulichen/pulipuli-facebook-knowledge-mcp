import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireIngestLease, INGEST_LEASE_SECONDS } from "../src/ingest-lock";
import { getIngestStatus } from "../src/ingest";
import type { Env } from "../src/types";
import { sqliteD1 } from "./helpers/sqlite-d1";

let store: ReturnType<typeof sqliteD1>;
let env: Env;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  store = sqliteD1();
  env = { DB: store.db } as Env;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); store.sqlite.close(); });

describe("renewable D1 ingestion lease", () => {
  it("excludes overlapping requests and releases after normal completion", async () => {
    const lease = await acquireIngestLease(env);
    await expect(acquireIngestLease(env)).rejects.toMatchObject({ status: 409, code: "ingestion_already_running" });
    expect(await getIngestStatus(env)).toMatchObject({ locked: true, remainingLockSeconds: INGEST_LEASE_SECONDS });
    await lease.release();
    expect(await getIngestStatus(env)).toMatchObject({ locked: false, remainingLockSeconds: 0 });
    const next = await acquireIngestLease(env);
    await next.release();
  });

  it("renews a healthy long request while upstream services are pending", async () => {
    const lease = await acquireIngestLease(env);
    await vi.advanceTimersByTimeAsync(180_000);
    await lease.assertOwned();
    expect(await getIngestStatus(env)).toMatchObject({ locked: true, remainingLockSeconds: INGEST_LEASE_SECONDS });
    await expect(acquireIngestLease(env)).rejects.toMatchObject({ status: 409 });
    await lease.release();
  });

  it("recovers at expiry after a crash and fences the previous owner", async () => {
    const abandoned = await acquireIngestLease(env);
    // Jump the clock without running timers, simulating a terminated isolate.
    vi.setSystemTime(Date.now() + INGEST_LEASE_SECONDS * 1_000);
    const replacement = await acquireIngestLease(env);
    const progress = JSON.stringify({ token: replacement.token, startedAt: new Date().toISOString(), articles: [{ title: "Replacement", url: "https://blog.pulipuli.info/new.html" }] });
    store.sqlite.prepare("INSERT INTO sync_state VALUES ('ingest_active_articles', ?, ?)").run(progress, new Date().toISOString());
    await expect(abandoned.assertOwned()).rejects.toMatchObject({ code: "ingestion_lease_lost" });
    await abandoned.release();
    expect(await getIngestStatus(env)).toMatchObject({ locked: true, current: { articles: [{ title: "Replacement" }] } });
    expect(store.sqlite.prepare("SELECT token FROM sync_lock").get()?.token).toBe(replacement.token);
    await replacement.release();
    expect(store.sqlite.prepare("SELECT value FROM sync_state").get()?.value).toBe("");
  });

  it("does not renew an already expired lease or report another owner's progress", async () => {
    const lease = await acquireIngestLease(env);
    store.sqlite.prepare("INSERT INTO sync_state VALUES ('ingest_active_articles', ?, '')").run(JSON.stringify({ token: "stale-owner", startedAt: "old", articles: [{ title: "Old", url: "old" }] }));
    expect((await getIngestStatus(env)).current).toBeNull();
    vi.setSystemTime(Date.now() + (INGEST_LEASE_SECONDS + 1) * 1_000);
    await expect(lease.assertOwned()).rejects.toMatchObject({ code: "ingestion_lease_lost" });
    await lease.release();
  });
});
