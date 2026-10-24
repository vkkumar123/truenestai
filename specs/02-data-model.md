# Spec 02 — Data model

**Needs from Fury:** Supabase project ref + service key (MCP already connected);
GCP project id for BigQuery datasets `nb_re_raw`, `nb_re_core`.

## Goal
One schema that both loops (scheduled crawl, on-demand research) write to and
the site + WhatsApp agent read from. Supabase is the serving store; BigQuery
holds raw payloads and analytics copies.

## Supabase (Postgres) — enable `postgis`, `vector`, `pg_trgm`

### projects
```sql
create table projects (
  project_id        text primary key,           -- slug, e.g. 'brigade-eldorado-bagalur'
  canonical_name    text not null,
  builder_id        text references builders(builder_id),
  rera_number       text unique,
  locality          text not null,              -- one of the v1 micro-market list
  geom              geography(point, 4326),
  geocode_source    text,                       -- 'rera_survey', 'builder_map', 'google_geocode', 'manual'
  geocode_confidence numeric,
  status            text,                       -- 'launched','under_construction','ready','sold_out'
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index on projects using gist (geom);
```

### builders
```sql
create table builders (
  builder_id   text primary key,
  name         text not null,
  website      text,
  rera_promoter_id text
);
```

### aliases — messy names → canonical ids (grows via extraction agent)
```sql
create table aliases (
  alias        text,
  entity_type  text check (entity_type in ('project','builder','development','locality')),
  entity_id    text,
  confidence   numeric,
  added_by     text,                            -- 'rera','fuzzy','llm','manual'
  primary key (alias, entity_type)
);
create index on aliases using gin (alias gin_trgm_ops);
```

### sources — the crawl registry (drives Loop 1)
```sql
create table sources (
  source_id        bigserial primary key,
  scope_type       text check (scope_type in ('project','builder','locality','development','global')),
  scope_id         text,
  adapter          text not null,               -- 'rera_karnataka','builder_site','google_places','reddit','youtube','news_rss','portal_price','govt_notice'
  url              text,
  cadence_hours    int not null,
  ttl_hours        int not null,                -- freshness window for facts from this source
  last_fetched_at  timestamptz,
  last_content_hash text,
  last_status      text,
  enabled          boolean default true,
  unique (scope_type, scope_id, adapter, url)
);
```

### facts — current view, one row per (entity, attribute)
```sql
create table facts (
  fact_id          bigserial primary key,
  entity_type      text not null,               -- 'project','builder','development','locality'
  entity_id        text not null,
  attribute        text not null,               -- see attribute catalogue below
  value_text       text,
  value_num        numeric,
  value_date       date,
  value_json       jsonb,
  unit             text,
  status           text not null check (status in ('official','estimated','unknown')),
  confidence       numeric,
  estimate_basis   jsonb,                       -- for status='estimated': sources + assumptions
  source_url       text,
  source_type      text,                        -- 'rera','builder','govt','news','reddit','youtube','google_reviews','portal','search'
  observed_at      timestamptz not null,
  last_verified_at timestamptz not null,
  ttl_hours        int not null,
  excerpt          text,                        -- <= 20 words
  unique (entity_type, entity_id, attribute, source_url)
);
create index on facts (entity_type, entity_id, attribute);
```
Rule: for one (entity, attribute) there may be several rows from different
sources. A view `facts_current` picks the most authoritative per attribute
(official > estimated > unknown; then newest `observed_at`) **and** exposes
`conflicts jsonb` listing every other row so the UI can show contradictions.

### facts_history — append-only
Same columns as `facts` plus `superseded_at`. Trigger copies every
UPDATE/DELETE on `facts` into here. Never deleted.

### signals — reviews, threads, comments
```sql
create table signals (
  signal_id     bigserial primary key,
  entity_type   text, entity_id text,
  source_type   text,                           -- 'google_reviews','reddit','youtube','x','forum'
  source_url    text,
  author_hash   text,                           -- hashed, never raw handle
  posted_at     timestamptz,
  sentiment     text check (sentiment in ('positive','neutral','negative')),
  themes        text[],                         -- 'delay','quality','water','maintenance','legal','pricing','amenities','connectivity'
  excerpt       text,                           -- <= 20 words
  embedding     vector(1024),
  ingested_at   timestamptz default now()
);
```
Materialized view `signal_summary(entity_id)` → counts by theme/sentiment for
last 6 and 24 months.

