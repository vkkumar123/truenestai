# Agent workflow

Development specialists live in `.claude/agents/*.md`. They are coding assistants, not the production business workers (those are server-side workflows; see `ARCHITECTURE.md`).

## Ownership map
| Agent | Owns |
|---|---|
| orchestrator (main session) | `CLAUDE.md`, `.claude/**`, `src/domain/types.ts`, `package.json`, root config, `docs/AGENT_WORKFLOW.md`, `docs/MCP_REQUESTS.md`, `docs/REVIEW_LOG.md`, Git |
| product-architect | `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md` |
| frontend-engineer | `src/app/**` (not `api/`), `src/components/**`, `src/app/globals.css` |
| backend-data-engineer | `supabase/**`, `src/server/**`, `src/app/api/**`, `docs/DATA_MODEL.md`, `.env.example` |
| property-discovery-engineer | `src/discovery/**`, `docs/DATA_SOURCE_POLICY.md` |
| regulatory-research-engineer | `src/research/**`, `workers/regulatory/**`, `docs/research/REGULATORY_SOURCES.md` |
| locality-intelligence-engineer | `src/config/markets/**`, `src/locality/**`, `docs/research/GEOGRAPHY.md` |
| buyer-crm-engineer | `src/leads/**`, `docs/SECURITY_PRIVACY.md` |
| growth-engineer | `src/growth/**`, `docs/GROWTH.md` |
| test-engineer | `tests/**`, `e2e/**`, `vitest.config.mts`, `playwright.config.ts`, `.github/workflows/**` |
| quality-reviewer | nothing (read-only: Read, Grep, Glob) |

## Procedure
1. Orchestrator defines the slice, its acceptance criteria and the contract (`src/domain/types.ts`).
2. Delegate to owners with explicit file scope. Independent agents may run in parallel only when their file sets do not overlap. Only the orchestrator installs dependencies.
3. Each agent reports files changed, tests run (exact command + result) and unresolved dependencies.
4. Orchestrator integrates, runs `npm run check`, `npm run build`, `npm run test:db`, `npm run test:e2e`.
5. Orchestrator sends the changed-file list, diff summary and test output to `quality-reviewer`. Findings are logged in `REVIEW_LOG.md`.
6. Owners fix critical/high/material findings; tests rerun; a fresh review is requested until PASS.
7. Orchestrator commits on the feature branch and pushes only after PASS.

## Isolation
Parallel agents share one working tree with disjoint ownership; Git worktrees are used when two agents must touch overlapping areas. Agent Teams (experimental) are not enabled.

## Invocation note
Project agents in `.claude/agents/` are loaded by Claude Code at session start. In a session started before they existed, the orchestrator spawns a general-purpose subagent instructed to adopt the role file verbatim; the reviewer is spawned with a read-only tool set.
