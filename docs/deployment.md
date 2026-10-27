# Cloud-Only Deployment: GitHub Actions → Cloudflare Workers + D1 + Qdrant

This project does not require local Node.js or Wrangler installation, local configuration files, or a self-hosted server. Installation, type checking, tests, D1 schema migrations, and Worker deployment all run on **GitHub-hosted Actions runners**. The Worker, relational database, and vector store are entirely cloud-hosted.

> `wrangler.example.toml` is a public, version-controlled template. The production `wrangler.toml` is temporarily generated from that template and a GitHub Variable on the GitHub Actions runner; it is never committed to the repository.

## Architecture and Execution Stages

- **GitHub:** Single source of truth for code and CI/CD, using the `main` branch.
- **GitHub Actions – CI:** Offline type checking and unit tests; no Cloudflare credentials required.
- **GitHub Actions – Deploy Cloudflare Worker:** Runs validation, generates a temporary `wrangler.toml`, applies remote D1 migrations, deploys the Worker, and configures Worker Secrets.
- **Cloudflare Workers:** Serves the public search site, JSON API, Streamable HTTP `/mcp`, and Bearer-token-protected `/internal/ingest` endpoint.
- **Cloudflare D1:** Stores relational data for articles and chunks. **Workers AI:** Generates embeddings.
- **Qdrant Cloud:** Stores and searches vectors.
- **GitHub Actions – Refresh blog index:** Runs the ingestion engine on its Node.js cloud runner every two days. HTML parsing, text chunking, and D1/Qdrant writes run here; the Worker handles one small embedding input per request. No user's computer needs to remain on.

## Step 1: Create D1 in the Cloudflare Dashboard

1. Open Cloudflare Dashboard → Storage & databases → D1 SQL database.
2. Create a database named `pulipuli-facebook-knowledge`.
3. Copy its **Database ID** (UUID).

This ID is not an API key and does not itself grant access. The project nevertheless stores it as a GitHub Actions Variable instead of hard-coding it into Git so that public forks can use their own D1 databases.

## Step 2: Create a Qdrant Cloud Cluster

1. Sign in to Qdrant Cloud and create a free-tier cluster.
2. Save its **Cluster Endpoint** (the Qdrant REST API address, typically `https://<cluster-host>:6333`) and **API Key**. You will put these in GitHub Secrets, not in repository files or issues. Preserve the provided `https://` and `:6333`, and do not use the cluster management console URL.
3. Choose a collection name such as `pulipuli_facebook_chunks`. You will set it later as the GitHub Variable `QDRANT_COLLECTION`.
4. You do **not** need to create the collection manually. The ingestion engine creates it during initial ingestion using the embedding model's actual vector dimension.

## Step 3: Obtain a Cloudflare API Token and Account ID

1. Find your Account ID in the Cloudflare Dashboard.
2. Open your Cloudflare account's API Tokens page and create a **dedicated token scoped to the relevant account**. Creating a new Worker with `wrangler deploy` requires Workers product-level **Admin** permission; once the Worker exists, permissions can be narrowed to **Editor** for that Worker. Grant the D1 read/write permissions needed to run database migrations. Follow the permissions exposed by the current Cloudflare UI, and do not use a Global API Key.
3. Keep the token out of all Git-tracked files.

For authoritative guidance, see Cloudflare's [GitHub Actions CI/CD](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) and [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/) documentation.

## Step 4: Configure GitHub Repository Variables and Secrets

In this repository, navigate to **Settings → Secrets and variables → Actions**.

### Variables (Non-Secret)

- `D1_DATABASE_ID`: UUID of the D1 database created above.
- `QDRANT_COLLECTION`: For example, `pulipuli_blog_chunks`.
- `ENABLE_AUTO_DEPLOY`: Leave unset or `false` initially. After the first manual deployment succeeds, set `true` to deploy automatically following successful `main` branch CI runs.

### Secrets (Private)

