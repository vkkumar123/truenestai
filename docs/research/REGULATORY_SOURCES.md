# Regulatory & public-record sources — Bengaluru (Karnataka only)

Status: **research notes, nothing approved for automation.** Investigation date: 2026-10-21.
Owner: regulatory-research-engineer. Code: `src/research/**`.

## How this was checked (read this first)

- Tooling: web search plus a fetch tool that honours `robots.txt`. Direct `curl` to these hosts was refused by the sandbox proxy (HTTP 403 on CONNECT), so nothing was fetched outside the fetch tool.
- **Only two official pages actually loaded.** For most others the fetch tool returned `ROBOTS_DISALLOWED`. That is a signal that the site's robots rules restrict automated agents on those paths. We did **not** read the `robots.txt` files themselves (fetching `https://rera.karnataka.gov.in/robots.txt` was also refused), so the exact rules are **not determined**.
- "Seen in search results" means the URL showed up in search results on an official domain. It does **not** mean we loaded the page. What a page offers is only listed when we loaded it; anything else is a lead to confirm by hand.
- We read no ToS, website policy or disclaimer page for any source. ToS: **not determined** for all sources.

## Sources

| # | Source | Official URL (status) | Data (as observed / expected) | Access method | Automation (ToS / robots) | CAPTCHA / login | Recommended approach |
|---|---|---|---|---|---|---|---|
| 1 | K-RERA home | `https://rera.karnataka.gov.in/`: **loaded** | The loaded page showed links for post-registration/quarterly-update and extension applications, a GST circular, 2018 appointment notices, and a notice: "RERA Provisional Registration Number Invalid: Need Permanent (Approved) Number from 1/4/2018 for Marketing/Sale". It showed no registration-number format. | Web portal | ToS not determined. Robots not determined (robots.txt fetch refused) | None seen on the loaded content | Manual staff lookup |
| 2 | K-RERA authority orders | `https://rera.karnataka.gov.in/viewAllProjectOrders`: **not loaded** (fetch tool: robots disallowed) | Expected: authority orders (title from search) | Not determined | Robots appear to restrict agents; ToS not determined | Not determined | Manual lookup; save the order PDF/URL and the date |
| 3 | K-RERA complaints on projects | `https://rera.karnataka.gov.in/projectComplaintReport`: **not loaded** (robots disallowed). Per-project `complaintReportWiseList?pName=<encrypted>` URLs seen in search | Expected: list of complaints for each project | Search/report pages with encrypted query parameters | Robots appear to restrict; ToS not determined | Not determined | Manual lookup; record the exact result URL and the date |
| 4 | K-RERA projects under investigation | `https://rera.karnataka.gov.in/unregProjectList`: **not loaded** | Expected: unregistered or under-investigation projects | Not determined | Not determined | Not determined | Manual lookup |
| 5 | K-RERA authority proceedings | `https://rera.karnataka.gov.in/authorityProceedingDetails?...`: **not loaded** | Expected: hearing/proceeding details | Not determined | Not determined | Not determined | Manual lookup |
| 6 | Bhoomi (Revenue Dept land records: RTC/Pahani, khata, mutation, land conversion) | `https://landrecords.karnataka.gov.in/`: **not loaded** (robots disallowed). Seen in search: `/Service84/Home/viewRTC_online`, `/service0/RTCHome.aspx`, `/Service64/` (khata), `/citizenportal/` (land conversion), `/service40/` (reports) | Expected: RTC/Pahani by survey number, mutation, conversion orders | Search forms | Robots appear to restrict; ToS not determined | Not determined | Manual lookup by a qualified professional or staff. **An online RTC view is not title evidence.** |
| 7 | IGR Karnataka / Kaveri (registration, encumbrance certificates) | `https://igr.karnataka.gov.in/info-3/Kaveri+online+Services/en` and `.../new-page/Encumbrance%20Certificate%20After%2001-04-2004/en`: **not loaded** (robots disallowed) | Expected: EC before/after 01-04-2004, certified copies, through Kaveri | Probably a citizen login with fees (not confirmed) | Not determined | Not determined (login probable) | **Do not automate.** EC is obtained by the buyer or their lawyer and reviewed by a qualified professional. |
| 8 | BBMP building plan approval | `https://site.bbmp.gov.in/buildingplan.html`: **loaded** | Links ("Click here", URLs not shown) to: approval procedure, site inspection procedure, **Plan Sanction Details**, **Commencement Certificate Details**, **Occupancy Certificate Details**, FAQ. Individual sanction PDFs appear under `site.bbmp.gov.in/PDF/Plan%20Saction%20Details%20PDF/...` (seen in search, not loaded) | Static pages and PDFs | ToS not determined; nothing visible on the loaded page | None seen | Manual lookup; save the PDF URL and the date. Note: BBMP governance may have moved to the Greater Bengaluru Authority. **Unconfirmed.** |
| 9 | BBMP occupancy certificates | `https://site.bbmp.gov.in/buildingplanoccupancy.html`: **not loaded** (robots disallowed) | Expected: OC lists | Not determined | Robots appear to restrict | Not determined | Manual lookup |
| 10 | BDA town planning | `https://bda.karnataka.gov.in/28/town-planning-section/en` (also `eng.bdabangalore.org`): **not loaded** (robots disallowed) | Expected: layout/plan approvals within the BDA area | Not determined | Not determined | Not determined | Manual lookup |
| 11 | BMRDA layout approvals / Local Planning Authorities | `https://bmrda.karnataka.gov.in/info-2/Subdivision+Layout+Approval/en`: **not loaded** (robots disallowed) | Expected: subdivision layout approvals. Much of North Bengaluru outside BBMP falls under LPAs such as BIAAPA (**unconfirmed**) | Not determined | Not determined | Not determined | Manual lookup at the competent LPA |

