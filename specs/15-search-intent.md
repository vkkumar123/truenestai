# Spec 15 — Search: intent parser + fuzzy catalogue match

**Owner agents:** backend-data-engineer (`src/search/intent.ts`, repository, migration 0007),
frontend-engineer (filter chips from parsed intent), test-engineer.
**Needs from Fury:** nothing.

## Why
`listProjects` ILIKEs the whole query against name/slug/developer. "2 BHK under 1 Cr in
Yelahanka ready to move" can only match via the locality alias. Buyers type sentences.

## A. Intent parser (deterministic first, LLM fallback)
Input: raw text (≤ 100 chars). Output:
```ts
{ localityIds: string[]; bhk?: "1"|"2"|"3"|"4"|"5+"; budgetMinInr?: number; budgetMaxInr?: number;
  builderIds: string[]; status?: ConstructionStatus; possessionBy?: string; keywords: string[];
  parsedBy: "rules"|"llm"; confidence: number }
```
Rules: locality via `findLocalitiesByText` (all matches); builder via `aliases` trigram
≥ 0.5; BHK `(\d)\s*bhk|(\d)\s*bed`; budget `(under|below|upto|<)?\s*₹?\s*(\d+(\.\d+)?)\s*(l|lakh|lac|cr|crore)`
with ranges "80L–1.2Cr"; status words (ready, under construction, new launch, pre-launch,
OC received); possession "by 2027/2028". Remaining tokens minus stopwords ("new", "apartment",
"flat", "project", "in", "near") → `keywords`. If nothing but keywords parsed and text has
≥ 4 words, call the cheap model once with the same output schema (cached by text hash, 24 h).

## B. Catalogue match
Migration 0007: `projects.search_document tsvector` + `search_text text` (name + slug +
builder + locality + aliases), `pg_trgm` GIN index. `listProjects` ranks by: exact RERA match
> builder match > trigram similarity(search_text, keywords) ≥ 0.3 > locality-only. Filters
(bhk, status, budget vs `facts_current.base_psf × typical sba`) applied before limit.
UI shows parsed intent as removable chips ("Yelahanka ×", "2 BHK ×", "≤ ₹1 Cr ×") so the
buyer sees what was understood.

## C. Gap detector handoff
After catalogue match: if `researched.length < MIN_RESEARCHED_RESULTS` enqueue research with
`trigger='gap'`, the parsed intent (not the raw sentence) as the query, and `attribute` when
the miss is attribute-specific (e.g. budget filter removed everything → `base_psf`).

## Done when
20 sample sentences parse to the expected intent (unit table); "Assetz Yelahanka 3 BHK" finds
Assetz projects in Yelahanka with 3 BHK; "flats near Manyata under 90L" resolves to the
nearest localities (Thanisandra/Hebbal/Nagawara via a development-proximity hint) and budget
≤ 90,00,000; chips render and remove correctly.
