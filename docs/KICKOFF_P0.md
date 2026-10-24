# Paste this into Claude Code (orchestrator session) in the truenestai repo

You are the orchestrator for TrueNest AI. Read, in this order: `CLAUDE.md`, `docs/ARCHITECTURE_V2.md`,
`docs/PRODUCT_PLAN.md`, `specs/00-README.md`, then specs 12, 15, 14 (P0) in full.

Context you must not re-derive: on staging the catalogue is empty (projects = 0), Lane B has no
production adapter, and both research jobs ever run ended `no_results` (`no_candidates`). The fix
order is P0 in `docs/PRODUCT_PLAN.md`. Source priority is K-RERA first (staff-driven, no crawling,
D16 stands), then government planning bodies, builder sites, news, web search, community.

Work P0 now:
1. Create branch `feat/12-krera-import`. Delegate per `docs/AGENT_WORKFLOW.md` ownership:
   backend-data-engineer (migration 0007: research diagnostics columns, search_document + pg_trgm,
   developments.horizon), regulatory-research-engineer (`src/ingest/krera-import`), frontend-engineer
   (`/admin/import` with dry-run report and verify checklist), test-engineer (unit + db tests).
2. Branch `feat/15-search-intent`: `src/search/intent.ts`, repository ranking, chips.
3. Branch `feat/14-research-v2-p0`: push trigger at enqueue, `GET /api/research/status`, polling
   notice, TTLs (no_results 12 h, failed 1 h), diagnostics persisted, admin re-run button, and the
   staging smoke script that asserts a `done` job with result_count > 0 for a unique query.
   The discover/verify/scorer rewrite is P1; do not start it in this branch.
4. Each branch: `npm run check`, `npm run test:db`, `npm run build`, e2e; quality-reviewer PASS in
   `docs/REVIEW_LOG.md`; open a PR; never push main.
5. Before starting any spec, list its "Needs from Fury" and stop if one is missing. For spec 12 you
   need the seed sheet; if it is not in the repo under `data/seed/krera-north-bengaluru.csv`, build
   the importer against a 10-row fictional SAMPLE file and tell Fury exactly which columns to fill.
6. Record decisions in `docs/DECISIONS.md` (D19+) and integrations in `docs/MCP_REQUESTS.md`.
7. Report at the end: branches, PR links, test commands + results, what Fury must do next
   (seed sheet, 1 hour of RERA verification clicks, C-item decisions).
