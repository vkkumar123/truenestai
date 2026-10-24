# Spec 04 — Extraction and entity resolution agent

**Needs from Fury:** Anthropic API key (cheap model for extraction, strong model
for adjudication), embedding model key (for `signals.embedding`).

## Goal
Turn any raw payload (from Loop 1 or Loop 2) into typed, provenance-carrying
rows in `facts`, `signals`, `developments`, and `aliases`. One pipeline for both
triggers — the only difference is who enqueued the payload.

## Pipeline
```
payload → clean (html→text, strip nav/ads) → chunk (≤ 3k tokens)
        → resolve entities (which project/builder/development is this about?)
        → extract (typed facts / signals / development updates)
        → validate → upsert with provenance → history trigger fires
```

### Step 1 — Clean
Readability-style main-content extraction; keep tables (cost sheets live in
tables). Drop boilerplate. Keep page title, headings, publish date if present.

### Step 2 — Resolve entities
For each chunk, find candidate entities:
1. Exact RERA number match → done, confidence 1.0.
2. `aliases` trigram search (`similarity > 0.6`) → candidates.
3. If ambiguous or no hit, strong-model adjudication prompt with the chunk +
   top 5 candidates + "none of these". On a new name with confidence ≥ 0.8,
   insert into `aliases` with `added_by='llm'`; below 0.8 write to
   `resolution_review` table for Fury to confirm (ops task, weekly).
Scope hint from the `sources` row (we already know this URL is about
project X) is passed as a strong prior but can be overridden (builder pages
often mention sister projects).

### Step 3 — Extract (cheap model, structured output)
Prompt returns JSON only, matching `02-data-model.md` attribute catalogue:
```json
{
 "facts":[{"entity_type":"project","entity_id":"...","attribute":"rera_completion_date",
           "value_date":"2027-06-30","status":"official","confidence":0.95,
           "excerpt":"Revised completion date 30-06-2027","source_type":"rera"}],
 "signals":[{"entity_type":"project","entity_id":"...","sentiment":"negative",
             "themes":["delay","quality"],"posted_at":"2026-08-12",
             "excerpt":"handover slipped twice, finishing is rough"}],
 "development_updates":[{"development_id":"...","status":"tendered",
             "expected_completion":"2029-03-01","excerpt":"...","confidence":0.8}]
}
```
Rules baked into the prompt:
- Extract only what the text says; never infer missing values.
- `status` = `official` only if `source_type ∈ {rera, builder, govt}`; news
  reporting an official figure is `official` with confidence ≤ 0.85 and the
  news URL as source; everything else is `estimated` or goes to `signals`.
- Excerpts ≤ 20 words (constitution §6).
- Dates normalised to ISO; money to INR numerics with `unit`.
- Anonymise authors: hash handle, never store it raw.

### Step 4 — Validate
- Attribute must be in the catalogue; value type must match.
- Sanity ranges: `base_psf` 3,000–30,000; completion dates within 2015–2035;
  `carpet_sba_ratio` 0.55–0.90. Out of range → confidence × 0.3 and flag.
- Duplicate signal detection by `(source_url, posted_at, excerpt hash)`.

### Step 5 — Upsert
- `facts`: upsert on `(entity_type, entity_id, attribute, source_url)`;
  set `observed_at = payload.fetched_at`, `last_verified_at = now()`,
  `ttl_hours` from the source row. The DB trigger copies the previous row
  into `facts_history`.
- Do **not** delete other sources' rows for the same attribute — conflicts
  are a feature (constitution §3). `facts_current` view handles precedence.
- `signals`: insert, compute embedding, refresh `signal_summary` lazily.
- `developments`: if `status` or `expected_completion` changed, append
  `{date_claimed, as_of, source_url}` to `completion_history`.

## Cost controls
- Skip extraction if payload `content_hash` unchanged (crawler already does).
- Batch chunks per model call where the API supports batching.
- Strong model only in Step 2 adjudication and for payloads flagged
  `high_value` (cost sheets, RERA pages).

## Observability
Table `extraction_runs(payload_uri, model, tokens_in, tokens_out, facts_n,
signals_n, errors, duration_ms)`. Daily rollup to BigQuery.

## Done when
Seeded payloads for 10 projects produce facts with correct `status`, a
deliberate builder-vs-RERA date conflict shows in `facts_current.conflicts`,
a Reddit thread yields signals with themes, and an unknown project name lands
in `resolution_review`.
