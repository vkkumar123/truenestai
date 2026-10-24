-- S4a: planned area developments (spec 06, constitution §5, C15, C19, D20). Additive only.
-- Plan: /mnt/project-files/truenest/specs-alignment-plan.md §4 S4a and §5 (developments row).
-- (0007 is reserved by another branch; this file is numbered 0008 on purpose.)
--
-- * infrastructure_items gains the spec-06 columns (authority, announced_date, expected_completion,
--   completion_history, confidence, source fields, verification) and the full tier list
--   proposed → approved → dpr_approved → tendered → under_construction → operational, + shelved.
-- * infrastructure_completion_history: append-only log of every declared expected-completion value
--   (constitution §4), so "how often it slipped" can be shown. Never updated or deleted.
-- * infrastructure_review_events: append-only staff/system audit of research, edits and review.
-- * developments: a view with the spec's column names.
-- * research_jobs.kind: a locality's development research runs through the existing queue, worker,
--   cost caps and daily cap (research_enqueue gains p_kind; its behaviour is otherwise unchanged).
--
-- Rules enforced here: automated (research) rows are inserted unverified; verification changes only
-- inside the audited RPCs; anon reads only staff-published rows (and their history); research never
-- overwrites a row staff have published or rejected (it records a pending_change instead).
-- Geometry: lat/lng numeric for now; PostGIS geography + proximity table come later (S1c/S4b).

begin;

-- ---------------------------------------------------------------------------
-- research_jobs: job kind
-- ---------------------------------------------------------------------------
alter table public.research_jobs
  add column kind text not null default 'search_miss' check (kind in ('search_miss','area_developments')),
  add constraint research_jobs_kind_key check (
    (kind = 'area_developments') = (query_key like 'dev:%')
    and (kind <> 'area_developments' or locality_id is not null));

drop function public.research_enqueue(text, text, text, text, integer, integer, integer);

-- Same as 0005 (order of checks, advisory lock, stall handling, caps) plus the job kind.
create or replace function public.research_enqueue(
  p_query_text text,
  p_query_key text,
  p_locality_id text,
  p_ip_hash text,
  p_cache_hours integer,
  p_max_per_day integer,
  p_max_per_requester integer,
  p_kind text default 'search_miss'
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_job public.research_jobs;
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('tn_research_enqueue'));

  update public.research_jobs
     set status = 'failed', error_code = 'stalled', finished_at = now()
   where status = 'queued' and coalesce(started_at, requested_at) < now() - interval '30 minutes';

  select * into v_job from public.research_jobs
    where query_key = p_query_key and status in ('queued','running') limit 1;
  if found then
    return jsonb_build_object('outcome', 'active', 'job', to_jsonb(v_job) - 'requester_ip_hash');
  end if;

  select * into v_job from public.research_jobs
    where query_key = p_query_key and status in ('done','no_results')
      and finished_at > now() - make_interval(hours => greatest(p_cache_hours, 0))
    order by finished_at desc limit 1;
  if found then
    return jsonb_build_object('outcome', 'cached', 'job', to_jsonb(v_job) - 'requester_ip_hash');
  end if;

  select * into v_job from public.research_jobs
    where query_key = p_query_key and status = 'failed' and finished_at > now() - interval '6 hours'
    order by finished_at desc limit 1;
  if found then
    return jsonb_build_object('outcome', 'failed_recently', 'job', to_jsonb(v_job) - 'requester_ip_hash');
  end if;

  -- One global cap for every kind of research (cost guardrail).
  select count(*) into v_count from public.research_jobs where requested_at > now() - interval '24 hours';
  if v_count >= p_max_per_day then
    return jsonb_build_object('outcome', 'daily_cap');
  end if;

  if p_ip_hash is not null then
    select count(*) into v_count from public.research_jobs
      where requester_ip_hash = p_ip_hash and requested_at > now() - interval '24 hours';
    if v_count >= p_max_per_requester then
      return jsonb_build_object('outcome', 'requester_cap');
    end if;
  end if;

  insert into public.research_jobs (query_text, query_key, locality_id, requester_ip_hash, kind)
    values (left(p_query_text, 100), p_query_key, p_locality_id, p_ip_hash, coalesce(p_kind, 'search_miss'))
    returning * into v_job;
  return jsonb_build_object('outcome', 'queued', 'job', to_jsonb(v_job) - 'requester_ip_hash');
