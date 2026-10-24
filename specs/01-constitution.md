# Constitution — non-negotiable rules for every agent

The business is a buyer-trust play. Every rule below exists because breaking it
destroys the one thing that makes this different from MagicBricks/99acres/Housing.
The reviewer agent blocks any PR that violates these.

## 1. Provenance or nothing
- Every fact shown to a user carries `source_url`, `source_type`, `observed_at`,
  and `last_verified_at`. If a fact has none of these, it does not render.
- Facts are never answered from model memory. The chat agent reads the store;
  if the store has nothing, it triggers the research agent (spec 05) and says
  "checking now" — it never improvises a possession date or a price.
- If research finds nothing credible, the answer is "we couldn't verify this",
  not a guess.

## 2. Three truth statuses, always visible
Every fact has `status ∈ {official, estimated, unknown}`.
- **official**: from the builder, RERA, or a government body.
- **estimated**: derived by us from public signals (spec 07). Must show the
  basis and the date. UI label: "Estimate as of {date} — not the builder's
  official figure."
- **unknown**: nothing credible found. Show "Not yet verified".
An estimate is never styled, labelled, or phrased as official.

## 3. Contradictions are shown, not resolved silently
If two sources disagree (builder site says Dec 2026, RERA extension says
Jun 2027), both are stored and both are shown with their sources. The agent
may add a one-line note on which is more authoritative, but never hides one.

## 4. History is kept forever
`facts_history` is append-only. Possession-date slips, price changes and
RERA extensions over time are the most valuable thing we publish.

## 5. Infra status tiers are mandatory
Any upcoming development shows exactly one of:
`proposed → dpr_approved → tendered → under_construction → operational`
plus `expected_completion` and its revision history. "Metro coming soon"
without a tier is a constitution violation.

## 6. Reviews and forum content: summarize, count, date, link — never republish
- Store sentiment, theme, date, source link, and at most a 20-word excerpt.
- Render as counts ("37 reviews, 11 mention delays, last 6 months") with links.
- Never render a verbatim review longer than 20 words. Never attribute a
  negative claim about a builder without a link to where it was said.

## 7. Buyer data: consent first, never sold
- No contact detail is stored without an explicit DPDP-compliant consent
  record (`leads.consent_text`, `leads.consent_at`, `leads.consent_ip`).
- Lead data goes to exactly one place: our channel partner, for that lead's
  site visit. It is never shared with builders directly, never sold, never
  used for unrelated campaigns.
- Public promise on every capture point: "We never sell or share your number.
  The only person who gets it is the one who takes you on the site visit."
- No unsolicited outbound calls, ever. Outbound WhatsApp only to opted-in leads,
  within WhatsApp's 24-hour window or via approved templates.

## 8. Source legality
- Use official APIs where they exist (Reddit, YouTube, Google Places).
- Portals (Housing, 99acres, MagicBricks, NoBroker) are rate-limited price
  signals only; never republish their listings or photos.
- LinkedIn is out of scope for automated fetching.
- Respect `robots.txt` for builder sites and news; identify with a real
  User-Agent and contact email.

## 9. Cost discipline
- Content-hash caching: an unchanged page is never re-extracted.
- Cheap model for extraction, strong model only for adjudication/writing.
- On-demand research: max 5 tasks per lead per day, max 60s per task.

## 10. No secrets in git
Keys live in Secret Manager / Supabase secrets. `.env.example` only.
