import { pathToFileURL } from "node:url";
import { fetchArticleText } from "../src/article";
import { getIngestStatus, runIngest } from "../src/ingest";
import { HttpError, sleep } from "../src/http";
import type { Env, IngestResult } from "../src/types";
import { extractArticleText } from "./html-text";
import { createRunnerEnv } from "./runner-env";

function integer(source: NodeJS.ProcessEnv, key: string, fallback: number, min = 1) {
  const value = source[key] === undefined ? fallback : Number(source[key]);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${key} must be an integer >= ${min}`);
  return value;
}

export async function ingestOnRunner(env: Env, source: NodeJS.ProcessEnv = process.env) {
  const maxBatches = integer(source, "INGEST_MAX_BATCHES", 10_000);
  const maxErrors = integer(source, "INGEST_MAX_ERROR_ATTEMPTS", 5);
  const maxLockWait = integer(source, "INGEST_MAX_LOCK_WAIT_SECONDS", 1200, 0) * 1000;
  const maxDuration = integer(source, "INGEST_MAX_DURATION_SECONDS", 19_800) * 1000;
  const startedAt = Date.now();
  let reset = source.RESET_BACKFILL === "true";
  const totals = { scanned: 0, inserted: 0, updated: 0, unchanged: 0, failed: 0, retrying: 0 };
  for (let batch = 1; batch <= maxBatches; batch += 1) {
    let errors = 0;
    let waitingSince: number | null = null;
    let result: IngestResult;
    for (;;) {
      try {
        result = await runIngest(env, {
          reset,
          readArticle: async (url, entry, bindings) => {
            // Print before fetching/embedding, so a crash still identifies it.
            console.log(`Processing: ${entry.title}\nURL: ${url}`);
            return fetchArticleText(url, entry, bindings, extractArticleText);
          },
        });
        break;
      } catch (error) {
        if (error instanceof HttpError && error.code === "ingestion_already_running") {
          waitingSince ??= Date.now();
          if (Date.now() - waitingSince >= maxLockWait) throw new Error("Ingestion lease remained locked; the saved checkpoint is intact");
          const progress = await getIngestStatus(env);
          console.log(`Waiting for lease: ${progress.remainingLockSeconds}s remaining; ${JSON.stringify(progress.current)}`);
          await sleep(20_000);
        } else {
          waitingSince = null;
          errors += 1;
          if (errors >= maxErrors) throw error;
          console.warn(`Batch ${batch} error ${errors}/${maxErrors}: ${error instanceof Error ? error.message : "Unknown error"}`);
          await sleep(Math.min(60_000, 1000 * 2 ** errors));
        }
      }
    }
    reset = false;
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result[key];
    console.log(`Batch ${batch}: ${JSON.stringify(result)}`);
    if (result.done) {
      console.log(`Completed: ${JSON.stringify(totals)}`);
      if (totals.failed) console.warn(`${totals.failed} article attempt(s) failed; details are saved in D1 for later retry.`);
      return { done: true, totals };
    }
    if (Date.now() - startedAt >= maxDuration || batch === maxBatches) {
      console.log(`Paused at the saved checkpoint: ${JSON.stringify(totals)}. The next run will continue.`);
      return { done: false, totals };
    }
    await sleep(1000);
  }
  throw new Error("Unreachable ingestion loop");
}

async function main() {
  const { env, checkEmbeddingService } = createRunnerEnv();
  // Fail configuration/deployment checks before taking a lock or moving a cursor.
  await env.DB.prepare("SELECT 1 AS ok").first();
  await checkEmbeddingService();
  await ingestOnRunner(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Ingestion failed");
    process.exitCode = 1;
  });
}
