# Data source policy (Lane B: external discovery)

Owner: property-discovery-engineer. Code: `src/discovery/registry.ts` (the source registry is the only source of truth for what may run).

## 1. Allowlisting process
1. Add the source to the registry as `status: "proposed"` with `allowedEnvironments: []` and `rateLimitPerMinute: 0`.
2. Review the source's terms of use, robots rules, and any API or partner terms. Write down who reviewed them, the date, the permitted access method and which fields may be stored. Link to that record in `notes` and set `termsReviewedAt`.
3. The owner approves the change in writing, and the decision goes in `docs/DECISIONS.md`. Integrations that need owner action are tracked in `docs/MCP_REQUESTS.md`.
4. Set the source to `approved` and list its environments. `assertRunnable(source, env)` refuses every source that is not approved or not allowed in the current environment.
5. Status values: `proposed` (default, never runs), `approved`, `suspended` (stopped while an issue is resolved), `rejected` (will not be used).

## 2. Required fields per source
`id`, `name`, `type` (SourceType), `status`, `accessMethod`, `homepage`, `termsReviewedAt` (null until a review is documented), `robotsNotes`, `rateLimitPerMinute`, `storagePermissions`, `allowedEnvironments`, `listingLimitations`, `notes`.

## 3. Permitted access methods
`api` or `partner_feed` (under documented terms or an agreement), `licensed` (paid or contracted data), `link_out_only` (we store only the URL and send buyers to the source), `manual` (a human records short facts with a link), and `fixture` (fictional in-repo data, test and development only, never production).

## 4. Prohibited practices
- Scraping any source that is not approved for automated access.
- Bypassing logins, paywalls, CAPTCHA, bot detection, rate limits or IP blocks, or rotating identities to avoid them.
- Ignoring robots rules or a site's published terms.
- Copying full listings, descriptions, floor plans, photos or other images, or reproducing a source's database.
- Collecting personal data of agents, owners or other users from listings.
- Presenting external data as verified, or inventing records, prices, RERA numbers or URLs.

## 5. Storage limits
- Store only the fields in the source's `storagePermissions`. `normalize()` drops all other fields.
- Allowed fields are short factual ones only: title (at most 100 characters, tags stripped), developer name, locality, approximate location, price text as shown (at most 40 characters), canonical URL, source record id, RERA number and address.
- No images and no long descriptions. Keep `discoveredAt` and `lastSeenAt`, and expire records that the source no longer shows.

## 6. Link-out alternative
When storage is not permitted, or terms are unclear, use `link_out_only`. We show a link to the source's own page and nothing copied from it. This is the default route for regulator portals and listing portals until an agreement exists.

## 7. Labelling requirements (Lane B)
Every external result must show:
- the "Not verified by TrueNest" label (always the first limitation)
- the source name and canonical URL
- the discovered and last-seen dates
- the source-specific limitations

Prices are "as listed by the source". Fixture records are marked `isSample: true` and labelled SAMPLE. External listings are never shown as researched (Lane A) projects.

## 8. Dedupe rules (`src/discovery/dedupe.ts`)
- **Strong keys** (merge): the same RERA number; the same source id plus source record id; the same normalised canonical URL (host lowercased, `www.` and a trailing slash removed, tracking parameters and the fragment removed).
- **Secondary keys** (merge): the same normalised developer, plus either the same normalised address or coordinates within 150 m.
- If both records have RERA numbers and they differ, neither the strong nor the secondary keys merge them. The pair is flagged `conflicting_rera`.
- Clustering is transitive, but a union is refused if the two clusters already hold different RERA numbers. For example, A (RERA X) and C (RERA Y) never merge through a record B that has no RERA number. That pair is flagged `conflicting_rera`, and the flag is always kept.
- Strong-key merges are applied before secondary-key merges. A secondary merge is refused if the combined cluster would spread beyond 150 m. That pair is flagged `ambiguous_chain`.
- Canonical URLs must parse as `https:`. A record with an invalid URL is dropped and reported as an error.
- **Similar names alone never merge.** A name similarity of 0.8 or more with no other match produces a `possible_duplicate` flag for human review.
- A listing is linked to a researched project (`matchedProjectId`) only by RERA number. Any weaker match is flagged for review.

## 9. Takedown and correction handling
- When a source or rights holder asks for removal, suspend the source or remove the record within 2 business days, and log the request and the action taken.
- Buyer or developer corrections: flag the record, re-check it against the source, and correct or remove it. Do not edit the source's facts by hand to look verified.
- When a source changes its terms or objects to our use, set it to `suspended` immediately while the change is reviewed.

## 10. Review cadence
- Re-review the terms and robots rules of every approved source at least every 6 months, and whenever its terms change.
- Re-check rate limits and storage permissions at the same time, and record the date in `termsReviewedAt`.
- Review proposed sources each quarter, and reject the ones we will not pursue.

## 11. Registry entries: current status

| Source id | Type | Status | Access | Runs in | Notes |
|---|---|---|---|---|---|
| `sample-feed`, `sample-feed-mirror` | fixture | approved | fixture | test, development | Fictional Lane B records. Never production. |
| `sample-web-research` | fixture | approved | fixture | test, development | Stands in for `anthropic-web-search` in fixture mode, unit tests, e2e and CI. Uses the fake research client; never the network. |
| `anthropic-web-search` | developer | approved 2026-10-22 (D16) | api | `production` only (staging also runs `NODE_ENV=production`); never test, CI or development | See 11.1. |
| `k-rera` | regulator | proposed, never runnable | link_out_only | none | robots.txt disallows automated access (checked 2026-10-22, D16). No crawler, ever. Link-out and manual staff lookups only. |
| `99acres`, `magicbricks`, `housing-com`, `nobroker` | listing_portal | proposed | manual | none | Not reviewed. Also blocked from web research (11.2). |

