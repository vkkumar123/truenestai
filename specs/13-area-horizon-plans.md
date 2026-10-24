# Spec 13 — Area potential: 5–10-year development plans

**Owner agents:** locality-intelligence-engineer (`src/locality`, `src/config/markets`),
backend-data-engineer (migration), frontend-engineer (Potential section), property-discovery-
engineer (govt/news adapters). Extends spec 06 (developments + proximity) and spec 08 (brief).
**Needs from Fury:** Google Maps Platform key (Geocoding + Routes API); a yes/no on
showing drive times (billable); review of the seed list below before it goes live.

## Goal
On every project and locality page, a **Potential** section that answers: what is planned
around here, how far is it, how real is it, and when. Horizon up to 10 years, every item with
a status tier, an authority, a source, a date and a revision count. This is the "see the
potential" promise and it must never read like a brochure.

## Data (adds to spec 06 `developments`)
```sql
alter table developments
  add column horizon text generated always as (
    case
      when status = 'operational' then 'operational'
      when status = 'shelved' then 'shelved'
      when expected_completion is null then 'unscheduled'
      when expected_completion <= current_date + interval '2 years' then '0-2y'
      when expected_completion <= current_date + interval '5 years' then '2-5y'
      when expected_completion <= current_date + interval '10 years' then '5-10y'
      else 'beyond-10y' end) stored,
  add column plan_document text,        -- e.g. 'BDA RMP 2041', 'BMRCL Phase 3A DPR', 'CMP 2031'
  add column impact_tags text[],        -- 'commute','jobs','water','road','social','zoning'
  add column buyer_note text;           -- one plain sentence, staff-approved
```
`completion_history` (jsonb) stays the record of every date ever claimed → `revisions_count`.
`confidence`: 0.9 official notice/tender, 0.7 official plan document, 0.5 news, 0.3 single
community mention (never shown alone).

## Seed list to verify (North Bengaluru, 2026 → 2036) — starter, verify each
Transit: Metro Blue Line Phase 2B (KR Puram–Hebbal–Airport; stations Hebbal, Kempapura,
Veerannapalya, Kogilu Cross, Jakkur Cross, Yelahanka, Bagalur Cross, Airport); Metro Phase 3 /
3A corridors touching Hebbal–Sarjapur and ORR west; Suburban Rail (K-RIDE) Corridor 1
Majestic–Devanahalli and Corridor 4 Heelalige–Rajanukunte; Yelahanka–Devanahalli rail
doubling; BMTC depots/bus priority on Bellary Road.
Roads: Bengaluru Business Corridor (PRR); STRR northern arc (NHAI); Bellary Road/NH-44
widening and airport trumpet rework; Hebbal flyover loops; Hennur Road and Thanisandra Main
Road widening; Bagalur–Hosakote link; proposed elevated corridors (Hebbal–Silk Board, Tumakuru
Road); Doddaballapur Road upgrades.
Airport/economy: BIAL Terminal 3 and second-runway capacity; Aerocity/Business Park phases;
KIADB Aerospace & Hardware Park expansion; Devanahalli Business Park / ITIR; Bagalur–IVC Road
IT corridor; Foxconn Doddaballapur; Manyata expansion; proposed knowledge/health city near
Yelahanka–Doddaballapur.
Utilities: Cauvery Stage V coverage by ward and Stage VI proposal; BWSSB STP upgrades; lake
rejuvenations (Jakkur, Yelahanka, Rachenahalli, Hebbal, Kogilu).
Zoning/governance: BDA Revised Master Plan 2041 (land-use, road network, growth centres);
Greater Bengaluru Authority corporations; BIAAPA/LPA jurisdictions for Devanahalli/Bagalur.
Social: hospitals (Aster CMI, Manipal Hebbal, upcoming), schools, malls (Phoenix Mall of Asia
operational; Bhartiya City expansion), sports/convention facilities.

## Sources and cadence (register in spec 03)
Daily: BMRCL, BDA, K-RIDE, KRDCL, NHAI, KIADB, BBMP/GBA, BWSSB notice & tender pages
(`govt_notice`, fetch only where robots allow; otherwise staff-saved PDFs); Google News RSS per
development; Deccan Herald/TOI/The Hindu Bengaluru infra beats. Weekly: Reddit threads naming
the development (signals only). Quarterly: staff re-read of RMP 2041 / CMP 2031 PDFs with facts
entered via `/admin/developments`.

## Compute
Spec 06 Part D proximity. Add per project a `potential_score` **[FURY: show or keep internal?]**
= weighted count of developments within 5 km by horizon and confidence (0–2y ×1.0, 2–5y ×0.6,
5–10y ×0.3) × impact weight (commute/jobs 1.0, water/road 0.8, social 0.5). Shown only as
"Potential: high / medium / low — see items" with the items underneath; never a number alone.

## Rendering (Potential section)
Grouped by horizon tabs **Now–2y / 2–5y / 5–10y**, each item:
`{name} · {type} · {distance km straight-line}{ · drive min at 9 AM} · {status tier} ·
expected {year}{ · revised n×} · {authority} · source ↗ · verified {date}`
Buyer note in plain language (staff-approved). Footer caveat: "Timelines in Bengaluru slip; we
show the status tier and how many times the date has moved." Small map: project pin + items
coloured by tier.
Locality page: same, plus a 10-year timeline strip and "what this means for {locality}" brief
(spec 08) composed only from these rows.

## Done when
25 verified developments with geometry, tier, horizon, source; a project page shows ≥ 5
items across horizon tabs with distances; changing one `expected_completion` moves it between
tabs and bumps `revisions_count`; a development with confidence < 0.5 and no official source
is hidden from buyers and visible in admin.
