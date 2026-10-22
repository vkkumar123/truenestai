# TrueNest AI — Architecture

Status: draft v0.1 (M0). Owner: product-architect. Decisions: `DECISIONS.md`.

## 1. Shape: modular monolith
One Next.js app with clear internal modules, one Postgres database, plus scheduled workers. A separate service is added only where a different runtime is needed (Python for document parsing).

| Layer | Choice |
|---|---|
| Web | Next.js 16.4 App Router, React 19, TypeScript, Tailwind v4, shadcn/ui-style components (`cva`, `clsx`, `tailwind-merge`, `lucide-react`) |
| Validation | `zod` at every boundary (forms, API, adapters, AI output) |
| Data | Supabase Postgres (RLS), Supabase Auth (staff), Supabase Storage (documents) |
| AI | Anthropic API, server/worker only, bounded extraction and explanations → validated drafts → human review |
| Workers | TypeScript scheduled jobs first; Python worker (`workers/`) for document parsing later |
| Maps | Provider behind a `MapProvider` adapter (choice pending, `MCP_REQUESTS.md` R4) |

## 2. Module layout
```
src/
  domain/types.ts        shared contract (orchestrator-owned)
  app/                   routes, pages, server actions (UI only; no data access logic)
    api/                 route handlers (backend-owned)
    admin/               protected staff UI
  components/            UI components
  server/                server-only services and repositories (import "server-only")
    repositories/        interfaces + fixture + supabase implementations
  discovery/             Lane B: adapter interface, source registry, dedupe
  research/              Lane A research + RERA lookup workflows
  locality/              infrastructure, amenities, map adapter
  config/markets/        market geography (zones, localities, boundaries)
  leads/                 lead capture, consent, retention, qualification
  growth/                attribution, campaign drafts (no spend, no send)
supabase/                migrations, RLS policies, seed (fictional only)
workers/                 scheduled/batch workers (Python regulatory/document parsing later)
tests/, e2e/             unit/db tests, Playwright journeys
```
Rules: UI talks to `src/server` services, never to Supabase directly for privileged data. Localities and zones come only from `src/config/markets/`.

## 3. Repository pattern
- Interfaces (e.g. `ProjectRepository`, `ExternalListingRepository`, `LeadRepository`, `InfrastructureRepository`) return domain types.
- **Fixture implementation (default):** in-memory, fictional `SAMPLE` data; used by dev, CI and e2e. Writes (leads) are held in memory per process.
- **Supabase implementation:** selected by env (`DATA_BACKEND=supabase` plus Supabase vars; see `.env.example`).
- Selection happens once in a server-only factory. Missing Supabase config in supabase mode fails loudly, with no silent fallback in production.

## 4. Access separation
| Surface | Identity | Data access |
|---|---|---|
| Public site | anonymous | Published Lane A + Lane B rows via anon key under RLS (read-only); lead insert via server action/API only |
| Admin (`/admin`) | staff via Supabase Auth with role claim (`staff`, `admin`) | Server-side, RLS policies by role; service role not used for normal admin reads |
| Admin in fixture mode | dev-only credential from env (`ADMIN_DEV_PASSWORD` + `SESSION_SECRET`) | **Disabled when `NODE_ENV=production`**: login rejected, route returns 404/401 |
| Workers | service role | Server/worker only; never in client bundles or logs |
| Marketing controls | staff `admin` role | Draft-only: no spend APIs, no outbound send integrations wired |

Secrets live only in hosting env vars. `server-only` guards every module touching keys.

## 5. Discovery module (`src/discovery`)
- `SourceAdapter` interface: `sourceId`, `fetchCandidates()` → validated `ExternalListing` drafts, with rate limits and an access method declared.
- **Source registry:** each source has status (`proposed` | `approved` | `suspended`), permitted access method, terms reference, attribution and owner approval. Adapters refuse to run unless `approved` (`DATA_SOURCE_POLICY.md`).
- Dedupe links a listing to a `Project` only on strong identifiers (e.g. RERA number, exact developer + address match). Name similarity alone never merges.
- Phase 1 ships a fixture adapter only.

## 6. Production workflows (scheduled workers / deterministic functions)
These are **not** autonomous agents. Each run is logged, idempotent, and writes drafts or status changes for human review.

| Workflow | Trigger | Output | Human gate |
|---|---|---|---|
| External discovery | schedule per approved source | `ExternalListing` upserts, last-seen updates | Linking to Lane A |
| RERA / document ingestion | staff request, then schedule if permitted | `RegulatoryRecord`/`ProjectDocument` drafts; AI field extraction | Reviewer before publish |
| Infrastructure monitoring | schedule | stage-change drafts with sources | Reviewer |
| Buyer matching / comparison | on request | ranked shortlist + AI explanation draft limited to stored facts | Shown with "AI-generated from listed sources" label; no new facts |
| Lead qualification / CRM | on lead create | qualification score, routing | Advisor contacts the buyer |
| Marketing drafting | staff request | content drafts | Staff publish manually; no spend, no outbound |

AI calls: fixed prompts, structured output validated with zod, source citations required, failures dropped (never auto-published).

## 7. Data flow (text)
```
[Approved source] --adapter--> discovery worker --zod--> external_listings (unverified)
                                                     \--dedupe(strong ids)--> link to project
[Staff research / RERA manual lookup] --> research service --> facts + sources (draft)
[Documents] --> Storage --> Python parser --> Anthropic extraction --> validated draft
                                                    --> reviewer --> published project facts
Public buyer --> Next.js (RSC, anon/RLS reads) --> browse / detail / compare
            --> lead form (consent) --> server action --> leads (+consent version, retention)
Staff --> /admin (Auth role) --> request queue, verification, publish
```

## 8. Map provider
`MapProvider` adapter (tiles, markers, attribution) in `src/locality`. Phase 1 can render a static/list fallback with no key. Provider is chosen by the owner (R4); keys are browser-restricted and public-scoped.

## 9. Dev agents vs production workers (different things)
| Dev agents (`.claude/agents/`) | Production workers |
|---|---|
| Claude Code coding assistants used while building | Server-side code that runs the business |
| Edit repo files within an ownership map | Read/write database under service role |
| Run only in a developer session | Run on a schedule or on request in hosting |
| e.g. `property-discovery-engineer` writes the adapter code | e.g. the discovery worker executes that adapter |

No dev agent runs in production, and no production worker edits code.

## 10. Rendering and caching notes
- `cacheComponents` is enabled (scaffold default). Public pages may cache published data; admin and lead routes are dynamic and uncached.
- Engineers must consult `node_modules/next/dist/docs/` for Next 16 APIs before use (`AGENTS.md`).