### 11.1 `anthropic-web-search` (on-demand web research)
- **Decision:** the owner chose "Web search + developer sites + K-RERA" on 2026-10-22 (DECISIONS D16). The source is `approved` with `termsReviewedAt: "2026-10-22"`, `rateLimitPerMinute: 10` and `allowedEnvironments: ["production"]`. `assertRunnable` refuses it in test, CI and development, which use `sample-web-research` with the fake client. K-RERA itself stays link-out only (robots-disallowed, see the table).
- **Access method:** `api`. TrueNest calls Anthropic's Messages API with the server-side web search tool. Anthropic searches and reads the pages; TrueNest never fetches, crawls or scrapes a page, and never fetches K-RERA pages.
- **What may be stored:** short factual fields only (title, developer name, locality, address, price text as shown, RERA number) plus the cited page URL. Each one is stored only when its value appears verbatim in a citation the API returned for that URL, and only when the URL appeared in that response's web search results (`src/discovery/research/validate.ts`). The model's own JSON, including its own quote field, is never treated as evidence.
- **Same-citation rule:** every stored fact (developer, address, price, RERA number, locality) must appear in the same citation as the project's name, within 200 characters of it. A fact cited elsewhere on the page is dropped, so facts from one project are never attributed to another.
- **Strict matching:** a RERA number must equal a whole token of the citation (no fragment of a longer number, no splice across words). A price must not begin or end inside a number ("45 L" never matches "1.45 L"; "5 Cr" never matches "2.5 Cr").
- **Stored URL:** the URL exactly as the web search tool returned it, never the model's spelling of it.
- **Locality:** a candidate must map to exactly one active locality in `src/config/markets/` through the existing alias matching, and that locality must itself appear in the citation next to the name. Anything else is dropped.
- **RERA numbers:** may be stored when cited verbatim, including in a citation that points at a K-RERA page that web search surfaced (D16). RERA registration is not title clearance. A listing links to a researched project only by RERA number, as for every Lane B source.
- **Labels:** every stored listing is Lane B with "Not verified by TrueNest" first, then "Found by automated web research; details may be out of date or incomplete", the source name, the cited URL, and the discovered and last-seen dates. Nothing becomes a researched (Lane A) project automatically, and the worker never publishes or verifies anything.
- **One page, one record:** a page is treated as a multi-project page, and every candidate from it is dropped, when its citations contain more than one distinct project registration number (agent "AG" numbers excluded) or when it yields several different project names. The canonical URL is a strong dedupe key, so they would otherwise merge.
- **Takedown:** deleting an `external_listings` row also removes its research-job link. Suspending the source hides every stored result at once, because search shows research listings only while the source is runnable.

### 11.2 Listing portals excluded from research
`99acres.com`, `magicbricks.com`, `housing.com`, `nobroker.in`, `commonfloor.com`, `squareyards.com` and `makaan.com`, including their subdomains, are passed to the web search tool as `blocked_domains`. Any candidate whose URL is on one of these hosts is dropped (`src/discovery/research/portals.ts`). We do **not** keep a link-out row for them: their registry entries are not approved, and a link-out row would still copy the portal's title and facts. Revisit this only if a portal is approved as `link_out_only` or under an agreement.

### 11.3 `anthropic-web-search` for area developments (S4a, D20; storage grant from Fury's 2026-10-24 request, rest proposed)
- **Same access method.** This is the Messages API with server-side web search. TrueNest fetches, crawls or scrapes nothing, and authority sites (BMRCL, K-RIDE, BDA, BBMP, NHAI, KIADB, BIAL) are only read through cited search results.
- **Permission:** the registry field `development_fields` is granted to `anthropic-web-search` (Fury's request of 2026-10-24, D20) and `sample-web-research`. Research is refused for any source without it.
- **What may be stored, per development:** name, type (our classification), stage (derived from a cited stage phrase), authority, expected completion as declared, the locality served (configured localities only) and the cited URL. Each value is kept only when it appears verbatim in a citation for a URL from that response's search results, in the same citation as the name and within 200 characters of it, the locality included (`src/discovery/research/developments.ts`). A stage phrase that is negated or in the future ("has not been approved", "will be opened") states no stage, so the item is dropped. A year that is an amount or a distance ("Rs 2,030 crore", "2030 km") or a piece of a financial year ("2027" out of "2027-28") is not kept. The horizon is last year to +10 years. Coordinates are never researched; staff add them.
- **Reviewed rows are never overwritten.** Once a row is published, rejected or edited by staff, research that contradicts it is recorded as a pending change (and in the audit). It does not refresh the public "last checked" date.
- **Labels.** Rows are stored unverified and shown only after staff publish them. Each one shows its source link, the date it was seen and the date it was last checked, under the disclaimer "Plans can change, be delayed or be cancelled. Not a prediction of property prices or returns." A declared date is never presented as a TrueNest estimate or a guarantee, and no appreciation or return claim is stored or shown.
- **Environments.** As in 11.1: production only. Test, CI and development use `sample-web-research` with the fake client and SAMPLE example.org pages.