### developments — place-centric infra (spec 06)
```sql
create table developments (
  development_id      text primary key,
  name                text not null,
  type                text,                     -- 'metro','suburban_rail','road','flyover','employment','hospital','school','mall','water','zoning','other'
  geom                geography,                -- point or linestring
  status              text check (status in ('proposed','dpr_approved','tendered','under_construction','operational','shelved')),
  announced_date      date,
  expected_completion date,
  completion_history  jsonb,                    -- [{date_claimed, as_of, source_url}]
  authority           text,                     -- 'BMRCL','BDA','KRDCL','NHAI','KIADB','BBMP','BWSSB','DULT','K-RIDE','other'
  source_url          text,
  last_verified_at    timestamptz,
  confidence          numeric
);
create index on developments using gist (geom);
```

### project_development_proximity
```sql
create table project_development_proximity (
  project_id       text references projects,
  development_id   text references developments,
  straight_line_m  int,
  drive_min_9am    int,                         -- optional, Google Distance Matrix
  computed_at      timestamptz,
  primary key (project_id, development_id)
);
```

### cost_sheets (spec 07)
```sql
create table cost_sheets (
  cost_sheet_id   bigserial primary key,
  project_id      text references projects,
  unit_type       text,                         -- '2BHK','3BHK', '3BHK-L'
  carpet_sqft     numeric, sba_sqft numeric,
  status          text check (status in ('official','estimated','unknown')),
  base_psf_low    numeric, base_psf_high numeric,
  line_items      jsonb,                        -- [{name, amount_low, amount_high, basis}]
  total_low       numeric, total_high numeric,
  basis           jsonb,                        -- sources + assumption table version
  as_of           date,
  ttl_hours       int,
  source_url      text
);
```

### research_tasks (spec 05 queue)
```sql
create table research_tasks (
  task_id       bigserial primary key,
  trigger       text,                           -- 'gap','stale','user_question','low_confidence','page_build'
  entity_type   text, entity_id text,
  question      text not null,
  requested_by  text,                           -- lead_id or 'system'
  status        text default 'queued',          -- queued, running, done, failed, nothing_found
  result_fact_ids bigint[],
  created_at    timestamptz default now(),
  finished_at   timestamptz
);
```

### leads (specs 10, 11)
```sql
create table leads (
  lead_id          text primary key,            -- 'NB-2026-000123'
  phone_e164       text, name text,
  source_page      text, source_project_id text,
  consent_text     text not null, consent_at timestamptz not null, consent_ip text,
  budget_min numeric, budget_max numeric,
  config           text[], localities text[],
  timeline         text,                        -- 'ready','6m','12m','18m+'
  loan_status      text,                        -- 'pre_approved','applying','self_funded','unknown'
  score            int, stage text,             -- 'new','qualified','visit_scheduled','visited','booked','lost'
  handoff_brief    text, handed_off_at timestamptz,
  partner_ref      text, booking_value numeric, booked_at timestamptz,
  created_at timestamptz default now()
);
```

### conversations — WhatsApp transcript per lead (append-only messages table).

## Attribute catalogue (facts.attribute)
project: `rera_status, rera_registration_date, rera_completion_date,
rera_extension_count, rera_complaints_count, promised_possession,
current_possession_claim, total_units, towers, floors, land_area_acres,
carpet_sba_ratio, oc_status, khata_type, land_title_summary, bank_approvals,
base_psf, floor_rise_psf, plc_note, car_park_cost, clubhouse_cost,
maintenance_psf_month, maintenance_deposit_months, amenities, launch_date,
water_source, stp_status, builder_track_record_note`
development: `status, expected_completion, budget_cr, length_km, stations`
locality: `avg_psf, psf_trend_12m, water_supply_note, flooding_note,
major_employers, school_hospital_note`

## BigQuery
- `nb_re_raw.<adapter>_payloads` — raw HTML/JSON, `fetched_at`, `content_hash`, `source_id`.
- `nb_re_core.*` — nightly mirror of every Supabase table for analytics/history.

## Done when
Migrations applied via Supabase MCP, `facts_current` view and history trigger
tested with a conflict case, `signal_summary` refreshes, seed of 10 projects
+ 10 developments loaded by hand for downstream specs to test against.
