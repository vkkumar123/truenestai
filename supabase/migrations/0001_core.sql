-- TrueNest AI — core schema (Phase 1, North Bengaluru).
-- Mirrors src/domain/types.ts. Every material fact carries provenance (facts + fact_sources).
-- `status = 'unknown'` means "not found yet" and is NEVER a negative finding.
--
-- Roles: Supabase provides anon, authenticated, service_role and auth.uid(). service_role
-- bypasses RLS and is used server-side only. RLS is enabled on EVERY table below.
--
-- PostGIS is intentionally not used yet (the local test Postgres lacks it). Coordinates are
-- numeric lat/lng + precision. A later migration may add a geography column + GiST index.

begin;

-- ---------------------------------------------------------------------------
-- Shared value checks (kept as text + CHECK so they map 1:1 to the TS unions)
-- ---------------------------------------------------------------------------
create or replace function public.tn_is_verification_state(v text) returns boolean
language sql immutable as $$
  select v in ('unverified','source_confirmed','reviewed','disputed','requires_professional_review')
$$;

create or replace function public.tn_is_geo_precision(v text) returns boolean
language sql immutable as $$
  select v in ('exact','approximate','locality_centroid')
$$;

-- ---------------------------------------------------------------------------
-- Market geography (mirror of src/config/markets — config is the source of truth)
-- ---------------------------------------------------------------------------
create table public.market_phases (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  sort_order integer not null check (sort_order > 0),
  active boolean not null default false
);

create table public.zones (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  phase_id text not null references public.market_phases(id),
  name text not null,
  boundary jsonb not null,                       -- GeoJSON Polygon
  boundary_approval text not null default 'pending_owner_approval'
    check (boundary_approval in ('pending_owner_approval','approved')),
  assumptions text[] not null default '{}'
);

create table public.localities (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  zone_id text not null references public.zones(id),
  name text not null,
  centroid_lat numeric(9,6) not null check (centroid_lat between -90 and 90),
  centroid_lng numeric(9,6) not null check (centroid_lng between -180 and 180),
  aliases text[] not null default '{}',
  boundary jsonb
);

-- ---------------------------------------------------------------------------
-- Source registry mirror (src/discovery/registry.ts is the source of truth)
-- ---------------------------------------------------------------------------
create table public.sources (
  id text primary key,
  name text not null,
  type text not null check (type in
    ('regulator','government','developer','listing_portal','partner_feed','news','field_visit','fixture')),
  status text not null default 'proposed' check (status in ('proposed','approved','suspended','rejected')),
  access_method text not null check (access_method in
    ('api','partner_feed','licensed','link_out_only','manual','fixture')),
  homepage text not null,
  terms_reviewed_at date,
  rate_limit_per_minute integer not null default 0 check (rate_limit_per_minute >= 0),
  storage_permissions text[] not null default '{}',
  allowed_environments text[] not null default '{}',
  listing_limitations text[] not null default '{}',
  notes text not null default '',
  -- an approved non-fixture source must have a documented terms review
  constraint sources_approved_reviewed check (
    status <> 'approved' or type = 'fixture' or terms_reviewed_at is not null)
);