end $$;
revoke all on function public.research_enqueue(text, text, text, text, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.research_enqueue(text, text, text, text, integer, integer, integer, text) to service_role;

-- Claim by kind. A worker built before S4a calls the 2-argument form, which now claims only
-- search_miss jobs, so it can never run an area_developments job as a search. The S4a worker
-- passes every kind it handles. Same body as 0005 plus the kind filter.
create or replace function public.research_claim_jobs(p_limit integer, p_stale_minutes integer, p_kinds text[])
returns setof jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  update public.research_jobs
     set status = 'failed', error_code = 'abandoned', finished_at = now()
   where id in (
     select id from public.research_jobs
      where status = 'running' and attempts >= 2 and kind = any(p_kinds)
        and started_at < now() - make_interval(mins => greatest(p_stale_minutes, 1))
      for update skip locked);

  return query
  update public.research_jobs j
     set status = 'running', started_at = now(), attempts = j.attempts + 1
   where j.id in (
     select id from public.research_jobs
      where kind = any(p_kinds)
        and (status = 'queued'
             or (status = 'running' and attempts < 2
                 and started_at < now() - make_interval(mins => greatest(p_stale_minutes, 1))))
      order by requested_at
      for update skip locked
      limit greatest(0, least(p_limit, 20)))
  returning to_jsonb(j) - 'requester_ip_hash';
end $$;

create or replace function public.research_claim_jobs(p_limit integer, p_stale_minutes integer)
returns setof jsonb
language sql security invoker set search_path = public, pg_temp as $$
  select * from public.research_claim_jobs(p_limit, p_stale_minutes, array['search_miss'])
$$;

revoke all on function public.research_claim_jobs(integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.research_claim_jobs(integer, integer, text[]) to service_role;
revoke all on function public.research_claim_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.research_claim_jobs(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- infrastructure_items: spec-06 columns
-- ---------------------------------------------------------------------------
alter table public.infrastructure_items drop constraint infrastructure_items_stage_check;
alter table public.infrastructure_items drop constraint infrastructure_items_category_check;
alter table public.infrastructure_items alter column declared_completion set default '{"status":"unknown","value":null}'::jsonb;

alter table public.infrastructure_items
  add column authority text,
  add column announced_date date,
  add column expected_completion text,               -- as declared by the source, verbatim
  add column completion_history jsonb not null default '[]'::jsonb,  -- [{date_claimed, as_of, source_url}], trigger-maintained
  add column confidence numeric,
  add column source_id text references public.sources(id),
  add column source_url text,
  add column source_observed_at timestamptz,
  add column verification text not null default 'unverified',
  add column added_by text,                          -- null = legacy row (before S4a)
  add column research_job_id uuid references public.research_jobs(id) on delete set null,
  add column research_locality_id text references public.localities(id),
  add column rejected_at timestamptz,
  add column rejection_note text,
  add column pending_change jsonb,                   -- research seen after review; staff decide
  add column staff_edited_at timestamptz,            -- last staff content edit; research then never overwrites
  add column reviewed_at timestamptz,                -- first published by staff; stays set after unpublish
  add column version integer not null default 1,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column name_key text generated always as (btrim(lower(regexp_replace(name, '[^[:alnum:]]+', ' ', 'g')))) stored,
  add constraint infrastructure_items_stage_check check (stage in
    ('proposed','approved','dpr_approved','tendered','under_construction','operational','shelved')),
  add constraint infrastructure_items_category_check check (category in
    ('metro','suburban_rail','rail','road','flyover','ring_road','airport','zoning','water','power','other')),
  add constraint infra_name_length check (char_length(btrim(name)) between 1 and 160),
  add constraint infra_authority_length check (authority is null or char_length(authority) between 1 and 80),
  add constraint infra_expected_length check (expected_completion is null or char_length(expected_completion) between 1 and 40),
  add constraint infra_rejection_note_length check (rejection_note is null or char_length(rejection_note) <= 1000),
  add constraint infra_source_url_https check (public.tn_is_https_or_null(source_url)),
  add constraint infra_verification_state check (public.tn_is_verification_state(verification)),
  add constraint infra_added_by check (added_by is null or added_by in ('research','staff')),
  add constraint infra_confidence_range check (confidence is null or confidence between 0 and 1),
  add constraint infra_history_is_array check (jsonb_typeof(completion_history) = 'array'),
  -- research rows always carry their source, cited URL and observation date (constitution §1)
  add constraint infra_research_has_source check (
    added_by is distinct from 'research' or (source_id is not null and source_url is not null and source_observed_at is not null)),
  -- staff manual entries need an authority and its URL
  add constraint infra_staff_has_authority_url check (
    added_by is distinct from 'staff' or (source_url is not null and authority is not null)),
  -- published S4a rows always show authority, source link and the date it was seen
  add constraint infra_published_complete check (
    not published or added_by is null or (authority is not null and source_url is not null and source_observed_at is not null)),
  add constraint infra_published_not_rejected check (not (published and rejected_at is not null));

-- Research dedupe: the same name on the same cited page is the same row (never merged by name alone).
create unique index infrastructure_items_research_uq on public.infrastructure_items (name_key, source_url)
  where added_by = 'research';
create index infrastructure_items_localities_idx on public.infrastructure_items using gin (locality_ids);
create index infrastructure_items_research_locality_idx on public.infrastructure_items (research_locality_id);

-- ---------------------------------------------------------------------------
-- Append-only completion history (constitution §4). No FK: history outlives its row.
-- ---------------------------------------------------------------------------
create table public.infrastructure_completion_history (
  id bigint generated always as identity primary key,
  development_id text not null,
  expected_completion text not null check (char_length(expected_completion) between 1 and 40),
  as_of timestamptz not null,
  source_url text check (public.tn_is_https_or_null(source_url)),
  recorded_at timestamptz not null default now(),
  is_sample boolean not null default false
);
create index infrastructure_completion_history_dev_idx on public.infrastructure_completion_history (development_id, as_of, id);

create trigger infrastructure_completion_history_append_only
  before update or delete on public.infrastructure_completion_history
  for each row execute function public.tn_reject_audit_mutation();
create trigger infrastructure_completion_history_no_truncate
  before truncate on public.infrastructure_completion_history
  for each statement execute function public.tn_reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- Append-only review audit (who researched, edited, published or rejected what)
-- ---------------------------------------------------------------------------
create table public.infrastructure_review_events (
  id bigint generated always as identity primary key,
  development_id text not null,
  action text not null check (action in ('researched','created','edited','published','unpublished','rejected','restored')),
  from_verification text check (from_verification is null or public.tn_is_verification_state(from_verification)),
  to_verification text check (to_verification is null or public.tn_is_verification_state(to_verification)),
  actor_id text not null check (char_length(actor_id) between 1 and 100),
  actor_role text not null check (actor_role in ('advisor','admin','system')),
  at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 1000),
  -- only the research worker acts as 'system', and it can only record research
  constraint infrastructure_review_events_system_only_research check ((actor_role = 'system') = (action = 'researched'))
);
create index infrastructure_review_events_dev_idx on public.infrastructure_review_events (development_id, at, id);

create trigger infrastructure_review_events_append_only
  before update or delete on public.infrastructure_review_events
  for each row execute function public.tn_reject_audit_mutation();
create trigger infrastructure_review_events_no_truncate
  before truncate on public.infrastructure_review_events
  for each statement execute function public.tn_reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- Row guard: history, version, verification, legacy mirrors
-- ---------------------------------------------------------------------------
create or replace function public.tn_infra_history_entry(p_expected text, p_as_of timestamptz, p_url text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('date_claimed', p_expected, 'as_of', p_as_of, 'source_url', p_url)
$$;

create or replace function public.tn_infrastructure_items_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_as_of timestamptz;
begin
  v_as_of := coalesce(new.source_observed_at, now());
  if tg_op = 'INSERT' then
    -- C7 / plan §5.4: an S4a row (research or staff) always starts unverified
    if new.added_by is not null and new.verification <> 'unverified' then
      raise exception 'new developments are inserted unverified' using errcode = 'check_violation';
    end if;
    -- an S4a row is published only by staff review (development_set_review), never at insert
    if new.added_by is not null and new.published then
      raise exception 'new developments are inserted unpublished' using errcode = 'check_violation';
    end if;
    new.version := 1;
    new.created_at := now();
    new.updated_at := now();
    new.completion_history := case when new.expected_completion is null then '[]'::jsonb
      else jsonb_build_array(public.tn_infra_history_entry(new.expected_completion, v_as_of, new.source_url)) end;
  else
    if new.id is distinct from old.id or new.added_by is distinct from old.added_by
       or new.is_sample is distinct from old.is_sample or new.created_at is distinct from old.created_at then
      raise exception 'infrastructure_items identity columns cannot change' using errcode = 'check_violation';
    end if;
    if new.verification is distinct from old.verification and current_setting('tn.via_rpc', true) is distinct from 'on' then
      raise exception 'infrastructure_items.verification changes only through the audited review RPCs'
        using errcode = 'insufficient_privilege';
    end if;
    if new.published and not old.published and current_setting('tn.via_rpc', true) is distinct from 'on' then
      raise exception 'infrastructure_items are published only through the audited review RPC'
        using errcode = 'insufficient_privilege';
    end if;
    -- completion_history is derived: a direct write to it is ignored; a changed declared date appends
    if new.expected_completion is not null and new.expected_completion is distinct from old.expected_completion then
      new.completion_history := old.completion_history
        || jsonb_build_array(public.tn_infra_history_entry(new.expected_completion, v_as_of, new.source_url));
    else
      new.completion_history := old.completion_history;
    end if;
    if (to_jsonb(new) - array['version','updated_at','name_key']) is distinct from (to_jsonb(old) - array['version','updated_at','name_key']) then
      new.version := old.version + 1;
      new.updated_at := now();
    else
      new.version := old.version;
      new.updated_at := old.updated_at;
    end if;
  end if;
  -- Legacy mirrors (InfrastructureItem.declaredCompletion / sources) for S4a rows
  if new.added_by is not null then
    new.declared_completion := case when new.expected_completion is null
      then jsonb_build_object('status', 'unknown', 'value', null, 'verification', new.verification, 'sources', '[]'::jsonb)
      else jsonb_build_object('status', 'known', 'value', new.expected_completion, 'verification', new.verification,
        'sources', jsonb_build_array(jsonb_build_object('sourceId', new.source_id, 'url', new.source_url, 'observedAt', v_as_of))) end;
    new.sources := case when new.source_url is null then '[]'::jsonb
      else jsonb_build_array(jsonb_build_object('sourceId', new.source_id, 'url', new.source_url, 'observedAt', v_as_of)) end;
  end if;
  return new;
end $$;

create trigger infrastructure_items_guard before insert or update on public.infrastructure_items
  for each row execute function public.tn_infrastructure_items_guard();

-- Security definer: the history write never depends on the writer's privileges; service_role has
-- SELECT only on the history table, so history cannot be forged directly.
create or replace function public.tn_infrastructure_items_to_history() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.expected_completion is not null
     and (tg_op = 'INSERT' or new.expected_completion is distinct from old.expected_completion) then
    insert into public.infrastructure_completion_history (development_id, expected_completion, as_of, source_url, is_sample)
      values (new.id, new.expected_completion, coalesce(new.source_observed_at, now()), new.source_url, new.is_sample);
  end if;
  return null;
end $$;
revoke all on function public.tn_infrastructure_items_to_history() from public, anon, authenticated;

create trigger infrastructure_items_history_capture after insert or update on public.infrastructure_items
  for each row execute function public.tn_infrastructure_items_to_history();

-- ---------------------------------------------------------------------------
-- Publish readiness (KEEP IN SYNC with developmentPublishBlockers in src/server/repositories/development-rules.ts)
-- ---------------------------------------------------------------------------
create or replace function public.tn_development_publish_blockers(p_id text) returns text[]
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  r public.infrastructure_items;
  b text[] := '{}';
begin
  select * into r from public.infrastructure_items where id = p_id;
  if not found then
    return array['not found'];
  end if;
  if r.authority is null then b := b || 'authority: not yet found'::text; end if;
  if r.source_url is null then b := b || 'source: no https link'::text; end if;
  if r.source_observed_at is null then b := b || 'source: no observed date'::text; end if;
  return b;
end $$;

-- ---------------------------------------------------------------------------
-- RPCs (service role only). Change + audit in one transaction under a row lock; optimistic
-- concurrency on `version` (what the reviewer saw).
-- ---------------------------------------------------------------------------

-- Research worker: upsert validated, cited items for one job.
-- * New item: inserted unverified and unpublished.
-- * Pending draft (not published, not rejected, never edited by staff): takes the new values.
-- * Reviewed row (published, rejected, or edited by staff): keeps its values. When research
--   contradicts them, the new values go to pending_change (also copied into the audit note) and
--   last_checked_at is NOT refreshed, so buyers never see a fresh "last checked" on stale values.
--   last_checked_at is refreshed only when research matches the stored values.
create or replace function public.development_store_research(
  p_job_id uuid,
  p_research_locality_id text,
  p_source_id text,
  p_observed_at timestamptz,
  p_is_sample boolean,
  p_items jsonb   -- [{name, category, stage, authority?, expectedCompletion?, localityId, sourceUrl}]
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  it jsonb;
  r public.infrastructure_items;
  v_id text;
  v_note text;
  v_stage text;
  v_authority text;
  v_expected text;
  v_change jsonb;
  v_ids text[] := '{}';
begin
  perform set_config('tn.via_rpc', 'on', true);
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_stage := it->>'stage';
    v_authority := nullif(it->>'authority', '');
    v_expected := nullif(it->>'expectedCompletion', '');
    -- Insert first; ON CONFLICT DO NOTHING waits for a concurrent job storing the same item and then
    -- yields no row, so two jobs never fail on infrastructure_items_research_uq.
    v_id := null;
    insert into public.infrastructure_items (id, name, category, stage, authority, expected_completion, locality_ids,
        source_id, source_url, source_observed_at, last_checked_at, added_by, research_job_id, research_locality_id,
        is_sample, published)
      values (gen_random_uuid()::text, it->>'name', it->>'category', v_stage, v_authority, v_expected,
        array[it->>'localityId'], p_source_id, it->>'sourceUrl', p_observed_at, p_observed_at, 'research', p_job_id,
        p_research_locality_id, p_is_sample, false)
      on conflict (name_key, source_url) where added_by = 'research' do nothing
      returning id into v_id;
    if v_id is null then
      select * into r from public.infrastructure_items
        where added_by = 'research' and source_url = it->>'sourceUrl'
          and name_key = btrim(lower(regexp_replace(it->>'name', '[^[:alnum:]]+', ' ', 'g')))
        for update;
    end if;
    if v_id is not null then
      v_note := 'found by web research';
    -- a pending draft: never published, never rejected, never edited by staff
    elsif not r.published and r.rejected_at is null and r.staff_edited_at is null and r.reviewed_at is null then
      update public.infrastructure_items set
          last_checked_at = p_observed_at, research_job_id = p_job_id, category = it->>'category', stage = v_stage,
          authority = v_authority, expected_completion = coalesce(v_expected, r.expected_completion),
          source_observed_at = p_observed_at, verification = 'unverified', pending_change = null
        where id = r.id;
      v_id := r.id;
      v_note := 'seen again by web research (pending draft updated)';
    else
      v_id := r.id;
      -- research not finding a value (null) is not a contradiction; a different value is
      if v_stage is distinct from r.stage
         or (v_authority is not null and v_authority is distinct from r.authority)
         or (v_expected is not null and v_expected is distinct from r.expected_completion) then
        v_change := jsonb_build_object('stage', v_stage, 'authority', v_authority, 'expectedCompletion', v_expected,
                                       'observedAt', p_observed_at);
        update public.infrastructure_items set research_job_id = p_job_id, pending_change = v_change where id = r.id;
        v_note := left('research differs from the reviewed values (not applied): ' || v_change::text, 1000);
      elsif r.pending_change is null then
        update public.infrastructure_items set research_job_id = p_job_id, last_checked_at = p_observed_at where id = r.id;
        v_note := 'seen again by web research (matches the reviewed values)';
      else
        update public.infrastructure_items set research_job_id = p_job_id where id = r.id;
        v_note := 'seen again by web research (an earlier pending change is still open)';
      end if;
    end if;
    v_ids := v_ids || v_id;
    insert into public.infrastructure_review_events (development_id, action, actor_id, actor_role, note)
      values (v_id, 'researched', 'system:research', 'system', v_note);
  end loop;
  perform set_config('tn.via_rpc', 'off', true);
  return to_jsonb(v_ids);
end $$;

-- Staff manual entry (authority URL required by the table constraint). Unpublished, unverified.
create or replace function public.development_create(
  p_fields jsonb, p_is_sample boolean, p_actor_id text, p_actor_role text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_id text := gen_random_uuid()::text;
begin
  insert into public.infrastructure_items (id, name, category, stage, authority, expected_completion, announced_date,
      locality_ids, lat, lng, location_precision, source_id, source_url, source_observed_at, last_checked_at,
      added_by, is_sample, published)
    values (v_id, p_fields->>'name', p_fields->>'category', p_fields->>'stage', nullif(p_fields->>'authority', ''),
      nullif(p_fields->>'expectedCompletion', ''), nullif(p_fields->>'announcedDate', '')::date,
      coalesce((select array_agg(x) from jsonb_array_elements_text(p_fields->'localityIds') x), '{}'),
      nullif(p_fields->>'lat', '')::numeric, nullif(p_fields->>'lng', '')::numeric, nullif(p_fields->>'locationPrecision', ''),
      nullif(p_fields->>'sourceId', ''), nullif(p_fields->>'sourceUrl', ''), (p_fields->>'sourceObservedAt')::timestamptz,
      now(), 'staff', coalesce(p_is_sample, false), false);
  insert into public.infrastructure_review_events (development_id, action, actor_id, actor_role, to_verification)
    values (v_id, 'created', p_actor_id, p_actor_role, 'unverified');
  return jsonb_build_object('status', 'ok', 'id', v_id);
end $$;

-- Staff edit: replaces the editable fields. A content change resets verification to unverified;
-- a published row that no longer passes readiness is unpublished in the same transaction.
create or replace function public.development_update(
  p_id text, p_expected_version integer, p_fields jsonb, p_actor_id text, p_actor_role text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r public.infrastructure_items;
  n public.infrastructure_items;
  v_auto boolean := false;
begin
  select * into r from public.infrastructure_items where id = p_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if r.version <> p_expected_version then
    return jsonb_build_object('status', 'conflict');
  end if;
  perform set_config('tn.via_rpc', 'on', true);
  update public.infrastructure_items set
    name = p_fields->>'name',
    category = p_fields->>'category',
    stage = p_fields->>'stage',
    authority = nullif(p_fields->>'authority', ''),
    expected_completion = nullif(p_fields->>'expectedCompletion', ''),
    announced_date = nullif(p_fields->>'announcedDate', '')::date,
    locality_ids = coalesce((select array_agg(x) from jsonb_array_elements_text(p_fields->'localityIds') x), '{}'),
    lat = nullif(p_fields->>'lat', '')::numeric,
    lng = nullif(p_fields->>'lng', '')::numeric,
    location_precision = nullif(p_fields->>'locationPrecision', ''),
    source_url = nullif(p_fields->>'sourceUrl', ''),
    source_observed_at = (p_fields->>'sourceObservedAt')::timestamptz,
    pending_change = null,
    -- an edit that removes what readiness needs unpublishes in the same statement (infra_published_complete)
    published = published and nullif(p_fields->>'authority', '') is not null and nullif(p_fields->>'sourceUrl', '') is not null
      and nullif(p_fields->>'sourceObservedAt', '') is not null
  where id = p_id
  returning * into n;
  -- Only a real content change counts as a check by staff and resets verification.
  if n.version <> r.version then
    update public.infrastructure_items set last_checked_at = now(), verification = 'unverified', staff_edited_at = now()
      where id = p_id returning * into n;
  end if;
  perform set_config('tn.via_rpc', 'off', true);
  if n.version = r.version then
    return jsonb_build_object('status', 'unchanged', 'version', n.version);
  end if;
  insert into public.infrastructure_review_events (development_id, action, actor_id, actor_role, from_verification, to_verification, note)
    values (p_id, 'edited', p_actor_id, p_actor_role, r.verification, n.verification,
            case when r.pending_change is not null
              then left('cleared pending research change: ' || r.pending_change::text, 1000) end);
  if r.published and not n.published then
    insert into public.infrastructure_review_events (development_id, action, actor_id, actor_role, note)
      values (p_id, 'unpublished', p_actor_id, p_actor_role, 'auto: failed readiness after edit');
    v_auto := true;
  end if;
  return jsonb_build_object('status', 'ok', 'version', n.version, 'auto_unpublished', v_auto);
end $$;

-- Review: publish (readiness re-checked under the lock; optionally marks the source confirmed),
-- unpublish, reject (with a note) or restore a rejected row to pending.
create or replace function public.development_set_review(
  p_id text, p_expected_version integer, p_action text, p_verification text,
  p_actor_id text, p_actor_role text, p_note text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r public.infrastructure_items;
  n public.infrastructure_items;
  v_blockers text[];
  v_to text;
begin
  if p_action not in ('publish','unpublish','reject','restore') then
    raise exception 'invalid review action %', p_action using errcode = '22023';
  end if;
  if p_verification is not null and p_verification not in ('unverified','source_confirmed') then
    raise exception 'invalid verification %', p_verification using errcode = '22023';
  end if;
  select * into r from public.infrastructure_items where id = p_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if r.version <> p_expected_version then
    return jsonb_build_object('status', 'conflict');
  end if;
  if (p_action = 'publish' and r.published and p_verification is not distinct from r.verification)
     or (p_action = 'unpublish' and not r.published)
     or (p_action = 'reject' and r.rejected_at is not null)
     or (p_action = 'restore' and r.rejected_at is null) then
    return jsonb_build_object('status', 'unchanged', 'version', r.version);
  end if;
  if p_action = 'publish' then
    v_blockers := public.tn_development_publish_blockers(p_id);
    if cardinality(v_blockers) > 0 then
      return jsonb_build_object('status', 'not_ready', 'blockers', to_jsonb(v_blockers));
    end if;
    v_to := coalesce(p_verification, r.verification);
    perform set_config('tn.via_rpc', 'on', true);
    update public.infrastructure_items
      set published = true, rejected_at = null, rejection_note = null, verification = v_to, pending_change = null,
          reviewed_at = coalesce(reviewed_at, now())   -- once reviewed, research never overwrites (even after unpublish)
      where id = p_id returning * into n;
    perform set_config('tn.via_rpc', 'off', true);
  elsif p_action = 'unpublish' then
    update public.infrastructure_items set published = false where id = p_id returning * into n;
  elsif p_action = 'reject' then
    update public.infrastructure_items
      set published = false, rejected_at = now(), rejection_note = nullif(left(p_note, 1000), '')
      where id = p_id returning * into n;
  else
    update public.infrastructure_items set rejected_at = null, rejection_note = null where id = p_id returning * into n;
  end if;
  insert into public.infrastructure_review_events (development_id, action, actor_id, actor_role, from_verification, to_verification, note)
    values (p_id, case p_action when 'publish' then 'published' when 'unpublish' then 'unpublished'
                                when 'reject' then 'rejected' else 'restored' end,
            p_actor_id, p_actor_role, r.verification, n.verification,
            -- publishing clears a pending research change: keep a record of what was set aside
            nullif(left(concat_ws(' · ', nullif(btrim(p_note), ''),
              case when p_action = 'publish' and r.pending_change is not null
                then 'cleared pending research change: ' || r.pending_change::text end), 1000), ''));
  return jsonb_build_object('status', 'ok', 'version', n.version);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.tn_infra_history_entry(text, timestamptz, text)',
    'public.tn_development_publish_blockers(text)',
    'public.development_store_research(uuid, text, text, timestamptz, boolean, jsonb)',
    'public.development_create(jsonb, boolean, text, text)',
    'public.development_update(text, integer, jsonb, text, text)',
    'public.development_set_review(text, integer, text, text, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
create or replace function private.is_published_development(p_id text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.infrastructure_items where id = p_id and published)
$$;
revoke all on function private.is_published_development(text) from public;
grant execute on function private.is_published_development(text) to anon, authenticated, service_role;

-- infrastructure_items: anon/authenticated read published rows (policy from 0001) and only the
-- columns a buyer may see (no research job, rejection note, pending research change or version).
revoke all on public.infrastructure_items from anon, authenticated;
grant select (id, name, category, stage, locality_ids, lat, lng, location_precision, declared_completion, sources,
  last_checked_at, is_sample, published, authority, announced_date, expected_completion, completion_history,
  confidence, source_id, source_url, source_observed_at, verification, added_by)
  on public.infrastructure_items to anon, authenticated;
-- Supabase default privileges give service_role ALL: no DELETE/TRUNCATE (history and audit
-- reference rows by id; a takedown will use an audited tombstone, C23).
revoke delete, truncate on public.infrastructure_items from service_role;
grant select, insert, update on public.infrastructure_items to service_role;

alter table public.infrastructure_completion_history enable row level security;
alter table public.infrastructure_review_events enable row level security;

-- Supabase default privileges grant service_role ALL on new tables: revoke, then grant explicitly.
revoke all on public.infrastructure_completion_history, public.infrastructure_review_events
  from public, anon, authenticated, service_role;
grant select on public.infrastructure_completion_history to anon, authenticated, service_role;   -- written by trigger only
grant select, insert on public.infrastructure_review_events to service_role;
grant select on public.infrastructure_review_events to authenticated;

create policy infrastructure_history_read_published on public.infrastructure_completion_history
  for select to anon, authenticated using (private.is_published_development(development_id));
create policy infrastructure_review_events_staff_select on public.infrastructure_review_events
  for select to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------------
-- Spec 06 view. security_invoker: the caller's RLS applies (anon sees published rows only).
-- ---------------------------------------------------------------------------
create view public.developments with (security_invoker = true) as
select
  i.id as development_id,
  i.name,
  i.category as type,
  i.stage as status,
  i.announced_date,
  i.expected_completion,
  i.completion_history,
  greatest(jsonb_array_length(i.completion_history) - 1, 0) as revisions_count,
  i.authority,
  i.source_id,
  i.source_url,
  i.source_observed_at,
  i.last_checked_at as last_verified_at,
  i.confidence,
  i.lat,
  i.lng,
  i.location_precision,
  i.locality_ids,
  i.verification,
  i.added_by,
  i.published,
  i.is_sample
from public.infrastructure_items i;
revoke all on public.developments from public, anon, authenticated, service_role;
grant select on public.developments to anon, authenticated, service_role;

commit;
