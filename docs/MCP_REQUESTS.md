# Integrations requiring owner action

Status: `open` | `in_progress` | `done` | `declined`. Nothing here has been configured by Claude.

## R1 — GitHub repository confirmation (dev-time) — open
- Need: confirm `vkkumar123/truenestai` is the product repo (currently **public**; consider making it private).
- Operations: push feature branches, open PRs. Never push `main`.
- Auth: existing Claude GitHub App connection (already granted push to this repo for this session).

## R2 — Supabase project (production integration) — open
- Purpose: Postgres, Auth (staff/admin login), Storage (documents).
- Needed from owner: create a project (region `ap-south-1` Mumbai recommended for latency and data locality), then set server env vars `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` in the hosting provider — never in Git.
- Minimum permissions: service role used only by server code and workers; anon key for public reads under RLS.
- Docs: https://supabase.com/docs/guides/getting-started , https://supabase.com/docs/guides/database/postgres/row-level-security
- Optional dev-time MCP: Supabase MCP server (https://supabase.com/docs/guides/getting-started/mcp) scoped to a **development** project in read-only mode. Not required; migrations run via the Supabase CLI.

## R3 — Anthropic API key (production integration) — open
- Purpose: bounded extraction of document fields and comparison explanations (drafts, human-reviewed).
- Env: `ANTHROPIC_API_KEY` (server/worker only). Set a spend limit in the Anthropic Console.
- Docs: https://docs.anthropic.com/en/api/getting-started

## R4 — Map provider (production integration) — open
- Purpose: project/locality maps. Adapter allows OpenStreetMap tiles (attribution, usage policy https://operations.osmfoundation.org/policies/tiles/ — not for heavy production use), MapTiler, Mapbox or Google Maps.
- Decision needed: which provider and billing account. Key would be a browser-restricted public key.

## R5 — External discovery sources (production integration) — open
- Purpose: Lane B discovery. Each source needs a documented permitted access method (partner feed, licensed API or written permission) before activation. See `DATA_SOURCE_POLICY.md` for the candidate list.
- Needed from owner: commercial/partner agreements or written permission per source.

## R6 — K-RERA public records access (production integration) — open
- Purpose: registration, complaint and order lookups for projects.
- Needed: confirm permitted automated access or obtain an official data channel; until then, manual lookup by staff with recorded URL and date. Details in `docs/research/REGULATORY_SOURCES.md`.

## R7 — GCP hosting (Cloud Run) and deploy access — in_progress (bootstrap applied 2026-10-22)
- Decision: Cloud Run in `asia-south1` + Supabase Mumbai (owner, 2026-10-21). Full guide: `DEPLOYMENT.md`.
- Needed from owner, once, in Google Cloud Shell for project `truenestai` (Owner role):
  1. Billing linked to the project.
  2. Run `bash infra/gcp-bootstrap.sh` from a clone of branch `infra/gcp-cloud-run`. It enables APIs, creates the state bucket `truenestai-tfstate`, and Terraform creates: Artifact Registry `truenest`, runtime SA `truenest-run-staging`, deployer SA `truenest-deployer`, Workload Identity pool `github` + provider `truenestai` (restricted to this repo, owner id 35333263, and the `staging`/`production` GitHub environments), Secret Manager secrets, and Cloud Run `truenest-staging`.
  3. ~~Add the five printed values as GitHub repository variables~~ Not needed: they are the defaults in `deploy.yml` (done 2026-10-22).
- Later: Supabase values and a generated SESSION_SECRET into Secret Manager via `gcloud secrets versions add` (never chat or Git); for production a domain, its DNS A record, the `PRODUCTION_URL` variable and required reviewers on the `production` GitHub environment.
- Minimum permissions: deployer has `artifactregistry.writer` on one repo, `run.developer` on the TrueNest services only, `actAs` on their runtime SAs, and read on the build-key secret. Runtime SAs read only their own environment's secrets. No JSON keys.
- CI (`ci.yml`) still runs on fixtures and needs nothing.

## R8 — Playwright MCP (dev-time) — open
- Purpose: (a) browser tests and visual checks of OUR site in Claude Code; (b) **staff-initiated, single-page K-RERA lookups** where Fury opens one project page and asks Claude to read the visible fields into the import sheet. Not a crawler: no loops over listings, no schedules, no CAPTCHA/login bypass (D16, D20).
- Setup: `.mcp.json` entry `playwright` (no key). First run downloads Chromium.
- For K-RERA lookups prefer Claude in Chrome / the desktop browser pane (Fury's own session, he navigates); Playwright MCP is the fallback when that is not available.

## R9 — Brave Search API (research agent v2) — open
- Purpose: discover/verify queries in spec 14 outside the model's built-in web search; cheaper and loggable.
- Owner: create a key at https://brave.com/search/api/ (Free plan is enough for staging), then
  `printf %s "$KEY" | gcloud secrets versions add truenest-staging-brave-api-key --data-file=-` and export `BRAVE_API_KEY` locally for the MCP server. Never in Git.
- Env: `BRAVE_API_KEY` (server/worker only).

## R10 — Google Maps Platform (geocoding, distance) — open
- Purpose: project geocoding (spec 06 A), straight-line + 9 AM drive time (spec 06 D, spec 13). Enable Geocoding API and Distance Matrix API on project `truenestai`; restrict the key by API and (for the browser key, later) by referrer.
- Setup: `gcloud services enable geocoding-backend.googleapis.com distance-matrix-backend.googleapis.com`; create a server key in Console → Credentials; store as `truenest-staging-google-maps-api-key` in Secret Manager; export `GOOGLE_MAPS_API_KEY` locally for the MCP server.
- Budget: ~2,000 Distance Matrix calls/month at launch; set a billing alert at ₹2,000.

## R11 — Reddit and YouTube Data APIs (community signals) — open
- Reddit: create a "script" app at https://www.reddit.com/prefs/apps → `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, user agent `truenest/0.1 (by u/<handle>)`.
- YouTube Data API v3: enable on `truenestai`, key `YOUTUBE_API_KEY` (10k units/day free).
- Both read-only; store in Secret Manager as above. Needed for P1 (spec 03 adapters).

## R12 — Scrapy crawl worker (Loop 1) — open
- Purpose: scheduled crawl of sources that permit it (builder pages, BMRCL/BDA/NHAI/KIADB notice pages, news RSS). Python, lives in `workers/crawl/` (ARCHITECTURE.md reserved `workers/` for Python).
- Mandatory settings: `ROBOTSTXT_OBEY = True`, `AUTOTHROTTLE_ENABLED = True`, `DOWNLOAD_DELAY ≥ 2`, `CONCURRENT_REQUESTS_PER_DOMAIN = 1`, `USER_AGENT = "TrueNestBot/0.1 (+https://<domain>/bot; contact <email>)"`. Every spider checks the source registry (`approved` + env) before its first request and refuses otherwise. K-RERA is excluded unless D16 is revised by the owner.
- Deploy: Cloud Run Job `truenest-crawl` triggered by Cloud Scheduler; raw payloads to GCS; writes through the extraction step (spec 04).

## R13 — Cloud Tasks (research push trigger) — open
- Purpose: run a research job seconds after enqueue instead of waiting for the 2-minute sweep (spec 14 §C).
- Setup: `gcloud services enable cloudtasks.googleapis.com`; queue `truenest-research` in `asia-south1`; runtime SA needs `roles/cloudtasks.enqueuer`; the task POSTs `/api/internal/research/run` with the existing `x-research-secret` header. Fallback without it: in-process `fetch()` fire-and-forget.
