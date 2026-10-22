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

## R7 — Hosting and CI secrets — open
- Purpose: deploy (e.g. Vercel) and enable GitHub Actions. CI runs on fixtures and needs no secrets.
