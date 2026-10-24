-- S1a: fact store skeleton (spec 02 "facts" / "facts_current" / "facts_history", additive only).
-- Plan: /mnt/project-files/truenest/specs-alignment-plan.md §5–§6. Decisions D17, D18 (proposed).
--
-- Two orthogonal axes per fact (D18):
--   * truth status  official | estimated | unknown — what kind of claim it is (constitution §2)
--   * verification  unverified | source_confirmed | reviewed | … — whether TrueNest reviewed it
-- `unknown` means "nothing credible found yet". It is NEVER a negative finding.
--
-- Name collisions with the spec: our `facts` is the staff-curated store (D12/D13) and our `sources`
-- is the governance registry. So automation writes `fact_observations` (the spec's `facts` shape),
-- and the spec names are exposed as the views `facts_current` and `facts_history`.
--
-- Access: RLS on every new table, service role only, NO anon/authenticated grant (nothing renders
-- from this store yet). Observations are always unverified (CHECK). History is append-only for
-- every role, including service_role and the owner. Nothing here holds property data: the only
-- rows inserted are the attribute catalogue (schema metadata) and a backfill of existing facts.

begin;

-- ---------------------------------------------------------------------------
-- Shared: generic append-only rejection (replaces 0002's body; same errcode, and the message for
-- fact_review_events is unchanged: "<table> is append-only").
-- ---------------------------------------------------------------------------
create or replace function public.tn_reject_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;

create or replace function public.tn_is_truth_status(v text) returns boolean
language sql immutable as $$
  select v in ('official','estimated','unknown')
$$;
grant execute on function public.tn_is_truth_status(text) to service_role;

-- Web research sources (src/discovery/registry.ts WEB_RESEARCH_SOURCE_IDS; KEEP IN SYNC, a unit
-- test compares them). Their registry type is `developer`, but a web-search result is not an
-- official figure (H1).
create or replace function public.tn_is_web_research_source(p_id text) returns boolean
language sql immutable as $$
  select p_id in ('anthropic-web-search','sample-web-research')
$$;
grant execute on function public.tn_is_web_research_source(text) to service_role;

-- ---------------------------------------------------------------------------
-- Attribute catalogue (spec 02). Schema metadata only. `legally_significant` flags are PROPOSED
-- for C7 (Fury confirms): such attributes show only after staff review. default_ttl_hours values
-- are assumptions to tune per source in S2a.
-- ---------------------------------------------------------------------------
create table public.fact_attributes (
  entity_type text not null check (entity_type in ('project','builder','development','locality')),
  attribute text not null check (attribute ~ '^[a-z][a-z0-9_]{1,62}$'),
  value_kind text not null check (value_kind in ('text','number','date','json')),
  unit text,
  legally_significant boolean not null default false,
  legal_flag_status text not null default 'proposed' check (legal_flag_status in ('proposed','confirmed')),
  default_ttl_hours integer not null check (default_ttl_hours > 0),
  -- the curated facts.field this attribute corresponds to (facts_current merges both)
  legacy_field text check (legacy_field is null or legacy_field in
    ('address','rera_numbers','construction_status','declared_possession','unit_carpet_area_sqft','unit_price_inr')),
  description text not null default '',
  primary key (entity_type, attribute)
);
create unique index fact_attributes_legacy_uq on public.fact_attributes (entity_type, legacy_field)
  where legacy_field is not null;

insert into public.fact_attributes
  (entity_type, attribute, value_kind, unit, legally_significant, default_ttl_hours, legacy_field, description) values
  -- project
  ('project', 'rera_status',                'text',   null,     true,  168,  null, 'RERA registration status as shown by the regulator'),
  ('project', 'rera_registration_date',     'date',   null,     true,  720,  null, 'RERA registration date'),
  ('project', 'rera_completion_date',       'date',   null,     true,  168,  null, 'Completion date declared in the RERA registration'),
  ('project', 'rera_extension_count',       'number', 'count',  true,  168,  null, 'Number of RERA extensions granted'),
  ('project', 'rera_complaints_count',      'number', 'count',  true,  168,  null, 'Complaints recorded against the project with the regulator'),
  ('project', 'promised_possession',        'date',   null,     false, 168,  'declared_possession', 'Possession date as declared by the builder or RERA (not a promise by TrueNest)'),
  ('project', 'current_possession_claim',   'date',   null,     false, 168,  null, 'Latest possession date the builder claims'),
  ('project', 'total_units',                'number', 'count',  false, 2160, null, 'Total units'),
  ('project', 'towers',                     'number', 'count',  false, 2160, null, 'Number of towers'),
  ('project', 'floors',                     'number', 'count',  false, 2160, null, 'Floors per tower (max)'),
  ('project', 'land_area_acres',            'number', 'acres',  false, 2160, null, 'Land area'),
  ('project', 'carpet_sba_ratio',           'number', 'ratio',  false, 2160, null, 'Carpet area to super built-up area ratio'),
  ('project', 'oc_status',                  'text',   null,     true,  720,  null, 'Occupancy certificate status'),
  ('project', 'khata_type',                 'text',   null,     true,  720,  null, 'Khata type'),
  ('project', 'land_title_summary',         'text',   null,     true,  720,  null, 'Summary of land title as stated by a source (not a title opinion)'),
  ('project', 'bank_approvals',             'json',   null,     true,  720,  null, 'Banks stated to have approved the project for home loans'),
  ('project', 'base_psf',                   'number', 'INR/sqft', false, 168, null, 'Base price per sq ft'),
  ('project', 'floor_rise_psf',             'number', 'INR/sqft', false, 168, null, 'Floor rise charge per sq ft'),
  ('project', 'plc_note',                   'text',   null,     false, 168,  null, 'Preferential location charges note'),
  ('project', 'car_park_cost',              'number', 'INR',    false, 168,  null, 'Car park cost'),
  ('project', 'clubhouse_cost',             'number', 'INR',    false, 168,  null, 'Clubhouse charge'),
  ('project', 'maintenance_psf_month',      'number', 'INR/sqft/month', false, 720, null, 'Maintenance charge per sq ft per month'),
  ('project', 'maintenance_deposit_months', 'number', 'months', false, 720,  null, 'Maintenance deposit in months'),
  ('project', 'amenities',                  'json',   null,     false, 2160, null, 'Amenities listed by a source'),
  ('project', 'launch_date',                'date',   null,     false, 2160, null, 'Launch date'),
  ('project', 'water_source',               'text',   null,     false, 720,  null, 'Water source as stated by a source'),
  ('project', 'stp_status',                 'text',   null,     false, 720,  null, 'Sewage treatment plant status'),
  ('project', 'builder_track_record_note',  'text',   null,     false, 720,  null, 'Builder delivery track record note (with sources)'),
  -- development
  ('development', 'status',                 'text',   null,     false, 720,  null, 'Infrastructure tier (constitution §5)'),
  ('development', 'expected_completion',    'date',   null,     false, 720,  null, 'Expected completion as declared by the authority'),
  ('development', 'budget_cr',              'number', 'INR crore', false, 2160, null, 'Budget'),
  ('development', 'length_km',              'number', 'km',     false, 2160, null, 'Length'),
  ('development', 'stations',               'json',   null,     false, 2160, null, 'Stations'),
  -- locality
  ('locality', 'avg_psf',                   'number', 'INR/sqft', false, 720, null, 'Average price per sq ft (estimate unless an official figure exists)'),
  ('locality', 'psf_trend_12m',             'number', 'percent', false, 720, null, 'Price per sq ft change over 12 months'),
  ('locality', 'water_supply_note',         'text',   null,     false, 2160, null, 'Water supply note'),
  ('locality', 'flooding_note',             'text',   null,     false, 2160, null, 'Flooding note'),
  ('locality', 'major_employers',           'json',   null,     false, 2160, null, 'Major employers nearby'),
  ('locality', 'school_hospital_note',      'text',   null,     false, 2160, null, 'Schools and hospitals note');

-- ---------------------------------------------------------------------------
-- fact_observations: one row per (entity, attribute, source_url), written by automation (crawl,
-- research, extraction) or staff. Spec 02 `facts` shape. Entity types project + locality first.
-- ---------------------------------------------------------------------------
create table public.fact_observations (
  id text primary key default gen_random_uuid()::text,
  entity_type text not null check (entity_type in ('project','locality')),
  entity_id text not null check (char_length(entity_id) between 1 and 200),
  attribute text not null,
  value_text text check (value_text is null or char_length(value_text) <= 2000),
  value_num numeric,
  value_date date,
  value_json jsonb,
  unit text,
  status text not null check (public.tn_is_truth_status(status)),
  confidence numeric check (confidence is null or confidence between 0 and 1),
  estimate_basis jsonb,
  source_id text not null references public.sources(id),
  source_url text check (public.tn_is_https_or_null(source_url)),
  source_type text not null check (source_type in
    ('rera','builder','govt','news','reddit','youtube','google_reviews','portal','search','fixture')),
  observed_at timestamptz not null,
  last_verified_at timestamptz not null,
  ttl_hours integer not null check (ttl_hours > 0),
  excerpt text check (excerpt is null or (char_length(excerpt) <= 300
    and coalesce(array_length(regexp_split_to_array(btrim(excerpt), '\s+'), 1), 0) <= 20)),
  added_by text not null check (added_by in ('crawl','research','extraction','staff')),
  verification text not null default 'unverified' check (public.tn_is_verification_state(verification)),
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (entity_type, attribute) references public.fact_attributes (entity_type, attribute),
  unique nulls not distinct (entity_type, entity_id, attribute, source_url),
  -- unknown carries no value; official/estimated carry one and a source URL (constitution §1)
  constraint fact_observations_value_matches_status check (
    (status = 'unknown' and value_text is null and value_num is null and value_date is null and value_json is null)
    or (status <> 'unknown' and source_url is not null
        and (value_text is not null or value_num is not null or value_date is not null or value_json is not null))),
  -- an estimate always carries its basis; nothing else does (constitution §2)
  constraint fact_observations_estimate_basis check (
    (status = 'estimated') = (estimate_basis is not null)
    and (estimate_basis is null or (case when jsonb_typeof(estimate_basis -> 'sources') = 'array'
                                         then jsonb_array_length(estimate_basis -> 'sources') > 0 else false end))),
  constraint fact_observations_verified_after_observed check (last_verified_at >= observed_at),
  -- C7 / plan §5.4: automation can never raise verification. Until a staff RPC with an actor and an
  -- audit event exists, NO observation may be anything but unverified (staff rows included).
  constraint fact_observations_unverified_only check (verification = 'unverified'),
  -- constitution §2: official = the builder, RERA or a government body (fixture for SAMPLE rows)
  constraint fact_observations_official_source_type check (
    status <> 'official' or source_type in ('rera','builder','govt','fixture')),
  -- a web research source (tn_is_web_research_source, defined below) always writes source_type 'search'
  constraint fact_observations_web_research_is_search check (
    not public.tn_is_web_research_source(source_id) or source_type = 'search')
);
create index fact_observations_entity_idx on public.fact_observations (entity_type, entity_id, attribute);

-- Validates the entity exists (and that a project row's is_sample equals the project's), the value
-- matches the catalogue's value_kind, and that identity columns, added_by and is_sample never change.
create or replace function public.tn_fact_observations_validate() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_kind text;
begin
  if tg_op = 'UPDATE' and (
       new.id is distinct from old.id or new.entity_type is distinct from old.entity_type
    or new.entity_id is distinct from old.entity_id or new.attribute is distinct from old.attribute
    or new.source_url is distinct from old.source_url or new.added_by is distinct from old.added_by
    or new.is_sample is distinct from old.is_sample or new.created_at is distinct from old.created_at) then
    raise exception 'fact_observations identity columns cannot change' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.entity_type = 'project' and not exists (select 1 from public.projects where id = new.entity_id) then
      raise exception 'unknown project %', new.entity_id using errcode = 'foreign_key_violation';
    elsif new.entity_type = 'project' and new.is_sample is distinct from
          (select p.is_sample from public.projects p where p.id = new.entity_id) then
      raise exception 'is_sample must equal the project''s is_sample' using errcode = 'check_violation';
    elsif new.entity_type = 'locality' and not exists (select 1 from public.localities where id = new.entity_id) then
      raise exception 'unknown locality %', new.entity_id using errcode = 'foreign_key_violation';
    end if;
  end if;
  if new.status <> 'unknown' then
    select value_kind into v_kind from public.fact_attributes
      where entity_type = new.entity_type and attribute = new.attribute;
    if (v_kind = 'text' and new.value_text is null) or (v_kind = 'number' and new.value_num is null)
       or (v_kind = 'date' and new.value_date is null) or (v_kind = 'json' and new.value_json is null) then
      raise exception 'value for % must be of kind %', new.attribute, v_kind using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger fact_observations_validate before insert or update on public.fact_observations
  for each row execute function public.tn_fact_observations_validate();

-- ---------------------------------------------------------------------------
-- fact_observations_history: every UPDATE/DELETE of an observation copies the OLD row here.
-- Append-only for every role (reuses tn_reject_audit_mutation). Never deleted (constitution §4);
-- takedowns will go through an audited tn_redact() tombstone (C23, later slice).
-- ---------------------------------------------------------------------------
create table public.fact_observations_history (
  history_id bigint generated always as identity primary key,
  observation_id text not null,
  entity_type text not null,
  entity_id text not null,
  attribute text not null,
  value_text text,
  value_num numeric,
  value_date date,
  value_json jsonb,
  unit text,
  status text not null,
  confidence numeric,
  estimate_basis jsonb,
  source_id text not null,
  source_url text,
  source_type text not null,
  observed_at timestamptz not null,
  last_verified_at timestamptz not null,
  ttl_hours integer not null,
  excerpt text,
  added_by text not null,
  verification text not null,
  is_sample boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  operation text not null check (operation in ('UPDATE','DELETE')),
  superseded_at timestamptz not null default now()
);
create index fact_observations_history_entity_idx on public.fact_observations_history
  (entity_type, entity_id, attribute, superseded_at);

-- Security definer: the history write never depends on the writer's privileges. service_role's
-- default privileges are revoked below and it is granted SELECT only on the history table, so it
-- cannot forge history rows directly.
create or replace function public.tn_fact_observations_to_history() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- an upsert that changes nothing is not history
  if tg_op = 'UPDATE' and (to_jsonb(old) - 'updated_at') = (to_jsonb(new) - 'updated_at') then
    return null;
  end if;
  insert into public.fact_observations_history (observation_id, entity_type, entity_id, attribute,
      value_text, value_num, value_date, value_json, unit, status, confidence, estimate_basis, source_id,
      source_url, source_type, observed_at, last_verified_at, ttl_hours, excerpt, added_by, verification,
      is_sample, created_at, updated_at, operation)
    values (old.id, old.entity_type, old.entity_id, old.attribute, old.value_text, old.value_num, old.value_date,
      old.value_json, old.unit, old.status, old.confidence, old.estimate_basis, old.source_id, old.source_url,
      old.source_type, old.observed_at, old.last_verified_at, old.ttl_hours, old.excerpt, old.added_by,
      old.verification, old.is_sample, old.created_at, old.updated_at, tg_op);
  return null;
end $$;
revoke all on function public.tn_fact_observations_to_history() from public, anon, authenticated;

create trigger fact_observations_history_capture after update or delete on public.fact_observations
  for each row execute function public.tn_fact_observations_to_history();

create trigger fact_observations_history_append_only
  before update or delete on public.fact_observations_history
  for each row execute function public.tn_reject_audit_mutation();
create trigger fact_observations_history_no_truncate
  before truncate on public.fact_observations_history
  for each statement execute function public.tn_reject_audit_mutation();
-- TRUNCATE skips row-level triggers (history capture, the facts guard), so it is refused outright.
create trigger fact_observations_no_truncate
  before truncate on public.fact_observations
  for each statement execute function public.tn_reject_audit_mutation();
create trigger facts_no_truncate
  before truncate on public.facts
  for each statement execute function public.tn_reject_audit_mutation();
create trigger fact_sources_no_truncate
  before truncate on public.fact_sources
  for each statement execute function public.tn_reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- Curated facts (D12/D13): truth status, last verification, TTL. Nullable; facts_current falls
-- back to the derived truth status and the catalogue TTL when they are null.
-- ---------------------------------------------------------------------------
alter table public.facts
  add column truth_status text check (truth_status is null or public.tn_is_truth_status(truth_status)),
  add column last_verified_at timestamptz,
  add column ttl_hours integer check (ttl_hours is null or ttl_hours > 0),
  add constraint facts_truth_matches_status check (
    truth_status is null
    or (status = 'unknown' and truth_status = 'unknown')
    or (status = 'known' and truth_status in ('official','estimated')));


-- A source whose facts count as official (constitution §2): regulator / government / developer,
-- not web research, not rejected in the registry.
create or replace function public.tn_source_is_official(p_id text, p_type text, p_status text) returns boolean
language sql immutable as $$
  select p_type in ('regulator','government','developer')
     and not public.tn_is_web_research_source(p_id)
     and p_status is distinct from 'rejected'
$$;
grant execute on function public.tn_source_is_official(text, text, text) to service_role;

-- Plan §5: an official source (above) → official; any other source → estimated; unknown stays
-- unknown. (Rows written later with a null truth_status get the same rule at read time in
-- facts_current, and the guard only lets a null truth_status be set to exactly this value.)
create or replace function public.tn_curated_truth_status(p_fact_id text, p_status text) returns text
language sql stable security invoker set search_path = public, pg_temp as $$
  select case
    when p_status = 'unknown' then 'unknown'
    when exists (select 1 from public.fact_sources fs join public.sources s on s.id = fs.source_id
                 where fs.fact_id = p_fact_id and public.tn_source_is_official(s.id, s.type, s.status)) then 'official'
    else 'estimated'
  end
$$;
revoke all on function public.tn_curated_truth_status(text, text) from public, anon, authenticated;
grant execute on function public.tn_curated_truth_status(text, text) to service_role;

-- Registry source (id, sources.type) → spec 02 source_type vocabulary, for curated rows.
create or replace function public.tn_spec_source_type(p_id text, p_type text) returns text
language sql immutable as $$
  select case
    when public.tn_is_web_research_source(p_id) then 'search'
    else case p_type when 'regulator' then 'rera' when 'government' then 'govt' when 'developer' then 'builder'
                     when 'listing_portal' then 'portal' else p_type end
  end
$$;
grant execute on function public.tn_spec_source_type(text, text) to service_role;

-- 'YYYY-MM-DD' text → date, else null (never raises). Used to compare dates as dates (L2).
create or replace function public.tn_try_date(p text) returns date
language plpgsql immutable as $$
begin
  if p ~ '^\d{4}-\d{2}-\d{2}$' then
    return p::date;
  end if;
  return null;
exception when others then
  return null;
end $$;
grant execute on function public.tn_try_date(text) to service_role;

update public.facts f set
  truth_status = public.tn_curated_truth_status(f.id, f.status),
  last_verified_at = (select max(fs.observed_at) from public.fact_sources fs where fs.fact_id = f.id)
where f.truth_status is null;

-- Guard: a curated fact row is a historical record. Its identity, value and status never change
-- (a new value is a new row via research_set_fact, which marks the old one is_current = false).
-- is_current, last_verified_at and ttl_hours may change. verification may change only inside the
-- audited RPCs (research_set_verification / research_set_fact set tn.via_rpc for that one UPDATE).
-- truth_status may only go from null to the derived value (tn_curated_truth_status); any other
-- change is refused (H2), so a fact cannot be relabelled official by hand.
-- Direct DELETE is refused for every role; a cascade from deleting its project or unit (RI
-- trigger, pg_trigger_depth() > 1) is allowed so SAMPLE data can still be removed (migrate.ts).
create or replace function public.tn_facts_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'facts rows cannot be deleted (history is kept; supersede with a new row)'
      using errcode = 'insufficient_privilege';
  end if;
  if new.id is distinct from old.id or new.project_id is distinct from old.project_id
     or new.unit_id is distinct from old.unit_id or new.field is distinct from old.field
     or new.value is distinct from old.value or new.status is distinct from old.status
     or new.created_at is distinct from old.created_at then
    raise exception 'facts value, field, status and created_at cannot be updated (insert a new current row instead)'
      using errcode = 'insufficient_privilege';
  end if;
  if new.verification is distinct from old.verification
     and current_setting('tn.via_rpc', true) is distinct from 'on' then
    raise exception 'facts.verification changes only through research_set_verification (audited)'
      using errcode = 'insufficient_privilege';
  end if;
  if new.truth_status is distinct from old.truth_status
     and not (old.truth_status is null
              and new.truth_status is not distinct from public.tn_curated_truth_status(new.id, new.status)) then
    raise exception 'facts.truth_status can only be set once, to the value derived from its sources'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger facts_guard before update or delete on public.facts
  for each row execute function public.tn_facts_guard();

-- The D12/D13 RPCs, redefined from 0003 with bodies otherwise identical: each sets the
-- transaction-local flag tn.via_rpc around its own UPDATE of facts and clears it right after.
-- NOTE: the flag is a guard against accidental direct writes by server code, not a security
-- boundary: any role that can run SQL can set a custom setting.
create or replace function public.research_set_fact(
  p_project_id text,
  p_field text,            -- facts.field (snake_case)
  p_status text,
  p_value jsonb,
  p_verification text,
  p_sources jsonb,         -- [{sourceId, url, observedAt, documentDate?, note?}]
  p_actor_id text,
  p_actor_role text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_fact_id text := gen_random_uuid()::text;
  v_from text;
  v_auto boolean;
begin
  if p_field not in ('address','rera_numbers','construction_status','declared_possession') then
    raise exception 'unsupported research field %', p_field using errcode = 'check_violation';
  end if;
  perform 1 from public.projects where id = p_project_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select verification into v_from from public.facts
    where project_id = p_project_id and field = p_field and unit_id is null and is_current for update;
  perform set_config('tn.via_rpc', 'on', true);
  update public.facts set is_current = false
    where project_id = p_project_id and field = p_field and unit_id is null and is_current;
  perform set_config('tn.via_rpc', 'off', true);
  insert into public.facts (id, project_id, field, value, status, verification)
    values (v_fact_id, p_project_id, p_field, p_value, p_status, p_verification);
  insert into public.fact_sources (fact_id, source_id, url, observed_at, document_date, note)
    select v_fact_id, s->>'sourceId', s->>'url', (s->>'observedAt')::timestamptz,
           nullif(s->>'documentDate', '')::date, nullif(s->>'note', '')
    from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) s;
  -- R2: completeness from the committed state, under the lock
  update public.projects
    set completeness = public.tn_compute_completeness(p_project_id), last_checked_at = now()
    where id = p_project_id;
  insert into public.fact_review_events (project_id, field, action, from_verification, to_verification, actor_id, actor_role)
    values (p_project_id, public.tn_research_field_label(p_field), 'fact_set', coalesce(v_from, 'unverified'), p_verification,
            p_actor_id, p_actor_role);
  v_auto := public.tn_auto_unpublish_if_not_ready(p_project_id, p_actor_id, p_actor_role);
  return jsonb_build_object('status', 'ok', 'fact_id', v_fact_id, 'auto_unpublished', v_auto);
end $$;

create or replace function public.research_set_verification(
  p_project_id text, p_field text, p_fact_id text, p_expected_from text, p_to text,
  p_actor_id text, p_actor_role text, p_note text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_from text;
  v_auto boolean;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select verification into v_from from public.facts
    where id = p_fact_id and project_id = p_project_id and field = p_field and unit_id is null and is_current
    for update;
  if not found or v_from is distinct from p_expected_from then
    return jsonb_build_object('status', 'conflict');
  end if;
  perform set_config('tn.via_rpc', 'on', true);
  update public.facts set verification = p_to where id = p_fact_id;
  perform set_config('tn.via_rpc', 'off', true);
  insert into public.fact_review_events (project_id, field, action, from_verification, to_verification, actor_id, actor_role, note)
    values (p_project_id, public.tn_research_field_label(p_field), 'verification_changed', v_from, p_to,
            p_actor_id, p_actor_role, p_note);
  v_auto := public.tn_auto_unpublish_if_not_ready(p_project_id, p_actor_id, p_actor_role);
  return jsonb_build_object('status', 'ok', 'from', v_from, 'auto_unpublished', v_auto);
end $$;

-- create or replace keeps the existing ACL; restated for clarity (service role only).
revoke all on function public.research_set_fact(text, text, text, jsonb, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.research_set_verification(text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.research_set_fact(text, text, text, jsonb, text, jsonb, text, text) to service_role;
grant execute on function public.research_set_verification(text, text, text, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- facts_current: one row per (entity, attribute), from live observations plus current curated
-- project facts whose field maps to a catalogue attribute (legacy_field).
-- Precedence: a KNOWN curated value whose verification is source_confirmed or reviewed wins; otherwise
-- official > estimated > unknown, then newest observed_at, then id. Every other live row is listed
-- in `conflicts` (never hidden, constitution §3). is_stale = last_verified_at + ttl < now().
-- security_invoker: the caller's privileges and RLS apply (service role only for now).
-- ---------------------------------------------------------------------------
create view public.facts_current with (security_invoker = true) as
with candidates as (
  select
    'observation'::text as origin,
    o.id as fact_id,
    o.entity_type, o.entity_id, o.attribute,
    o.value_text, o.value_num, o.value_date, o.value_json, o.unit,
    o.status as truth_status,
    o.verification, o.confidence, o.estimate_basis,
    o.source_id, o.source_url, o.source_type,
    o.observed_at, o.last_verified_at, o.ttl_hours, o.excerpt, o.added_by, o.is_sample,
    false as curated_verified
  from public.fact_observations o
  union all
  select
    'curated'::text,
    f.id,
    'project'::text, f.project_id, a.attribute,
    case when dt.d is null and jsonb_typeof(f.value) = 'string' then f.value #>> '{}' end,
    case when jsonb_typeof(f.value) = 'number' then (f.value #>> '{}')::numeric end,
    dt.d,
    case when jsonb_typeof(f.value) not in ('string','number') then f.value end,
    a.unit,
    tr.truth,
    f.verification, null::numeric,
    -- an estimated curated value's basis is the sources staff recorded for it
    case when tr.truth = 'estimated' then jsonb_build_object('sources',
      (select jsonb_agg(jsonb_build_object('sourceId', fs.source_id, 'url', fs.url, 'observedAt', fs.observed_at)
                        order by fs.observed_at desc, fs.id)
       from public.fact_sources fs where fs.fact_id = f.id)) end,
    ls.source_id, ls.url,
    public.tn_spec_source_type(ls.source_id, ls.type),
    coalesce(ls.observed_at, f.created_at),
    coalesce(f.last_verified_at, ls.observed_at, f.created_at),
    coalesce(f.ttl_hours, a.default_ttl_hours),
    null::text, 'staff'::text, p.is_sample,
    -- M5: only a verified KNOWN curated value overrides the observations
    f.status = 'known' and f.verification in ('source_confirmed','reviewed')
  from public.facts f
  join public.fact_attributes a on a.entity_type = 'project' and a.legacy_field = f.field
  join public.projects p on p.id = f.project_id
  -- truth is derived at read time from the current sources; the stored truth_status is only a
  -- fallback (it can go stale when sources are added or the registry changes)
  cross join lateral (select coalesce(public.tn_curated_truth_status(f.id, f.status), f.truth_status) as truth) tr
  -- L2: an ISO date stored as text in a date attribute is compared (and served) as a date
  cross join lateral (select case when a.value_kind = 'date' and jsonb_typeof(f.value) = 'string'
                                  then public.tn_try_date(f.value #>> '{}') end as d) dt
  -- M3: the representative source is an official-qualifying one when there is one, then the newest
  left join lateral (
    select fs.source_id, fs.url, fs.observed_at, s.type
    from public.fact_sources fs join public.sources s on s.id = fs.source_id
    where fs.fact_id = f.id
    order by public.tn_source_is_official(s.id, s.type, s.status) desc, fs.observed_at desc, fs.id
    limit 1
  ) ls on true
  -- M2: a known curated value without a source never enters facts_current (constitution §1)
  where f.is_current and f.unit_id is null and (f.status = 'unknown' or ls.source_id is not null)
),
ranked as (
  select c.*,
    row_number() over (
      partition by c.entity_type, c.entity_id, c.attribute
      order by c.curated_verified desc,
               array_position(array['official','estimated','unknown'], c.truth_status),
               c.observed_at desc,
               c.fact_id
    ) as rank
  from candidates c
)
select
  w.entity_type, w.entity_id, w.attribute, w.origin, w.fact_id,
  w.value_text, w.value_num, w.value_date, w.value_json, w.unit,
  w.truth_status, w.verification, w.confidence, w.estimate_basis,
  w.source_id, w.source_url, w.source_type,
  w.observed_at, w.last_verified_at, w.ttl_hours, w.excerpt, w.added_by, w.is_sample,
  a.legally_significant,
  -- C7 (proposed): legally significant values need staff review before they may render as fact
  (a.legally_significant and w.verification not in ('source_confirmed','reviewed')) as requires_review,
  (w.last_verified_at + make_interval(hours => w.ttl_hours) < now()) as is_stale,
  coalesce(x.conflicts, '[]'::jsonb) as conflicts,
  coalesce(x.conflict_count, 0) as conflict_count,
  coalesce(x.has_disagreement, false) as has_disagreement
from ranked w
join public.fact_attributes a on a.entity_type = w.entity_type and a.attribute = w.attribute
left join lateral (
  select
    jsonb_agg(jsonb_build_object(
      'origin', o.origin, 'fact_id', o.fact_id,
      'value_text', o.value_text, 'value_num', o.value_num, 'value_date', o.value_date, 'value_json', o.value_json,
      'unit', o.unit, 'truth_status', o.truth_status, 'verification', o.verification, 'confidence', o.confidence,
      'source_id', o.source_id, 'source_url', o.source_url, 'source_type', o.source_type,
      'observed_at', o.observed_at, 'last_verified_at', o.last_verified_at, 'added_by', o.added_by
    ) order by o.rank) as conflicts,
    count(*)::int as conflict_count,
    bool_or(jsonb_build_array(o.value_text, o.value_num, o.value_date, o.value_json)
            is distinct from jsonb_build_array(w.value_text, w.value_num, w.value_date, w.value_json)) as has_disagreement
  from ranked o
  where o.entity_type = w.entity_type and o.entity_id = w.entity_id and o.attribute = w.attribute and o.rank > 1
) x on true
where w.rank = 1;

-- ---------------------------------------------------------------------------
-- facts_history: superseded observation versions + superseded curated fact rows.
-- superseded_at for a curated row = created_at of the next row for the same field (or null if
-- that row was marked not current without a successor).
-- ---------------------------------------------------------------------------
create view public.facts_history with (security_invoker = true) as
select
  'observation'::text as origin,
  h.observation_id as fact_id,
  h.entity_type, h.entity_id, h.attribute, null::text as legacy_field, null::text as unit_id,
  h.value_text, h.value_num, h.value_date, h.value_json, h.unit,
  h.status as truth_status, h.verification, h.confidence, h.estimate_basis,
  h.source_id, h.source_url, h.source_type, h.observed_at, h.last_verified_at, h.ttl_hours,
  h.excerpt, h.added_by, h.is_sample, h.created_at, h.operation, h.superseded_at
from public.fact_observations_history h
union all
select
  'curated'::text,
  f.id,
  'project'::text, f.project_id, a.attribute, f.field, f.unit_id,
  case when jsonb_typeof(f.value) = 'string' then f.value #>> '{}' end,
  case when jsonb_typeof(f.value) = 'number' then (f.value #>> '{}')::numeric end,
  null::date,
  case when jsonb_typeof(f.value) not in ('string','number') then f.value end,
  a.unit,
  coalesce(public.tn_curated_truth_status(f.id, f.status), f.truth_status), f.verification, null::numeric, null::jsonb,
  ls.source_id, ls.url, public.tn_spec_source_type(ls.source_id, ls.type), coalesce(ls.observed_at, f.created_at),
  coalesce(f.last_verified_at, ls.observed_at, f.created_at), coalesce(f.ttl_hours, a.default_ttl_hours),
  null::text, 'staff'::text, p.is_sample, f.created_at, 'SUPERSEDED'::text,
  (select min(n.created_at) from public.facts n
    where n.project_id = f.project_id and n.field = f.field and n.unit_id is not distinct from f.unit_id
      and n.id <> f.id and n.created_at >= f.created_at)
from public.facts f
join public.projects p on p.id = f.project_id
left join public.fact_attributes a on a.entity_type = 'project' and a.legacy_field = f.field
left join lateral (
  select fs.source_id, fs.url, fs.observed_at, s.type
  from public.fact_sources fs join public.sources s on s.id = fs.source_id
  where fs.fact_id = f.id
  order by public.tn_source_is_official(s.id, s.type, s.status) desc, fs.observed_at desc, fs.id
  limit 1
) ls on true
where not f.is_current;

-- ---------------------------------------------------------------------------
-- Row Level Security + grants: service role only. No anon/authenticated access yet.
-- ---------------------------------------------------------------------------
alter table public.fact_attributes           enable row level security;
alter table public.fact_observations         enable row level security;
alter table public.fact_observations_history enable row level security;

-- service_role is revoked too: Supabase's default privileges grant it ALL on new tables and views,
-- so only the explicit grants below remain (H4).
revoke all on public.fact_attributes, public.fact_observations, public.fact_observations_history,
  public.facts_current, public.facts_history from public, anon, authenticated, service_role;
grant select on public.fact_attributes to service_role;                         -- catalogue: migrations only
grant select, insert, update, delete on public.fact_observations to service_role;
grant select on public.fact_observations_history to service_role;               -- written by trigger only
grant select on public.facts_current, public.facts_history to service_role;
-- No policies for anon/authenticated: with RLS on and no grants they can neither see nor write.

commit;
