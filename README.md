# Pulipuli Facebook Knowledge MCP

![Pulipuli Facebook Knowledge MCP icon](assets/icon-100.png)

A cloud-native, public, read-only knowledge base **intended for posts from [布丁布丁吃什麼？ (Pulipuli) on Facebook](https://www.facebook.com/pulipuli.blogspot)**. The project aims to turn an RSS feed of public Facebook posts into a searchable archive, a website, a JSON API, and an MCP endpoint that AI assistants can use.

It is based on [Pulipuli Blog Knowledge MCP](https://github.com/pulipulichen/pulipuli-blog-knowledge-mcp), but **the Facebook posts and the blog articles are meant to live in separate databases and vector collections**.

> [!IMPORTANT]
> **Project status: Facebook-specific integration is not finished.** The current codebase is derived from the Blog project, and its runtime configuration, source identifiers, website copy, MCP descriptions, and GitHub Actions labels still reference the blog. In particular, **`wrangler.example.toml` currently points to `blog.pulipuli.info`**. Deploying or running ingestion without adapting those settings and the ingestion code would not create a functioning Facebook knowledge base. The sections below distinguish existing infrastructure from work that remains.

## Goals

- Preserve and search publicly available posts from a specific Facebook page.
- Provide keyword, semantic, and hybrid search with source links.
- Make recently indexed posts easy to browse without a search query.
- Offer a publicly reachable, read-only MCP interface for ChatGPT and other compatible clients.
- Keep the production system **100% cloud-hosted**, with no local computer, NAS, or self-hosted server required.
- Check the feed every two days and resume interrupted ingestion using saved checkpoints.
- Keep Facebook content isolated from the [Pulipuli Blog](https://blog.pulipuli.info/) knowledge base.

## Facebook Source and Coverage

- **Page:** [布丁布丁吃什麼？ on Facebook](https://www.facebook.com/pulipuli.blogspot)
- **Proposed RSS feed:** [FetchRSS XML feed](http://fetchrss.com/rss/5ff67856db94f676db0c0fc262239753566b5039276f8e22.xml)
- **Source type:** Third-party generated RSS for public Facebook posts; not an official Facebook Graph API integration.

The feed above is the **intended source**, not the current runtime default. Its availability, item count, included fields, update frequency, and retention of older posts depend on the feed provider and Facebook's public access behavior. Before enabling production ingestion, verify the feed URL, confirm whether HTTPS works with the provider, inspect a sample item's link and content, and check what historical coverage the feed actually offers.

**RSS is not necessarily a complete archive.** Older posts outside the feed, private or login-restricted content, deleted posts, comments, images, videos, and content omitted by the provider cannot be assumed to be indexed. A full-text post should only be marked as such when its text was actually obtained.

## Architecture

~~~text
Public Facebook page
        |
        v
Third-party RSS feed (FetchRSS)
        |
        v
GitHub Actions ingestion runner (every two days)
        |-- Parse feed metadata and post links
        |-- Acquire D1 ingestion lease / resume checkpoint
        |-- [TO DO] Safely extract post text or use feed content
        |-- Normalize, deduplicate, and split text into chunks
        |
        +--> Cloudflare D1 (posts, chunks, history, checkpoints)
        |
        +--> Cloudflare Workers AI (embedding via Worker proxy)
                     |
                     v
               Qdrant Cloud (vectors)

Cloudflare Worker
        |-- /                  Search website
        |-- /api/*             Read-only JSON API
        |-- /mcp               Read-only Streamable HTTP MCP
        +-- /internal/ingest/*  Authenticated ingestion/embedding support
~~~

**Cloud services:** GitHub + GitHub Actions, Cloudflare Workers, Cloudflare D1, Cloudflare Workers AI, and Qdrant Cloud. No production Docker/Podman container or local Node.js runtime is required.

The existing ingestion runner performs HTML parsing and vector writes in GitHub Actions, while each authenticated Worker embedding request processes one small text input. This is designed to avoid running full-document ingestion within a Free-tier Worker's CPU budget.

## Implemented Foundation

The repository already contains these reusable components inherited from the Blog project:

- **RSS/Atom ingestion:** Feed parsing, title/link/date/tag extraction, retry and rate-limit handling, and saved progress. The existing Blogger pagination logic is **not yet adapted for FetchRSS**.
- **Content indexing:** URL-based deduplication, content hashes, text chunks, failed-item retry records, and D1 ingestion leases. The current fetcher expects same-origin HTML article pages and is **not Facebook-ready**.
- **Search:** Keyword search using D1 substring matching, semantic search using Workers AI embeddings and Qdrant Cloud, and hybrid ranking using Reciprocal Rank Fusion (RRF).
- **Recently indexed items:** A website action and API endpoint to list the newest records; default 5, configurable from 1 to 50.
- **Read-only MCP tools:** `search_articles`, `list_recent_articles`, and `get_article`, served over Streamable HTTP. The tool names and underlying storage are reusable, but descriptions currently refer to blog articles.
- **Cloud automation:** Offline TypeScript checks and unit tests, manual/optional automatic Worker deployment, remote D1 migrations, and scheduled resumable ingestion.
- **Progress diagnostics:** Runner output includes the title and URL being processed; protected ingestion status reports active records and lease information.

These describe **existing code capabilities**, not confirmation that Facebook RSS importing or a public Facebook deployment already works.

## Facebook Integration Checklist

The following changes are needed **before the first Facebook production import**:

- [ ] Replace Blog-specific names, URLs, source IDs, and public text in `package.json`, `wrangler.example.toml`, `config.example.json`, `src/config.ts`, `src/ingest.ts`, `src/mcp.ts`, `src/web.ts`, and related code.
- [ ] Set the intended FetchRSS URL as the production feed; use the Facebook page as the source context where appropriate, without assuming feed and post URLs have the same origin.
- [ ] Test FetchRSS XML structure, pagination, item identifiers, timestamps, and whether the provider supplies full post text. Avoid applying Blogger-only `max-results` / `start-index` pagination to this feed.
- [ ] Implement a Facebook-aware post-content strategy. The current parser fetches each post's HTML, checks `robots.txt`, enforces an origin restriction, and requires at least 80 characters of extracted text. Facebook redirects, login pages, dynamic content, and restricted HTML can make that fail. A validated RSS-content fallback may be necessary.
- [ ] Define canonical post URL normalization, meaningful fallback titles for untitled posts, optional tags, and behavior for deleted or changed posts.
- [ ] Rename the ingestion workflow and user-facing website/MCP wording from “blog articles” to “Facebook posts.”
- [ ] Create **separate** Facebook D1 and Qdrant resources, configure Secrets, deploy, and test a small import before enabling scheduled runs.
- [ ] Update the inherited `docs/` guides and add Facebook feed/ingestion regression tests.

**Do not work around Facebook access controls or ignore content-access restrictions.** Index only text actually available through permitted public sources. Do not treat a login page, blocked request, or RSS summary as verified full text.

## Cloud Deployment (After Facebook Integration)

These are the cloud infrastructure steps **once the checklist above has been completed**. They do not, by themselves, fix the currently Blog-specific source adapter.

1. Create a new Cloudflare D1 database (for example, `pulipuli-facebook-knowledge`) and copy its Database ID.
2. Create or select a Qdrant Cloud cluster, then choose a **dedicated Facebook collection** (for example, `pulipuli_facebook_chunks`). The existing ingestion logic can create the collection when vectors are first written.
3. In **GitHub → Repository Settings → Secrets and variables → Actions**, configure the following **Variables**:
   - `D1_DATABASE_ID`: Facebook D1 database UUID.
   - `QDRANT_COLLECTION`: Facebook-only vector collection name.
   - `WORKERS_DEV_SUBDOMAIN` (only for first deployment on a fresh Cloudflare account): The account-wide workers.dev subdomain to register, e.g. `pulipuli-facebook`. If one already exists, leave unset. The workflow checks and will not silently rename it.
   - `ENABLE_AUTO_DEPLOY` (optional): Leave unset or `false` until the first manual deployment is verified.
4. Configure the following **Secrets**:
   - `CLOUDFLARE_API_TOKEN`: Scoped Cloudflare deployment and D1 API token.
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID (stored as a Secret by the current workflow).
   - `INGEST_TOKEN`: Long, cryptographically random token protecting ingestion endpoints; use at least 32 random bytes.
   - `QDRANT_URL`: Qdrant cluster REST endpoint, including `https://`.
   - `QDRANT_API_KEY`: Qdrant API key.
5. Review the Facebook-specific values in `wrangler.example.toml` **and** the feed/reader implementation. Then run **Actions → Deploy Cloudflare Worker → Run workflow**. The runner checks or registers the workers.dev subdomain before applying remote D1 migrations, then deploys the Worker and synchronizes Worker Secrets. For new Cloudflare accounts, set `WORKERS_DEV_SUBDOMAIN` first; otherwise Wrangler cannot publish from non-interactive GitHub Actions.
6. Check `https://<worker-host>/health`, then add the **Secret** `INGEST_URL=https://<worker-host>/internal/ingest`.
7. After verifying a small Facebook sample, run **Actions → Refresh blog index → Run workflow** (the current workflow name, pending rename). Leave `reset_backfill` unchecked unless deliberately restarting feed traversal.
8. Verify that returned records link to **Facebook posts, not blog articles**, and only then enable the periodic feed refresh. Optionally set `ENABLE_AUTO_DEPLOY=true` after the initial deployment succeeds.

The deployed `wrangler.toml` is generated from `wrangler.example.toml` and `D1_DATABASE_ID` on the temporary Actions runner. **Do not commit tokens, generated production configuration, or API keys.**

The existing ingestion workflow is scheduled daily at **02:17 UTC** and gates execution to every other UTC day; manual runs bypass that gate. GitHub Actions schedules may be delayed. Failed records and checkpoints are stored in D1 so interrupted runs can resume, subject to source-feed coverage and parser behavior.

## HTTP Endpoints

These endpoints are **implemented in the shared Worker code** and will apply to Facebook records after the source integration is completed:

- `GET /` — Search website, including a “latest items” action.
- `GET /health` — Worker/D1 health status.
- `GET /api/search?q=...&limit=...&mode=hybrid|keyword|semantic` — Search indexed records.
- `GET /api/recent?n=5` — List the latest 5 indexed records (supports 1–50), with titles, URLs, publication dates, tags, and excerpts; no embedding call.
- `GET /api/articles/:id` — Read a record's indexed full text and metadata. The route name is still `articles`.
- `/mcp` — Read-only MCP Streamable HTTP endpoint.
- `POST /internal/ingest` — Legacy, Bearer-token-protected direct ingestion endpoint; **not recommended for large production backfills**.
- `GET /internal/ingest/status` — Authenticated active-ingestion status and current item information.
- `GET /internal/ingest/embedding` — Authenticated model/configuration preflight check.
- `POST /internal/ingest/embedding` — Authenticated single-text embedding proxy.

Example public API requests **after a successful Facebook import**:

~~~bash
curl "https://<worker-host>/health"
curl "https://<worker-host>/api/recent?n=5"
curl "https://<worker-host>/api/search?q=Proxmox&mode=keyword&limit=10"
~~~

The JSON API does not require a bearer token for search. Internal endpoints do. Query search needs at least two characters; semantic and hybrid modes require working Workers AI and Qdrant connectivity.

## MCP Integration

After deployment, configure an MCP client supporting **Streamable HTTP** with the URL:

~~~text
https://<worker-host>/mcp
~~~

The current server exposes:

- **`search_articles`** — Input: `query` (required, 2–300 characters), optional `mode` (`hybrid`, `keyword`, or `semantic`) and `limit` (1–20). Returns matches and original source URLs.
- **`list_recent_articles`** — Optional integer `n` (1–50, default 5). Reads D1 directly and does not generate embeddings.
- **`get_article`** — Input: `id` (an indexed record ID or canonical URL). Returns saved text and metadata.

Example natural-language requests, once Facebook posts are indexed:

> Search Pulipuli's Facebook posts for discussions of Proxmox VE and include the original post URLs.

> List the 10 most recent indexed Facebook posts.

> Read the complete indexed text of this Facebook post, if available.

**Do not register this as a Facebook MCP in ChatGPT yet unless you have verified its indexed source.** The current server still identifies itself and describes its tools as the Blog MCP; those labels must be updated during integration. Only indexed text is returned, not a live Facebook page lookup.

## Testing and CI

The current [CI workflow](.github/workflows/ci.yml) runs on pushes to `main`, pull requests, and manual dispatch using Node.js 22:

~~~bash
npm install
npm run typecheck
npm test
~~~

These commands are **optional for contributors**. Production users can use GitHub Actions without a local environment. Tests cover feed parsing, D1 SQL limits and retries, ingestion checkpoints and leases, vector operations, search, API routes, and the cloud ingestion runner. Most tests are inherited from the Blog project: **passing CI does not yet validate Facebook-specific feed parsing or extraction**.

For details, see [Testing Guide](docs/testing.md).

## Troubleshooting

- **Imported results are blog posts:** The code/templates still have Blog source defaults. Stop ingestion and complete the Facebook integration checklist; use dedicated D1/Qdrant resources to avoid mixing datasets.
- **RSS returns too few or no posts:** Verify the FetchRSS URL and XML structure, whether it still updates, and the provider's available history. Existing Blogger-style pagination does not guarantee more Facebook entries.
- **An item fails on origin, robots, authentication, or text extraction:** The Blog HTML reader is not compatible with every Facebook post URL. Inspect the feed's actual content and implement a compliant Facebook-specific reader; do not bypass access controls.
- **Embedding endpoint returns HTTP 404:** Deploy the matching, current Worker version before running the ingestion runner.
- **Interrupted backfill:** Review GitHub Actions logs and the protected ingestion status endpoint. The D1 checkpoint normally allows resumption without selecting `reset_backfill`.
- **Search returns no records:** First check `/health`, then `/api/recent`, then the ingestion log and D1 content. Keyword search is a useful initial check before validating semantic search and Qdrant vectors.

## Documentation and Repository Files

- [Technical Specification](docs/SPEC.md) — Shared architecture and indexing design.
- [Configuration Guide](docs/configuration.md) — Where deployment variables and Secrets live.
- [Cloud-Only Deployment Guide](docs/deployment.md) — GitHub Actions, Cloudflare, D1, and Qdrant setup.
- [Testing Guide](docs/testing.md) — Test coverage and limitations.
- [Worker configuration template](wrangler.example.toml), [application configuration example](config.example.json), and [local development Secrets example](.dev.vars.example).
- [CI workflow](.github/workflows/ci.yml), [deployment workflow](.github/workflows/deploy.yml), and [ingestion workflow](.github/workflows/ingest.yml).

> **Documentation migration note:** The existing files under `docs/` were copied from the Blog knowledge-base project and still contain Blog-specific instructions, names, and URLs. They are useful for understanding the shared architecture but **are not yet a validated Facebook deployment guide**. The checklist in this README takes precedence for Facebook readiness.

## Privacy, Security, and Limitations

This project targets **publicly available content only**. A public index and MCP endpoint can redistribute stored text, so verify publication rights, attribution, and applicable platform/feed-provider terms before making the archive available. Source links should remain visible in results.

The public website, search API, and MCP tools are intended to be read-only. Ingestion and embedding administration are protected by a bearer token; GitHub Secrets must never be committed or exposed in public logs. The cloud services' free-tier quotas and availability can change, and the coverage of a third-party Facebook RSS feed is not guaranteed. Search quality depends on what text has actually been indexed.

## Related Project and License

- [Pulipuli Blog Knowledge MCP](https://github.com/pulipulichen/pulipuli-blog-knowledge-mcp) — Separate knowledge base for [Pulipuli Blog](https://blog.pulipuli.info/).
- Created by [Pulipuli Chen (pulipulichen)](https://github.com/pulipulichen).
- Source code is licensed under the [MIT License](LICENSE).
