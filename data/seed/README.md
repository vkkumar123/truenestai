# Seed sheet — North Bengaluru apartment projects (unverified)

Input for the K-RERA staff import (`specs/12-krera-first-ingestion.md`, Part A). Compiled 2026-10-24 from
builders' own project pages and news only; **rera.karnataka.gov.in was never fetched** (D16). Listing portals were
used only to discover names; no price or RERA number was copied from them. Every row is `needs_verification = yes`
and nothing here may be published until an admin verifies it against K-RERA by hand (`krera_url` is filled at that
step). Facts import as `source_type = builder|news`, `truth = official` only for builder-stated registration data,
`verification = unverified`.


File: `krera-north-bengaluru.csv` — 84 rows, 21 columns, UTF-8, header per spec.
Rows are phase/tower-level where the builder page listed several RERA numbers (so ~55 distinct projects become 84 rows).
Every `needs_verification` = yes. `krera_url` blank throughout (no builder page linked to a K-RERA URL). rera.karnataka.gov.in was never fetched.

## Rows per builder (RERA filled / blank)

| Builder | Rows | RERA filled | RERA blank | Source |
|---|---|---|---|---|
| Brigade Group | 18 | 14 | 4 | builder (17), news (1: Ebony at Brigade Orchards) |
| Provident Housing | 10 | 9 | 1 | builder |
| Sattva Group | 10 | 8 | 2 | builder |
| L&T Realty | 8 | 8 | 0 | builder |
| Godrej Properties | 6 | 0 | 6 | builder (project pages fetched; RERA not in page text) |
| Assetz Property Group | 5 | 5 | 0 | builder |
| Embassy Developments | 5 | 5 | 0 | builder |
| SOBHA Limited | 4 | 0 | 4 | builder (sold-out north projects; RERA only on a generic disclaimer link) |
| Puravankara | 4 | 2 | 2 | builder |
| Century Real Estate (incl. Archway Realty LLP for Century Liva) | 4 | 4 | 0 | builder |
| TVS Emerald | 3 | 3 | 0 | builder |
| Birla Estates | 1 | 0 | 1 | builder |
| Bhartiya City | 1 | 0 | 1 | builder (nikoohomes.com not reachable) |
| MANA | 1 | 1 | 0 | news (PTI wire on theweek.in quoted RERA no.) |
| SNN Estates | 1 | 0 | 1 | news |
| Casagrand | 1 | 0 | 1 | news |
| Tata Housing | 1 | 0 | 1 | news |
| Prestige Estates | 1 | 0 | 1 | news |
| **Total** | **84** | **59** | **25** | builder 78 / news 6 |

## Pages listing multiple RERA numbers (already split into one row per number — staff to confirm phase mapping)

- **Brigade El Dorado** (brigadegroup.com .../brigade-el-dorado/lp): 12 named towers, 9 distinct numbers. Jasper & Iridium, Emerald & Luminaire, Dioro & Beryl each share one number on the page.
- **Provident Ecopolitan**: 6 RERA numbers listed with NO phase labels. Rows named "RERA phase 1..6 of 6" in page order.
- **Provident Deansgate**: 2 numbers, no phase labels (page has Phase 1 / Phase 2 construction reports). Villaments, not high-rise flats.
- **Assetz Sora & Saki**: footer lists 3 numbers, FAQ mentions 2; no phase labels.
- **L&T Raintree Boulevard**: 7 cluster-wise numbers with tower lists (labels copied).
- **Sattva Aeropolis**: Phase 1 and Phase 2 numbers on one page; Phase 2 number also on the Aeropolis II page (same number, two rows: "Sattva Aeropolis (Phase 1)" and "Sattva Aeropolis II").
- **Embassy Origins** page lists numbers for Embassy South Reserve (apartments, included) and Embassy Riverine (villas, excluded).
- **Embassy Verde**: page says "Phase 1, Ongoing" — later phases likely separate RERA.
- **Brigade Orchards**: township with blocks Cedar/Deodar/Juniper/Kino + Ebony + Laurel & Maple; page shows "OC Received" under RERA heading, no numbers. One summary row + one news row + one brand-page row.
- **Sattva City** (50 acres) and **Century Kindle** (15.7-acre township): single number shown; more phases probable.
- **Godrej MSR City / Godrej Ananda / Birla Trimaya / Nikoo Homes / SNN Felicity**: multi-phase projects with no RERA number visible — expect several registrations each.