Not relevant: other states' RERA portals (e.g. MahaRERA) and third-party "how to check RERA" blogs. These are not sources of record.

## Access policy until permission is established

1. Every lookup is **manual, by staff**. Record `sourceId`, the exact URL, `observedAt` (ISO time), the document date if printed, and a screenshot or saved PDF.
2. No scraper, headless browser or scheduled job against any source above until `docs/DATA_SOURCE_POLICY.md` marks it `approved` with a documented permitted method. This covers written permission, an official API or a published open-data feed.
3. Never bypass CAPTCHA, login, rate limits or robots rules. The `ROBOTS_DISALLOWED` results above count as a restriction until we read and assess the rules.

## Evidence rules (enforced in `src/research/evidence.ts`, `review.ts`)

- **RERA registration ≠ title clearance.** Registration means the project was registered with the authority. It does not show clear title, valid approvals or absence of litigation.
- **Complaint searches:** never write "no complaints". Write *"No complaint found as of `<date>` in `<sources checked>`. This reflects only the sources listed, on that date, and does not confirm the absence of complaints or disputes."* If zero sources were checked, write *"Complaint records not yet checked."*
- **Registration references:** the K-RERA number format is **not confirmed** from an official page. Validation checks shape only, and the reference is stored exactly as printed.
- **Professional-review flags.** These are always present until a qualified professional records a review:
  - title verification (chain of title, from a lawyer)
  - encumbrance check (EC from Kaveri/SRO)
  - approvals validity (plan sanction, CC/OC, from the competent authority)
  - land conversion (for agricultural land, the conversion order; added when conversion is unknown or applicable)
- AI-extracted findings start as `draft` / `unverified`. Only approval by a human reviewer allows publication.

## Unconfirmed / to do (owner or staff)

- Read each source's ToS/website policy and `robots.txt` from a normal browser; record the result here.
- Confirm the K-RERA registration-number format from an official page or certificate before encoding it.
- Confirm whether K-RERA project search and complaints pages use CAPTCHA.
- Confirm current planning-authority jurisdiction (BBMP vs GBA vs BDA vs BIAAPA/LPAs) for each North Bengaluru locality.
- Ask K-RERA whether any bulk-data or API access exists, and log the request in `docs/MCP_REQUESTS.md` (the orchestrator owns that file).
