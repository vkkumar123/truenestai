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

## R7 — GCP hosting (Cloud Run) and deploy access — open
- Decision: Cloud Run in `asia-south1` + Supabase Mumbai (owner, 2026-10-21). Full guide: `DEPLOYMENT.md`.
- Needed from owner, once, in Google Cloud Shell for project `truenestai` (Owner role):
  1. Billing linked to the project.
  2. Run `bash infra/gcp-bootstrap.sh` from a clone of branch `infra/gcp-cloud-run`. It enables APIs, creates the state bucket `truenestai-tfstate`, and Terraform creates: Artifact Registry `truenest`, runtime SA `truenest-run-staging`, deployer SA `truenest-deployer`, Workload Identity pool `github` + provider `truenestai` (restricted to this repo, owner id 35333263, and the `staging`/`production` GitHub environments), Secret Manager secrets, and Cloud Run `truenest-staging`.
  3. Add the five printed values as GitHub repository variables (`GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_ARTIFACT_REPOSITORY`).
- Later: Supabase values into Secret Manager via `gcloud secrets versions add` (never chat or Git); for production a domain, its DNS A record, the `PRODUCTION_URL` variable and required reviewers on the `production` GitHub environment.
- Minimum permissions: deployer has `artifactregistry.writer` on one repo, `run.developer` on the TrueNest services only, `actAs` on their runtime SAs, and read on the build-key secret. Runtime SAs read only their own environment's secrets. No JSON keys.
- CI (`ci.yml`) still runs on fixtures and needs nothing.
