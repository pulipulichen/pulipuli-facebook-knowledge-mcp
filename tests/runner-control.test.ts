import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestOnRunner } from "../scripts/ingest";
import { getIngestStatus, runIngest } from "../src/ingest";
import { HttpError } from "../src/http";
import type { Env, IngestResult } from "../src/types";

vi.mock("../src/ingest", () => ({ runIngest: vi.fn(), getIngestStatus: vi.fn() }));
vi.mock("../src/http", async (original) => ({ ...await original<typeof import("../src/http")>(), sleep: vi.fn(async () => undefined) }));
const success: IngestResult = { mode: "backfill", done: true, scanned: 1, inserted: 1, updated: 0, unchanged: 0, failed: 0, retrying: 0, errors: [], articles: [] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(getIngestStatus).mockResolvedValue({ locked: true, lockExpiresAt: "soon", remainingLockSeconds: 120, current: null });
});
afterEach(() => vi.restoreAllMocks());

describe("runner recovery and checkpoints", () => {
  it("keeps lock polling separate from the upstream-error budget", async () => {
    for (let n = 0; n < 25; n += 1) vi.mocked(runIngest).mockRejectedValueOnce(new HttpError(409, "active", "ingestion_already_running"));
    vi.mocked(runIngest).mockResolvedValueOnce(success);
    expect(await ingestOnRunner({} as Env, { INGEST_MAX_ERROR_ATTEMPTS: "1" })).toMatchObject({ done: true });
    expect(runIngest).toHaveBeenCalledTimes(26);
  });

  it("bounds lock waits and persistent systemic errors", async () => {
    vi.mocked(runIngest).mockRejectedValueOnce(new HttpError(409, "active", "ingestion_already_running"));
    await expect(ingestOnRunner({} as Env, { INGEST_MAX_LOCK_WAIT_SECONDS: "0" })).rejects.toThrow("remained locked");
    vi.mocked(runIngest).mockRejectedValue(new Error("D1 unavailable"));
    await expect(ingestOnRunner({} as Env, { INGEST_MAX_ERROR_ATTEMPTS: "2" })).rejects.toThrow("D1 unavailable");
    expect(runIngest).toHaveBeenCalledTimes(3);
  });

  it("resets only the first successful batch and resumes subsequent batches", async () => {
    vi.mocked(runIngest).mockResolvedValueOnce({ ...success, done: false }).mockResolvedValueOnce(success);
    expect(await ingestOnRunner({} as Env, { RESET_BACKFILL: "true" })).toMatchObject({ done: true, totals: { scanned: 2, inserted: 2 } });
    expect(vi.mocked(runIngest).mock.calls.map(([, options]) => options?.reset)).toEqual([true, false]);
  });

  it("pauses cleanly at a saved checkpoint instead of failing an unfinished backfill", async () => {
    vi.mocked(runIngest).mockResolvedValueOnce({ ...success, done: false });
    expect(await ingestOnRunner({} as Env, { INGEST_MAX_BATCHES: "1" })).toMatchObject({ done: false, totals: { inserted: 1 } });
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining("Paused at the saved checkpoint"));
  });
});
