# Spec 06 — Developments, geocoding, and proximity

**Needs from Fury:** Google Maps Platform key (Geocoding + Distance Matrix),
seed list of developments (a starter list is below — verify before trusting).

## Goal
A place-centric table of upcoming and existing infrastructure for North
Bangalore, with geometry, a status tier, and a revision history — and a
computed distance/drive-time from every project to every relevant development.

## Part A — Geocode projects
For each `projects` row without `geom`:
1. Builder site map link / embedded lat-long → `geocode_source='builder_map'`, conf 0.95.
2. RERA survey number + village → Google Geocoding → `rera_survey`, conf 0.7.
3. `"{canonical_name} {locality} Bengaluru"` → Google Geocoding → conf 0.6.
4. Anything below 0.6 goes to `geocode_review` for a manual pin (ops task).
Store `geocode_confidence`; the site shows "approximate location" below 0.8.

## Part B — Developments seed (verify each; starter only)
Status tiers per constitution §5. Each row needs `authority`, `source_url`,
`expected_completion`, and at least one `completion_history` entry.

Transit
- Namma Metro Blue Line (Phase 2B, KR Puram–Hebbal–Airport): stations Hebbal,
  Kempapura, Veerannapalya, Kogilu Cross, Jakkur Cross, Yelahanka, Bagalur
  Cross, Airport — `under_construction`, authority BMRCL
- Bengaluru Suburban Rail (K-RIDE) Corridor 1 Majestic–Devanahalli — check
  current tier, authority K-RIDE
- Yelahanka–Doddaballapur rail / Metro proposals — `proposed`
Roads
- Hebbal flyover additional loops / Bellary Road widening — KRDCL/BBMP
- Hennur Road widening (Hennur–Bagalur) — BBMP
- Thanisandra Main Road widening — BBMP
- Peripheral Ring Road (now "Bengaluru Business Corridor") — BDA
- Satellite Town Ring Road (STRR) northern arc — NHAI
- Airport trumpet / NH-44 upgrades — NHAI
- Elevated corridor proposals (Hebbal–Silk Board, Tumakuru Road) — `proposed`
Employment
- KIADB Aerospace & Hardware Park, Devanahalli — `operational`, expanding
- Devanahalli Business Park / ITIR — check tier
- Manyata Tech Park expansion phases — `operational`/`under_construction`
- Bagalur / IVC Road IT corridor announcements — `proposed`
- Foxconn Doddaballapur plant — check tier
Social / utilities
- Hospitals (Aster CMI, Manipal Hebbal, upcoming ones), schools, malls
  (Phoenix Mall of Asia operational; others announced)
- Cauvery Stage V coverage by ward — BWSSB; **water is the #1 North
  Bangalore buyer question, track it as a development per ward**
- Lake rejuvenation (Jakkur, Yelahanka, Rachenahalli, Hebbal) — BBMP/BDA
Zoning
- BDA Revised Master Plan 2041 status; Greater Bengaluru Authority zones

Geometry: points for stations/parks/hospitals; linestrings for roads/metro
(digitise from official alignment maps or OSM; store `geom_source`).

## Part C — Crawl sources for developments
Registered via spec 03: `govt_notice` (authority page) daily, `news_rss`
(name + Bengaluru) daily, `reddit` (name) weekly. Extraction (spec 04) writes
`development_updates`; a status or date change appends to
`completion_history` and bumps `last_verified_at`.

## Part D — Proximity compute
Nightly job + on change of either side:
```sql
insert into project_development_proximity (project_id, development_id, straight_line_m, computed_at)
select p.project_id, d.development_id,
       st_distance(p.geom, d.geom)::int, now()
from projects p cross join developments d
where st_dwithin(p.geom, d.geom, 15000)       -- 15 km radius
on conflict (project_id, development_id) do update set straight_line_m = excluded.straight_line_m, computed_at = now();
```
For rows ≤ 10 km and `type in ('employment','metro','suburban_rail','hospital','mall')`,
call Distance Matrix with departure 09:00 IST next weekday → `drive_min_9am`.
Cache 30 days. Budget: ~80 projects × ~25 developments = 2,000 calls/month.

## Rendering contract (used by spec 08/09)
`get_project_proximity(project_id)` returns developments ordered by relevance:
1. within 3 km any type, 2. within 10 km employment/transit, each with
`name, type, status, expected_completion, revisions_count, straight_line_m,
drive_min_9am, source_url, last_verified_at`.

## Done when
10 seeded projects geocoded ≥ 0.8, 25 developments with geometry and tiers,
proximity rows present, and a deliberate date change on one development
appends to `completion_history` and shows `revisions_count=1`.