## Verbatim oddities to check
- Sattva Park Cubix (Phase I): page shows `PR/KN/170901/001749` (non-standard format) — copied verbatim.
- Embassy Lake Terraces and Embassy Springs show an `EX/` prefix (`EX/PRM/KA/RERA/...`) — copied verbatim (Springs excluded as plots/township).
- Brigade Insignia page prints the number with a stray space (`1251/309/ PR/180524/006894`); the rera_number cell stores it without the space and the notes column records the page spelling.
- Provident pages: page geo-meta lat/lng (12.983911, 77.632363) is a site-wide default; rows use the map-embed coordinates instead.
- Purva Atmosphere: possession 30-06-2025 on a page with © 2026 footer — probably stale.

## Localities / inclusion decisions
- Budigere Cross projects (Brigade Belvedere, Sattva Songbird, Sattva Bliss, Sattva Aangane) are marketed as **East** Bengaluru on their pages — excluded per rule.
- Villas/plots excluded: Embassy Riverine, Embassy Boulevard, Embassy Springs (plots phase), Chartered Birdsong, Sattva Northland/La Vita, Shriram row housing, Abhee plotted projects.
- Aerospace Park / KIADB Hardware Park projects mapped to `Bagalur`; Navarathna Agrahara / MSEC Road / Shettigere mapped to `Devanahalli`; Tarahunise/NH44 mapped to `Bellary Road`; Byatarayanapura to `Hebbal`. Staff should re-check against K-RERA addresses.

## Builders NOT reachable (do manually)
- **prestigeconstructions.com** — all project pages returned client errors (only generic landing pages loaded). Prestige Finsbury Park, Camden Gardens, Avon, Royale Gardens, Misty Waters etc. need manual entry. One Prestige Parklane row from news.
- **godrejproperties.com** — listing pages robots-disallowed; individual project pages load but the RERA number is not in page text (image/JS). 6 rows with blank RERA.
- **sobha.com** — project pages load but RERA is only behind a generic "RERA Disclaimer" page with no numbers.
- **casagrand.co.in**, **shriramproperties.com** (project pages), **tatarealty.in**, **nikoohomes.com**, **brigadegroup.com/residential/bangalore/*** and `/residential/bengaluru/devanahalli` — client errors.
- **adarshdevelopers.com, vaishnavigroup.com, sumadhuragroup.com, snnbuilders.com, dsrinfra.com, manaprojects.com** — fetch blocked (URL provenance permission not granted in time); no search result surfaced their official pages. Candidates for manual entry: Vaishnavi North 24 (Hebbal Kempapura), Vaishnavi Serene (Yelahanka), Adarsh Welkin Park (Bagalur), Mana Verdant Terraces (Jakkur), Kolte-Patil Lakeside 24 (Hennur Rd), Karle Zenith (Nagawara), Ozone Urbana (Devanahalli), Ramky One North (Yelahanka), Prestige Avon (Thanisandra), Lodha Mirabelle (Thanisandra).
- **Mahindra Lifespaces**: Bengaluru list fetched; no North Bengaluru project. **Abhee Ventures**: news fetched; no North project named.
- **Birla Estates**: Trimaya page loads but shows no RERA, units or status.

## Not used as sources (discovery only)
homebazaar.com, housiey.com, jllhomes.co.in, 360realtors.com, gharpe.com, homes247.in, aurumproptech.in, housing.com (incl. housing.com/news). No price or RERA data was taken from any of these.