- `CLOUDFLARE_API_TOKEN`: Dedicated deployment API token; also used by the refresh runner for D1 read/write access.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare Account ID (not inherently secret, but stored consistently with the other CI/CD credentials).
- `INGEST_TOKEN`: Cryptographically random Bearer Token of at least 32 bytes, used to protect `/internal/ingest`.
- `QDRANT_URL`: Qdrant cluster URL, including `https://`.
- `QDRANT_API_KEY`: Qdrant API Key.

The deployment workflow uploads the required GitHub Secrets as Cloudflare Worker Secrets. There is no need to manually re-enter those values in the Cloudflare Worker configuration.

**Important:** Do not paste `INGEST_TOKEN` into chats or public repositories. The production Worker and the scheduled GitHub workflow must use the same Secret.

## Cloudflare workers.dev first-time onboarding

A new Cloudflare account must register its account-wide `workers.dev` subdomain before `wrangler deploy` can publish a public URL. GitHub Actions is non-interactive and cannot respond to Wrangler's registration prompt. The deployment workflow now checks this **before applying D1 migrations**:

- If the account already has a workers.dev subdomain, deployment continues without changes. Do not set `WORKERS_DEV_SUBDOMAIN` to a different name.
- If no subdomain exists and `WORKERS_DEV_SUBDOMAIN` is set (for example, `pulipuli-facebook`), the workflow registers it using Cloudflare's API (`PUT /accounts/{account_id}/workers/subdomain`). This is an explicit, account-wide one-time change; the token needs **Workers Scripts Write** permission.
- If neither is true, deployment stops early with a clear GitHub Actions error explaining how to create the GitHub Variable or register it manually in Cloudflare **Workers & Pages**. The script never chooses a subdomain without being told to.

The name must be globally available. This is an account setting, **not the Worker name**; the published URL is `https://pulipuli-facebook-knowledge-mcp.<account-subdomain>.workers.dev`. After successful deployment the workflow writes the health and MCP URLs to its job summary.

Official documentation: [workers.dev routes](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) and [Cloudflare API: Create a Workers Subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/update/).

## Step 5: Perform the Initial Cloud Deployment

1. Confirm that [CI](../.github/workflows/ci.yml) has passed.
2. Go to GitHub repository → **Actions → Deploy Cloudflare Worker → Run workflow** and manually select `main`.
3. The workflow runs Node.js 22 setup and tests, verifies the D1 ID, generates `wrangler.toml`, verifies/registers the workers.dev account subdomain, applies remote `wrangler d1 migrations apply DB --remote`, runs `wrangler deploy`, and synchronizes Worker Secrets.
4. Find the public `*.workers.dev` address in the workflow logs (or use your custom domain). Opening `https://<worker-host>/health` should return `status: ok` and `database: ok`.
5. Optionally set `ENABLE_AUTO_DEPLOY=true` after the initial deployment. Only **successful CI runs triggered by pushes to the main branch** should initiate automatic deployment. Pull-request CI does not use production deployment credentials, preventing deployments from unreviewed branches.

**Caution:** This workflow modifies the **production remote D1 database**. Review schema migrations and backup strategies before merging database changes.

## Step 6: Configure Article Synchronization Every Two Days

Go to GitHub Repository → Settings → Secrets and variables → Actions:

- Retain the `INGEST_TOKEN` Secret configured above. Deployment and ingestion share the same value.
- Add an `INGEST_URL` Secret with the value `https://<worker-host>/internal/ingest`.

Open GitHub Actions → **Refresh blog index** → **Run workflow** to trigger the initial import manually (do not select the backfill reset option on the first run). The workflow installs its Node.js dependencies and runs `npm run ingest` on the GitHub-hosted runner. It reuses the existing production Cloudflare/Qdrant secrets and D1 cursor; no additional secret or local setup is required. The scheduled workflow checks UTC day parity every day at **02:17 UTC** and performs ingestion every two days. GitHub Actions scheduled runs may be delayed.

### Recovering from a Failed Backfill

