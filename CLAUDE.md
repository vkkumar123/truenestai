# TrueNest AI — mandatory development rules

Buyer-first residential property intelligence for Bengaluru. Phase 1 market: **North Bengaluru** only.
Read `AGENTS.md` (Next.js 16 rules: consult `node_modules/next/dist/docs/` before writing Next code).

## Non-negotiables
- Never commit secrets, API keys, service-role keys, real customer data or production data. `.env*` is gitignored; document variables in `.env.example` only.
- Never fabricate properties, prices, builders, RERA numbers, URLs or source records. Fixtures must be obviously fictional (`SAMPLE` prefix, `example.com`/`example.org` URLs, `is_sample: true`).
- Externally discovered records are always labelled unverified, show source + canonical URL + discovery/last-seen dates + limitations. Never present them as verified facts.
- Missing data is not a negative finding. RERA registration is not title clearance. No guarantees of safety, title or returns. No claim of legal independence from builders. Commercial relationships are disclosed.
- No real scraping or live integration until the source is `approved` in the source registry with a documented permitted access method (`docs/DATA_SOURCE_POLICY.md`). Never bypass logins, CAPTCHA, rate limits or robots rules.
- Never merge two projects only because names are similar.
- Market geography lives in `src/config/markets/` — never hardcode localities or zones elsewhere.
- AI workers produce structured, validated drafts. Nothing legally significant is published without human review. Marketing workflows cannot spend money or send outbound messages.
- Server-only modules import `server-only`. Service-role access never reaches client bundles or logs.

## Workflow
- Orchestrator delegates to specialists in `.claude/agents/`; ownership map in `docs/AGENT_WORKFLOW.md`. Agents edit only files they own and report changes + unresolved dependencies.
- Feature branches only; never commit to or push `main`; never force-push.
- Small vertical slices. Each milestone: acceptance criteria met (`docs/ROADMAP.md`), `npm run check` green, Quality Reviewer pass logged in `docs/REVIEW_LOG.md`.
- Record decisions in `docs/DECISIONS.md`; integrations needing the owner's action in `docs/MCP_REQUESTS.md`.
- Report honestly: never claim a test passed, a source was checked, or a push happened unless it did.

## Commands
- `npm run dev` — local app (fixture data mode by default)
- `npm run check` — typecheck + lint + unit tests (required before commit)
- `npm run test:db` — SQL migration + RLS tests against a local Postgres (`DATABASE_URL_TEST`)
- `npm run test:e2e` — Playwright journeys
- `npm run build` — production build