-- ---------------------------------------------------------------------------
-- Lane A: researched projects
-- ---------------------------------------------------------------------------
create table public.developers (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  is_sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.projects (
  id text primary key default gen_random_uuid()::text,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  developer_id text not null references public.developers(id),
  locality_id text not null references public.localities(id),
  lat numeric(9,6) not null check (lat between -90 and 90),
  lng numeric(9,6) not null check (lng between -180 and 180),
  location_precision text not null check (public.tn_is_geo_precision(location_precision)),
  review_flags text[] not null default '{}',
  completeness numeric(4,3) not null default 0 check (completeness between 0 and 1),
  last_checked_at timestamptz not null default now(),
  is_sample boolean not null default false,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_locality_published_idx on public.projects (locality_id) where published;

create table public.project_units (
  id text primary key default gen_random_uuid()::text,
  project_id text not null references public.projects(id) on delete cascade,
  label text not null,
  sort_order integer not null default 0,
  unique (project_id, label)
);

-- One row per observed value of one field. History is kept; `is_current` marks the value shown.
create table public.facts (
  id text primary key default gen_random_uuid()::text,
  project_id text not null references public.projects(id) on delete cascade,
  unit_id text references public.project_units(id) on delete cascade,
  field text not null check (field in
    ('address','rera_numbers','construction_status','declared_possession','unit_carpet_area_sqft','unit_price_inr')),
  value jsonb,
  status text not null check (status in ('known','unknown')),
  verification text not null default 'unverified' check (public.tn_is_verification_state(verification)),
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  -- unknown has no value; known must have one
  constraint facts_value_matches_status check (
    (status = 'unknown' and value is null) or (status = 'known' and value is not null)),
  constraint facts_unit_fields check (
    (field like 'unit\_%' and unit_id is not null) or (field not like 'unit\_%' and unit_id is null)),
  constraint facts_construction_status_value check (
    field <> 'construction_status' or value is null or (value #>> '{}') in
      ('pre_launch','under_construction','ready_to_move','completed','stalled','unknown'))
);
create unique index facts_current_uq on public.facts
  (project_id, field, coalesce(unit_id, '')) where is_current;

create table public.fact_sources (
  id text primary key default gen_random_uuid()::text,
  fact_id text not null references public.facts(id) on delete cascade,
  source_id text not null references public.sources(id),
  url text,
  observed_at timestamptz not null,
  document_date date,
  note text
);
create index fact_sources_fact_idx on public.fact_sources (fact_id);

-- Raw observation log (what a worker saw, when). Internal: never readable by the public.
create table public.source_observations (
  id text primary key default gen_random_uuid()::text,
  source_id text not null references public.sources(id),
  project_id text references public.projects(id) on delete set null,
  external_listing_id text,
  url text,
  observed_at timestamptz not null default now(),
  content_hash text,
  fields jsonb not null default '{}'::jsonb   -- only fields the source permits us to store
);

create table public.regulatory_records (
  id text primary key default gen_random_uuid()::text,
  project_id text not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('rera_registration','complaint','order','extension','other_disclosure')),
  reference text,
  summary text not null,
  status_status text not null check (status_status in ('known','unknown')),
  status_value text,
  status_verification text not null default 'unverified' check (public.tn_is_verification_state(status_verification)),
  source_id text not null references public.sources(id),
  source_url text,
  observed_at timestamptz not null,
  document_date date,
  verification text not null default 'unverified' check (public.tn_is_verification_state(verification)),
  created_at timestamptz not null default now(),
  constraint regulatory_status_value check (
    (status_status = 'unknown' and status_value is null) or (status_status = 'known' and status_value is not null))
);

-- Searches that found nothing are recorded explicitly, so "none found on <date> in <source>"
-- is distinguishable from "never searched" (unknown). Never presented as "clean".
create table public.regulatory_searches (
  id text primary key default gen_random_uuid()::text,
  project_id text not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('rera_registration','complaint','order','extension','other_disclosure')),
  source_id text not null references public.sources(id),
  searched_at timestamptz not null,
  results_found integer not null check (results_found >= 0),
  note text
);

create table public.project_documents (
  id text primary key default gen_random_uuid()::text,
  project_id text not null references public.projects(id) on delete cascade,
  document_key text not null,                    -- stable identity across versions
  title text not null,
  kind text not null check (kind in ('approval','brochure','rera_certificate','plan','other')),
  version integer not null default 1 check (version >= 1),
  document_date date,
  source_id text not null references public.sources(id),
  source_url text,
  observed_at timestamptz not null,
  storage_path text,                             -- private storage object; not public
  created_at timestamptz not null default now(),
  unique (project_id, document_key, version)
);

-- ---------------------------------------------------------------------------
-- Locality context
-- ---------------------------------------------------------------------------
create table public.infrastructure_items (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  category text not null check (category in ('metro','rail','road','airport','water','power','other')),
  stage text not null check (stage in ('proposed','approved','tendered','under_construction','operational')),
  locality_ids text[] not null default '{}',
  lat numeric(9,6) check (lat between -90 and 90),
  lng numeric(9,6) check (lng between -180 and 180),
  location_precision text check (location_precision is null or public.tn_is_geo_precision(location_precision)),
  declared_completion jsonb not null,            -- FactValue<string>
  sources jsonb not null default '[]'::jsonb,    -- SourceRef[]
  last_checked_at timestamptz not null default now(),
  is_sample boolean not null default false,
  published boolean not null default false,
  constraint infra_location_complete check ((lat is null) = (lng is null) and (lat is null) = (location_precision is null))
);

create table public.amenities (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  category text not null check (category in ('school','college','healthcare','retail','park','transit','other')),
  locality_id text references public.localities(id),
  lat numeric(9,6) not null check (lat between -90 and 90),
  lng numeric(9,6) not null check (lng between -180 and 180),
  location_precision text not null check (public.tn_is_geo_precision(location_precision)),
  source_id text not null references public.sources(id),
  source_url text,
  observed_at timestamptz not null,
  is_sample boolean not null default false
);

-- ---------------------------------------------------------------------------
-- Lane B: external (always unverified) listings
-- ---------------------------------------------------------------------------
create table public.external_listings (
  id text primary key,                           -- "<sourceId>:<sourceRecordId|urlhash>"
  source_id text not null references public.sources(id),
  source_record_id text,
  canonical_url text not null check (canonical_url ~ '^https://'),
  title text not null check (char_length(title) <= 100),
  developer_name text,
  locality_id text references public.localities(id),
  lat numeric(9,6) check (lat between -90 and 90),
  lng numeric(9,6) check (lng between -180 and 180),
  location_precision text check (location_precision is null or public.tn_is_geo_precision(location_precision)),
  price_text text check (price_text is null or char_length(price_text) <= 40),
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  limitations text[] not null check (cardinality(limitations) >= 1),
  matched_project_id text references public.projects(id) on delete set null,
  is_sample boolean not null default false,
  unique (source_id, source_record_id),
  unique (source_id, canonical_url),
  constraint external_location_complete check ((lat is null) = (lng is null) and (lat is null) = (location_precision is null))
);
alter table public.source_observations
  add constraint source_observations_external_fk
  foreign key (external_listing_id) references public.external_listings(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Staff & leads
-- ---------------------------------------------------------------------------
create table public.staff_profiles (
  user_id uuid primary key,                      -- auth.users.id
  role text not null check (role in ('advisor','admin')),
  display_name text,
  created_at timestamptz not null default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  request_type text not null check (request_type in ('verification','buyer_assistance')),
  name text not null check (char_length(name) between 1 and 80),
  email text check (email is null or char_length(email) <= 254),
  phone text check (phone is null or phone ~ '^\+91[6-9][0-9]{9}$'),
  preferred_channel text not null check (preferred_channel in ('phone','email','whatsapp')),
  message text check (message is null or char_length(message) <= 1000),
  project_id text references public.projects(id) on delete set null,
  external_listing_id text references public.external_listings(id) on delete set null,
  budget_band text check (budget_band is null or budget_band in
    ('under_50l','50l_1cr','1cr_1_5cr','1_5cr_2cr','2cr_3cr','above_3cr')),
  contact_consent boolean not null,
  marketing_consent boolean not null default false,
  consent_text_version text not null,
  consented_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new','contacted','qualified','closed','withdrawn')),
  qualification_score integer check (qualification_score between 0 and 100),
  qualification_tier text check (qualification_tier in ('high','medium','low')),
  qualification_reasons text[],                  -- explainable, no PII
  attribution jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retention_until timestamptz not null default (now() + interval '12 months'),
  -- consent is required to hold a live lead; withdrawn leads keep only an erased audit stub
  constraint leads_consent_required check (contact_consent or status = 'withdrawn'),
  constraint leads_contact_present check (email is not null or phone is not null or status = 'withdrawn'),
  constraint leads_single_property check (project_id is null or external_listing_id is null)
);
create index leads_status_created_idx on public.leads (status, created_at desc);
create index leads_retention_idx on public.leads (retention_until);

-- Audit trail. No personal data in events.
create table public.lead_events (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads(id) on delete cascade,
  actor_id uuid,                                 -- null = public submitter / system
  event_type text not null check (event_type in ('created','status_changed','erased','retention_purged')),
  from_status text,
  to_status text,
  created_at timestamptz not null default now()
);
create index lead_events_lead_idx on public.lead_events (lead_id, created_at);

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff_profiles where user_id = auth.uid())
$$;

create or replace function public.staff_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.staff_profiles where user_id = auth.uid()
$$;

create or replace function public.is_published_project(pid text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.projects where id = pid and published)
$$;

revoke all on function public.is_staff() from public;
revoke all on function public.staff_role() from public;
revoke all on function public.is_published_project(text) from public;
grant execute on function public.is_staff() to anon, authenticated, service_role;
grant execute on function public.staff_role() to anon, authenticated, service_role;
grant execute on function public.is_published_project(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled on every table
-- ---------------------------------------------------------------------------
alter table public.market_phases        enable row level security;
alter table public.zones                enable row level security;
alter table public.localities           enable row level security;
alter table public.sources              enable row level security;
alter table public.developers           enable row level security;
alter table public.projects             enable row level security;
alter table public.project_units        enable row level security;
alter table public.facts                enable row level security;
alter table public.fact_sources         enable row level security;
alter table public.source_observations  enable row level security;
alter table public.regulatory_records   enable row level security;
alter table public.regulatory_searches  enable row level security;
alter table public.project_documents    enable row level security;
alter table public.infrastructure_items enable row level security;
alter table public.amenities            enable row level security;
alter table public.external_listings    enable row level security;
alter table public.staff_profiles       enable row level security;
alter table public.leads                enable row level security;
alter table public.lead_events          enable row level security;

-- Start from zero privileges for client roles, then grant explicitly.
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Public reference data
grant select on public.market_phases, public.zones, public.localities to anon, authenticated;
create policy market_phases_read on public.market_phases for select to anon, authenticated using (true);
create policy zones_read         on public.zones         for select to anon, authenticated using (true);
create policy localities_read    on public.localities    for select to anon, authenticated using (true);

grant select on public.sources to anon, authenticated;
create policy sources_read_approved on public.sources for select to anon, authenticated
  using (status = 'approved');

-- Researched projects: published only. No client writes (service role only).
grant select on public.projects, public.developers, public.project_units, public.facts,
  public.fact_sources, public.regulatory_records, public.regulatory_searches to anon, authenticated;
-- project_documents: storage_path is internal; expose every other column.
grant select (id, project_id, document_key, title, kind, version, document_date, source_id,
  source_url, observed_at, created_at) on public.project_documents to anon, authenticated;

create policy projects_read_published on public.projects for select to anon, authenticated
  using (published);
create policy developers_read_published on public.developers for select to anon, authenticated
  using (exists (select 1 from public.projects p where p.developer_id = developers.id and p.published));
create policy project_units_read_published on public.project_units for select to anon, authenticated
  using (public.is_published_project(project_id));
create policy facts_read_published on public.facts for select to anon, authenticated
  using (is_current and public.is_published_project(project_id));
create policy fact_sources_read_published on public.fact_sources for select to anon, authenticated
  using (exists (select 1 from public.facts f
                 where f.id = fact_sources.fact_id and f.is_current and public.is_published_project(f.project_id)));
create policy regulatory_records_read_published on public.regulatory_records for select to anon, authenticated
  using (public.is_published_project(project_id));
create policy regulatory_searches_read_published on public.regulatory_searches for select to anon, authenticated
  using (public.is_published_project(project_id));
create policy project_documents_read_published on public.project_documents for select to anon, authenticated
  using (public.is_published_project(project_id));

-- Locality context
grant select on public.infrastructure_items, public.amenities to anon, authenticated;
create policy infrastructure_read_published on public.infrastructure_items for select to anon, authenticated
  using (published);
create policy amenities_read on public.amenities for select to anon, authenticated using (true);

-- Lane B listings are public (always labelled unverified in the UI).
grant select on public.external_listings to anon, authenticated;
create policy external_listings_read on public.external_listings for select to anon, authenticated using (true);

-- source_observations: no client access at all (service role only).

-- Staff profiles: a signed-in user can see their own row only. Writes: service role only.
grant select on public.staff_profiles to authenticated;
create policy staff_profiles_read_own on public.staff_profiles for select to authenticated
  using (user_id = auth.uid());

-- Leads: public INSERT only (no SELECT/UPDATE/DELETE), consent required, server-owned columns
-- (qualification, retention, timestamps) not insertable by clients.
grant insert (id, request_type, name, email, phone, preferred_channel, message, project_id,
  external_listing_id, budget_band, contact_consent, marketing_consent, consent_text_version,
  status, attribution) on public.leads to anon, authenticated;
create policy leads_public_insert on public.leads for insert to anon, authenticated
  with check (contact_consent = true and status = 'new');

grant select on public.leads to authenticated;
grant update (status, retention_until, updated_at, name, email, phone, message, budget_band,
  contact_consent, marketing_consent, attribution) on public.leads to authenticated;
create policy leads_staff_select on public.leads for select to authenticated using (public.is_staff());
create policy leads_staff_update on public.leads for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

grant select, insert (lead_id, actor_id, event_type, from_status, to_status) on public.lead_events to authenticated;
create policy lead_events_staff_select on public.lead_events for select to authenticated using (public.is_staff());
create policy lead_events_staff_insert on public.lead_events for insert to authenticated
  with check (public.is_staff() and actor_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.tn_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger projects_touch before update on public.projects
  for each row execute function public.tn_touch_updated_at();
create trigger leads_touch before update on public.leads
  for each row execute function public.tn_touch_updated_at();

-- Lead inserts from client roles: server-owned columns are forced, and a 'created' audit event
-- is written. Runs as definer so the event insert works for anon (who has no lead_events grant).
create or replace function public.tn_leads_after_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.lead_events (lead_id, actor_id, event_type, to_status)
  values (new.id, null, 'created', new.status);
  return null;
end $$;

create trigger leads_audit_insert after insert on public.leads
  for each row execute function public.tn_leads_after_insert();

-- Status changes must follow src/leads/retention.ts LEAD_STATUS_TRANSITIONS.
create or replace function public.tn_leads_check_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'new'       and new.status in ('contacted','closed','withdrawn'))
    or (old.status = 'contacted' and new.status in ('qualified','closed','withdrawn'))
    or (old.status = 'qualified' and new.status in ('contacted','closed','withdrawn'))
    or (old.status = 'closed'    and new.status = 'withdrawn')) then
    raise exception 'invalid lead status transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger leads_check_transition before update of status on public.leads
  for each row execute function public.tn_leads_check_transition();

commit;