- **Do not clear D1 or select `reset_backfill`** to resume a stopped import. Its checkpoint is persisted in D1.
- D1 permits at most 100 bound parameters per SQL statement. Every chunk INSERT row has 8 bound values, so each INSERT is limited to 12 chunks; this is covered by CI tests.
- The default is 1 article per runner batch with concurrency set to 1. Due failed-article retries share this budget.
- Blogger `/feeds/posts/default` URLs are automatically fetched through `/feeds/posts/summary?alt=json`, preserving pagination parameters and the saved offset. Full text is fetched from each article's HTML page and parsed by Cheerio on the Actions runner.
- The runner also splits full articles and serializes vectors for Qdrant. Each authenticated Worker call embeds just one text chunk. This removes full-article HTML/JSON processing from the Free Worker's small CPU budget, rather than repeatedly retrying platform error 1102.
- D1 writes go directly through its authenticated REST API. Related writes use one parameterized batch, preserving article/checkpoint transaction boundaries. Requests are paced to reduce API rate limiting. An ambiguous write failure is not automatically replayed by the REST adapter.
- GitHub Actions serializes ingest workflow runs. Active-lease polls have a separate, bounded 20-minute waiting window; systemic batch errors have a five-attempt retry budget. Persistent errors still fail with a useful message. The runner checks D1 access and the deployed embedding model before taking the lease.
- Individual article failures are stored in D1 `failed_articles` and are retried when due on later batches. Review the workflow's `failed` total and warning messages.
- GitHub Actions prints each article's **title** and **URL before processing starts**, then logs its result (`inserted`, `updated`, `unchanged`, or `failed`) and any error. Lease-conflict messages show the remaining wait and last reported progress.
- The protected `GET /internal/ingest/status` endpoint exposes the same progress for authorized checks while a request is active. Send `Authorization: Bearer <INGEST_TOKEN>`; do not put the token in a public URL or public log. No extra D1 migration is needed.
- Healthy batches renew their 120-second lease every 30 seconds. A terminated runner or Worker normally blocks recovery for at most 2 minutes after its last renewal. A batch that loses ownership cannot commit its checkpoint or clear its replacement's progress.
- Cursor, mode, and backfill-completion updates are saved transactionally. An article failure must be persisted before the cursor advances; a failure to save the retry record fails the batch instead.
- After updating, first run **Deploy Cloudflare Worker** on `main`, then start a **new** **Refresh blog index** run on `main` with `reset_backfill` disabled. Re-running a historical failed job uses its old revision. Existing indexed articles and the last committed cursor are retained; no D1 migration is needed for this change.
- The runner pauses cleanly at a persisted checkpoint after 330 minutes or 10,000 batches, before the workflow's 350-minute timeout. An unfinished backfill can continue on the next manual/scheduled run.

If the runner's initial embedding check returns 404, deploy the latest Worker first. A model mismatch also requires deploying the matching revision. If a small embedding request still reports 1102, check Worker invocation logs for `exceededCpu` or `exceededMemory`; that code alone does not identify which resource failed. The legacy direct `POST /internal/ingest` route remains available, but production backfills should use **Refresh blog index**.

Cloudflare documents the current [Worker resource limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 query/batch REST API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).

## Step 7: Verify the Website and ChatGPT MCP

- `GET https://<worker-host>/`: Search website.
- `GET https://<worker-host>/health`: Worker/D1 health check.
- `GET https://<worker-host>/api/search?q=Cloudflare&mode=keyword`: Initial keyword search test.
- `https://<worker-host>/mcp`: Add this endpoint to an MCP client supporting Streamable HTTP, then test `search_articles` and `get_article`.

Once historical backfilling is complete, test semantic and hybrid searches and review Workers AI/Qdrant quota usage.

## Security and Quotas

- A public GitHub repository should contain only templates and non-secret source code. API tokens, vector database keys, and ingestion tokens must be stored in GitHub Secrets.
- The generated `wrangler.toml` exists only on a temporary GitHub runner and is ignored by `.gitignore`. **No local operations are required.**
- Free-tier quotas for Cloudflare Workers, Workers AI, D1, Qdrant Cloud, and GitHub Actions may change. Validate the initial backfill in batches.
- `npm run dev` and `.dev.vars.example` remain available for optional contributor development but are **not required for production deployment**.

