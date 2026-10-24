# Spec 08 — Area brief generator (per project and per locality)

**Needs from Fury:** nothing new; strong model via existing key.

## Goal
Short, dated, sourced prose that answers "what is happening around this
property and how real is it?" Composed only from `developments`,
`project_development_proximity`, locality `facts`, and `signal_summary`.
Never from model memory.

## Inputs
- `get_project_proximity(project_id)` (spec 06)
- locality facts: `avg_psf, psf_trend_12m, water_supply_note, flooding_note,
  major_employers, school_hospital_note`
- `signal_summary(locality)` and `signal_summary(project_id)`

## Output (stored as `facts` rows with `attribute='area_brief'`, value_json)
```json
{"as_of":"2026-10-23",
 "headline":"Thanisandra: metro 2026, road widening tendered, water still patchy",
 "sections":[
  {"title":"Transit","items":[{"text":"Blue Line Thanisandra station ~1.1 km — under construction, expected 2026 (revised once)","development_id":"...","source_url":"...","verified":"2026-10-20"}]},
  {"title":"Roads","items":[...]},
  {"title":"Jobs nearby","items":[{"text":"Manyata Tech Park 4.2 km / 18 min at 9 AM"}]},
  {"title":"Water & utilities","items":[...]},
  {"title":"Government plans","items":[...]},
  {"title":"What residents say","items":[{"text":"41 forum/review mentions in 12 months: 14 water, 9 traffic, 6 delay — see sources"}]}
 ],
 "caveats":["Infra timelines in Bengaluru slip frequently; tiers and revision counts shown."]}
```
Locality brief = same shape without distances, with a 12-month psf trend
line and a "what launched / what's coming" list.

## Writing rules (prompt)
- Every item cites a development or fact id; drop anything without one.
- Include the status tier and revision count for every development.
- Distances: straight-line in km (1 decimal) and drive time if present;
  say "straight-line" explicitly.
- Never use "coming soon", "upcoming" without a tier and a date.
- Plain language, ≤ 180 words per project brief, ≤ 400 per locality brief.
- Resident sentiment: counts and themes only, linked (constitution §6).

## Refresh
Regenerate when any input `last_verified_at` is newer than the brief's
`as_of`, or weekly. Cache by input hash.

## Done when
10 seeded projects have briefs; changing one development's tier regenerates
only the affected briefs; a brief with a missing citation fails validation.
