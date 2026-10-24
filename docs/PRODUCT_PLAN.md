# TrueNest AI — Product plan to a testable v1 (PM: Claude; owner: Fury)

Goal: a version Fury can open on his phone, search like a buyer, see real North Bengaluru
projects with RERA facts and 5–10-year area potential, and share with 5 friends for feedback.
Each phase ends with a **Fury test script** and a feedback form. Branch per spec
(`feat/<spec-slug>`), reviewer PASS logged in `REVIEW_LOG.md`, deploy to staging.

## P0 — Make search return something (3–4 days)
Specs: 12 (K-RERA import, Parts A–C), 15 (intent parser), spec 14 §C/§D (push trigger,
status poll, short failure TTLs, diagnostics). Also delete the two cached `no_results` rows.
**Needs from Fury before start:** the seed sheet (≥ 40 rows) — see `specs/12` Part A; 1 hour
of RERA verification clicks in `/admin` after import.
**Exit criteria:** `/projects` lists ≥ 40 published projects; "Yelahanka 2 BHK" returns
Lane A results with chips; a nonsense query shows "researching" and flips to a result or an
honest "nothing cited" within 60 s without manual refresh; admin shows job diagnostics.
**Fury test script:** search 10 real queries (builder names, localities, budgets, sentences);
open 5 project pages; check each RERA link-out opens the right K-RERA page; try one unknown
builder and time the research.

## P1 — Research v2 and the enrichment crawl (5–7 days)
Specs: 14 (discover/verify/scorer), 03 + 04 (registry, govt_notice/news/builder adapters,
extraction), 06 Part A/D (geocode, proximity).
**Exit criteria:** unknown-project queries return ≥ 3 unverified listings with confidence
badges; Loop 1 runs nightly and updates ≥ 1 fact with history; conflicts render side by side.
**Fury test script:** search 5 builders not in the catalogue; confirm every listing shows
source + date + "unverified"; open admin → research jobs and read drop reasons.

## P2 — Area potential (5–10 years) and the area brief (5–7 days)
Specs: 13, 08, 06 Part B seed (25 developments verified by Fury), 07 (cost estimator with
status badge).
**Exit criteria:** every project page has Potential tabs (Now–2y / 2–5y / 5–10y) with
distances and tiers; locality pages have the 10-year strip; cost sheet shows
official/estimated/unknown with basis.
**Fury test script:** pick 3 projects you know; judge whether the Potential section is
accurate and fair; find one claim that lacks a source (there should be none).

## P3 — Capture and WhatsApp (5–7 days)
Specs: 09 capture hooks, 10 qualify agent (fixture WhatsApp in staging, real number when the
provider account exists), 11 partner handoff. DPDP consent copy reviewed **[FURY: counsel]**.
**Exit criteria:** every CTA opens WhatsApp with the right ref; consent captured before any
storage; a simulated conversation yields a handoff brief.
**Fury test script:** go through the funnel as a buyer from a project page to a site-visit
request; check the partner dashboard row.

## Ongoing
- Weekly: RERA re-verification list, developments review, failed research jobs.
- Metrics to watch from day one: searches → results shown (%), research jobs done vs
  no_results, capture clicks per 100 project views, qualified leads, site visits.

## Decisions Fury owes (blocking marked ●)
● Seed sheet and 1 h of RERA verification (P0).
● C-items C1–C25 in the alignment plan (D17); at minimum: portals as discovery-only (C?),
  truth/verification two-axis model (C6), legally significant attribute list (C7).
○ Google Maps billing for drive times (P2).
○ WhatsApp Business provider and number (P3).
○ Counsel review of DPDP consent text (P3).
