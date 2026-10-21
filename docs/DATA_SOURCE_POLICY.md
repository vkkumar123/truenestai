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
