# Configuration Storage (Cloud-Only)

The production environment is managed entirely through **GitHub, GitHub Actions, the Cloudflare Dashboard, and Qdrant Cloud**. Users do not need to clone the repository locally, install Wrangler, or maintain a local `wrangler.toml`.

## Public GitHub Repository (Version-Controlled)

- `wrangler.example.toml`: Public example of Cloudflare Worker configuration, D1/AI bindings, and non-secret runtime settings. Its `database_id` is a placeholder.
- `config.example.json`: Public reference example for application settings.
- `.dev.vars.example`: Optional local-development example for contributors; **not used in production**.
- `.github/workflows/ci.yml`: Type checking and unit tests for pushes and pull requests.
- `.github/workflows/deploy.yml`: Initial manual deployment and optional automatic deployment after successful CI on `main`. Generates a temporary configuration file, applies remote D1 migrations, deploys the Worker, and synchronizes Secrets.
- `.github/workflows/ingest.yml`: Article ingestion every two days and resumable historical backfills.
- `scripts/ingest.ts`: Cloud runner orchestration, separate lock/error retry budgets, progress logs, and clean checkpoint pauses.
- `scripts/d1-rest.ts`, `scripts/runner-env.ts`, and `scripts/html-text.ts`: D1 REST adapter, single-text Worker embedding client, and runner-side HTML extraction.

Do not store real tokens in the public repository. Although a D1 UUID is not itself a secret, this project keeps it in a GitHub Variable so forks can provide their own database ID.

## GitHub Actions Variables (Non-Secret)

GitHub Repository → Settings → Secrets and variables → Actions → **Variables**:

- `D1_DATABASE_ID` (**required**): UUID of the Cloudflare D1 database.
- `QDRANT_COLLECTION` (**required**): Qdrant collection name, such as `pulipuli_blog_chunks`.
- `ENABLE_AUTO_DEPLOY` (**optional**): Set to `true` to allow automatic deployment when CI succeeds following a push to `main`. Leave empty or `false` until the initial deployment succeeds.

During deployment, GitHub Actions replaces the placeholder in `wrangler.example.toml` with `D1_DATABASE_ID` to generate a temporary `wrangler.toml`. That file is ignored by `.gitignore` and exists only on the GitHub runner for that run.

## GitHub Actions Secrets (Confidential)

GitHub Repository → Settings → Secrets and variables → Actions → **Secrets**:

- `CLOUDFLARE_API_TOKEN` (**required**): Dedicated, account-scoped token with permissions to create/deploy the Worker and read/write D1. The refresh runner reuses its existing D1 permissions.
- `CLOUDFLARE_ACCOUNT_ID` (**required**): Cloudflare Account ID. This is not a password, but the workflow follows the common practice of storing it as a CI/CD Secret.
- `INGEST_TOKEN` (**required**): Long, randomly generated token protecting the ingestion API. The deployment workflow also installs this as a Worker Secret; the periodic ingestion workflow uses the same value.
- `QDRANT_URL` (**required**): Qdrant Cluster Endpoint, including `https://`, for example `https://example.aws.cloud.qdrant.io:6333`.
- `QDRANT_API_KEY` (**required**): Qdrant Cloud API Key.
- `INGEST_URL` (**set after first deployment**): `https://<worker-host>/internal/ingest`, used by **Refresh blog index**.

Enter Secrets only through GitHub settings. Do not commit them to code or paste them into conversations.

## Cloudflare Worker (Runtime)

The production Worker receives its configuration from the following sources:

- **D1 binding `DB` and AI binding `AI`:** Defined by `wrangler.example.toml`, with the database ID substituted during deployment.
- **Public variables:** `BLOG_FEED_URL`, `BLOG_BASE_URL`, `EMBEDDING_MODEL`, `MAX_ARTICLES_PER_REQUEST`, `FEED_PAGE_SIZE`, `INGEST_CONCURRENCY`, `REQUEST_DELAY_MS`, `CHUNK_SIZE_CHARS`, `CHUNK_OVERLAP_CHARS`, and `SEARCH_MAX_RESULTS`, defined in the public `wrangler.example.toml`.
- **Worker Secrets:** `INGEST_TOKEN`, `QDRANT_URL`, `QDRANT_API_KEY`, and `QDRANT_COLLECTION`, synchronized during deployment by GitHub Actions. Do not also maintain separate values with the same names in the Cloudflare Dashboard, because a later deployment could overwrite them.

The production template defaults to one article per batch, including due retries. The Actions runner reads the same `[vars]` section directly. It parses HTML and writes D1/Qdrant data outside the Worker, then sends one chunk per authenticated embedding call. Blogger full Atom feed URLs are adapted to summary JSON at fetch time, so `BLOG_FEED_URL` and existing D1 pagination checkpoints do not need to be changed.

The refresh job uses the `production` environment, like deployment, and receives the existing Cloudflare/Qdrant secrets plus `D1_DATABASE_ID` and `QDRANT_COLLECTION`. No additional secret is needed. The runner verifies D1 access and the deployed embedding model before acquiring an ingestion lease.

Optional runner process settings (set in the workflow's `env` when needed): `INGEST_MAX_BATCHES` (10,000), `INGEST_MAX_DURATION_SECONDS` (19,800), `INGEST_MAX_ERROR_ATTEMPTS` (5), and `INGEST_MAX_LOCK_WAIT_SECONDS` (1,200). Time/batch limits pause at a saved checkpoint; the next run continues. `RESET_BACKFILL` is controlled by the manual workflow input and should remain false for recovery.

## Deployment Sequence (No Local Steps)

1. Create the D1 database in the Cloudflare Dashboard and the cluster in Qdrant Cloud.
2. Configure the required GitHub Actions Variables and Secrets.
3. Go to GitHub → Actions → **Deploy Cloudflare Worker** → **Run workflow**.
4. The workflow runs unit tests, remote D1 migrations, Worker deployment, and Secret synchronization on the GitHub runner.
5. After the Worker's `/health` endpoint succeeds, set `INGEST_URL`.
6. Go to GitHub → Actions → **Refresh blog index** → **Run workflow** to start indexing.
7. Optionally set `ENABLE_AUTO_DEPLOY=true`; future successful CI runs triggered by pushes to `main` will deploy automatically.

See the [Deployment Guide](deployment.md) for production instructions. Local development is **optional for contributors**, not part of the required architecture.

