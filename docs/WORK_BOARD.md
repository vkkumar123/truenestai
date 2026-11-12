# Work board — who is building what (read before starting any slice)

Two Claude sessions work on this repo for Fury: the **local orchestrator** (Claude Code on Fury's
laptop) and the **PM session** (remote, Fury's claude.ai session, pushes branches `feat/…`,
`ops/…`, `fix/…` and opens PRs as vkkumar123 with the PM session link in the body).
Coordinate here, not by guessing. Rules:

1. Before starting a slice, add a row with your session, branch, files you will own, and the
   next free migration number. Push the board change first (tiny PR or include in your branch).
2. Migration numbers are claimed here. Never reuse one; never renumber someone else's.
3. If you must touch a file another row owns, say so in the row and keep the change minimal.
4. When a PR merges, move the row to Done.

## In progress
| Slice | Session | Branch / PR | Owns (files) | Migration | Status |
|---|---|---|---|---|---|
| Spec 04 S3a — K-RERA document extraction | local orchestrator | `feat/04-rera-document-extraction` / #15 | `src/research/extraction/**`, `src/server/services/document-extraction.ts`, admin extraction UI | `0007_document_extraction.sql` | PR open, review round 2 PASS |
| Spec 06/13 S4a — area developments (5–10 y) | local orchestrator | `feat/06-area-developments` / #16 | `src/locality/developments.ts`, `src/discovery/research/developments.ts`, `/admin/developments`, `planned-developments.tsx` | `0008_developments.sql` | PR open, review round 3 |
| Spec 12 — K-RERA seed importer + verify queue | PM session | `feat/12-krera-import` | `src/ingest/krera-import/**`, `src/app/admin/import/**`, `src/components/admin/import-*.tsx`, `scripts/import-seed.ts` | `0009_import_audit.sql` | starting 2026-10-24 |
| Spec 15 — search intent parser + trgm | PM session | `feat/15-search-intent` | `src/search/**`, `listProjects` ranking in `src/server/repositories/supabase/projects.ts`, chips in `locality-search.tsx` | `0010_search_document.sql` | starting 2026-10-24 |
| Spec 14 §C/§D — research push trigger, status poll, TTLs, diagnostics | PM session | `feat/14-research-push-poll` | `src/server/services/research-trigger.ts`, `src/app/api/research/status/route.ts`, `research-notice.tsx` polling, `research-jobs.ts` (enqueue hook + TTLs only) | `0011_research_diagnostics.sql` | starting 2026-10-24; touches `research-jobs.ts` minimally — local orchestrator please avoid that file until merged |

## Queue (unclaimed)
| Slice | Spec | Notes |
|---|---|---|
| Research v2 discover → verify → score | 14 §A/§B | after #16 merges (shares `anthropic-research-client.ts`) |
| Loop 1 crawl worker (Scrapy, `workers/crawl/`) | 03, R12 | after Reddit/YouTube keys |
| Cost estimator | 07 | after 12 |
| Website capture hooks / WhatsApp | 09, 10, 11 | P3 |

## Done
| Slice | PR | Merged |
|---|---|---|
| Architecture v2, product plan, specs 12–15, D19 | #13 | 2026-10-24 |
| Seed sheet (84 rows, unverified) | #14 | 2026-10-24 |
| MCP config, R8–R13, secrets script, D20 | #17 | 2026-10-24 |
| Script fix + Routes API | #18 | pending merge by Fury |

## Owner (Fury) checklist
- [x] Brave + Maps keys stored and mounted on staging (revision 00019)
- [ ] Merge #18, #15, #16 after reading their review logs
- [ ] Laptop: `export BRAVE_API_KEY`, `export GOOGLE_MAPS_API_KEY`; approve `.mcp.json` servers
- [ ] Apply migrations 0006–0011 to live Supabase when their PRs merge (`npm run db:migrate`)
- [ ] After the importer deploys: upload `data/seed/krera-north-bengaluru.csv` in `/admin/import`, verify, publish
