-- M3: append-only audit trail for staff research edits (FactAuditEvent in src/domain/types.ts).
-- Written only by the server with the service role; staff may read; nobody may change history.

begin;

create table public.fact_review_events (
  id text primary key default gen_random_uuid()::text,
  project_id text not null references public.projects(id) on delete restrict,
  field text not null check (field in
    ('address','reraNumbers','constructionStatus','declaredPossession','published','basics')),
  action text not null check (action in
    ('fact_set','verification_changed','published','unpublished','basics_updated','created')),
  from_verification text check (from_verification is null or public.tn_is_verification_state(from_verification)),
  to_verification text check (to_verification is null or public.tn_is_verification_state(to_verification)),
  actor_id text not null check (char_length(actor_id) between 1 and 100),
  actor_role text not null check (actor_role in ('advisor','admin')),
  at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 1000)
);
create index fact_review_events_project_idx on public.fact_review_events (project_id, at);

alter table public.fact_review_events enable row level security;

revoke all on public.fact_review_events from anon, authenticated;
grant select on public.fact_review_events to authenticated;
grant select, insert on public.fact_review_events to service_role;

create policy fact_review_events_staff_select on public.fact_review_events
  for select to authenticated using (public.is_staff());
-- No insert/update/delete policies for client roles: service role only.

-- Append-only for EVERY role (including service_role and the table owner).
create or replace function public.tn_reject_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'fact_review_events is append-only' using errcode = 'insufficient_privilege';
end $$;

create trigger fact_review_events_append_only
  before update or delete on public.fact_review_events
  for each row execute function public.tn_reject_audit_mutation();

create trigger fact_review_events_no_truncate
  before truncate on public.fact_review_events
  for each statement execute function public.tn_reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- Publish readiness in SQL (authoritative for Supabase writes). KEEP IN SYNC with
-- src/research/publish.ts (a unit test compares the constants).
-- ---------------------------------------------------------------------------
create or replace function public.tn_research_field_label(f text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case f when 'rera_numbers' then 'reraNumbers' when 'construction_status' then 'constructionStatus'
                when 'declared_possession' then 'declaredPossession' else f end
$$;

create or replace function public.tn_publish_blockers(p_project_id text) returns text[]
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  c_min_completeness constant numeric := 0.6;                          -- PUBLISH_MIN_COMPLETENESS
  c_rera_ok constant text[] := array['source_confirmed', 'reviewed'];  -- RERA verification required
  b text[] := '{}';
  v_completeness numeric;
  r record;
begin
  select completeness into v_completeness from public.projects where id = p_project_id;
  for r in
    select f.field, f.status, f.verification,
           exists (select 1 from public.fact_sources s where s.fact_id = f.id) as has_source
    from public.facts f
    where f.project_id = p_project_id and f.is_current and f.unit_id is null
      and f.field in ('address','rera_numbers','construction_status','declared_possession')
    order by array_position(array['address','rera_numbers','construction_status','declared_possession'], f.field)
  loop
    if r.status = 'known' and not r.has_source then
      b := b || (public.tn_research_field_label(r.field) || ': known value has no source');
    end if;
    if r.verification = 'disputed' then
      b := b || (public.tn_research_field_label(r.field) || ': disputed');
    end if;
  end loop;

  if not exists (select 1 from public.facts f where f.project_id = p_project_id and f.is_current and f.unit_id is null
                 and f.field = 'rera_numbers' and f.status = 'known'
                 and jsonb_typeof(f.value) = 'array' and jsonb_array_length(f.value) > 0) then
    b := b || 'reraNumbers: not known'::text;
  elsif not exists (select 1 from public.facts f where f.project_id = p_project_id and f.is_current and f.unit_id is null
                    and f.field = 'rera_numbers' and f.verification = any (c_rera_ok)) then
    b := b || 'reraNumbers: must be source_confirmed or reviewed'::text;
  end if;

  if not exists (select 1 from public.facts f where f.project_id = p_project_id and f.is_current and f.unit_id is null
                 and f.field = 'construction_status' and f.status = 'known') then
    b := b || 'constructionStatus: not known'::text;
  end if;

  if coalesce(v_completeness, 0) < c_min_completeness then
    b := b || format('completeness %s%% is below %s%%', round(coalesce(v_completeness, 0) * 100), round(c_min_completeness * 100));
  end if;
  return b;
end $$;

-- Shared: unpublish (with audit) a published project that no longer passes readiness.
create or replace function public.tn_auto_unpublish_if_not_ready(p_project_id text, p_actor_id text, p_actor_role text)
returns boolean
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.projects where id = p_project_id and published)
     and cardinality(public.tn_publish_blockers(p_project_id)) > 0 then
    update public.projects set published = false where id = p_project_id;
    insert into public.fact_review_events (project_id, field, action, actor_id, actor_role, note)
      values (p_project_id, 'published', 'unpublished', p_actor_id, p_actor_role, 'auto: failed readiness after edit');
    return true;
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------------------
-- Staff write RPCs (service role only). Each does change + audit in ONE transaction, under a
-- row lock on the project. `at` is set by the database.
-- ---------------------------------------------------------------------------
create or replace function public.research_create_project(
  p_slug text, p_name text, p_developer_id text, p_developer_name text, p_locality_id text,
  p_lat numeric, p_lng numeric, p_precision text, p_actor_id text, p_actor_role text
) returns text
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_dev text := p_developer_id;
  v_id text := gen_random_uuid()::text;
begin
  if v_dev is null then
    insert into public.developers (name, is_sample) values (p_developer_name, false) returning id into v_dev;
  elsif not exists (select 1 from public.developers where id = v_dev) then
    raise exception 'developer not found' using errcode = 'foreign_key_violation';
  end if;
  insert into public.projects (id, slug, name, developer_id, locality_id, lat, lng, location_precision, completeness, is_sample, published)
    values (v_id, p_slug, p_name, v_dev, p_locality_id, p_lat, p_lng, p_precision, 0, false, false);
  insert into public.fact_review_events (project_id, field, action, actor_id, actor_role)
    values (v_id, 'basics', 'created', p_actor_id, p_actor_role);
  return v_id;
end $$;

-- Replaces the current value of a research fact (history kept), stores sources and the
-- app-computed completeness, audits fact_set, then auto-unpublishes if readiness now fails (D13).
create or replace function public.research_set_fact(
  p_project_id text,
  p_field text,            -- facts.field (snake_case)
  p_status text,
  p_value jsonb,
  p_verification text,
  p_sources jsonb,         -- [{sourceId, url, observedAt, documentDate?, note?}]
  p_completeness numeric,
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
  update public.facts set is_current = false
    where project_id = p_project_id and field = p_field and unit_id is null and is_current;
  insert into public.facts (id, project_id, field, value, status, verification)
    values (v_fact_id, p_project_id, p_field, p_value, p_status, p_verification);
  insert into public.fact_sources (fact_id, source_id, url, observed_at, document_date, note)
    select v_fact_id, s->>'sourceId', s->>'url', (s->>'observedAt')::timestamptz,
           nullif(s->>'documentDate', '')::date, nullif(s->>'note', '')
    from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) s;
  update public.projects set completeness = p_completeness, last_checked_at = now() where id = p_project_id;
  insert into public.fact_review_events (project_id, field, action, from_verification, to_verification, actor_id, actor_role)
    values (p_project_id, public.tn_research_field_label(p_field), 'fact_set', coalesce(v_from, 'unverified'), p_verification,
            p_actor_id, p_actor_role);
  v_auto := public.tn_auto_unpublish_if_not_ready(p_project_id, p_actor_id, p_actor_role);
  return jsonb_build_object('status', 'ok', 'fact_id', v_fact_id, 'auto_unpublished', v_auto);
end $$;

-- Changes verification of exactly the fact version the reviewer saw (p_fact_id must still be
-- current, else 'conflict'), audits, then auto-unpublishes if readiness now fails (D13).
create or replace function public.research_set_verification(
  p_project_id text, p_field text, p_fact_id text, p_to text,
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
  if not found then
    return jsonb_build_object('status', 'conflict');
  end if;
  update public.facts set verification = p_to where id = p_fact_id;
  insert into public.fact_review_events (project_id, field, action, from_verification, to_verification, actor_id, actor_role, note)
    values (p_project_id, public.tn_research_field_label(p_field), 'verification_changed', v_from, p_to,
            p_actor_id, p_actor_role, p_note);
  v_auto := public.tn_auto_unpublish_if_not_ready(p_project_id, p_actor_id, p_actor_role);
  return jsonb_build_object('status', 'ok', 'from', v_from, 'auto_unpublished', v_auto);
end $$;

-- Publish / unpublish with readiness re-checked under the row lock.
create or replace function public.research_set_published(
  p_project_id text, p_published boolean, p_actor_id text, p_actor_role text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_current boolean;
  v_blockers text[];
begin
  select published into v_current from public.projects where id = p_project_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_current = p_published then
    return jsonb_build_object('status', 'unchanged');
  end if;
  if p_published then
    v_blockers := public.tn_publish_blockers(p_project_id);
    if cardinality(v_blockers) > 0 then
      return jsonb_build_object('status', 'not_ready', 'blockers', to_jsonb(v_blockers));
    end if;
  end if;
  update public.projects set published = p_published where id = p_project_id;
  insert into public.fact_review_events (project_id, field, action, actor_id, actor_role)
    values (p_project_id, 'published', case when p_published then 'published' else 'unpublished' end, p_actor_id, p_actor_role);
  return jsonb_build_object('status', 'ok');
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.tn_research_field_label(text)',
    'public.tn_publish_blockers(text)',
    'public.tn_auto_unpublish_if_not_ready(text, text, text)',
    'public.research_create_project(text, text, text, text, text, numeric, numeric, text, text, text)',
    'public.research_set_fact(text, text, text, jsonb, text, jsonb, numeric, text, text)',
    'public.research_set_verification(text, text, text, text, text, text, text)',
    'public.research_set_published(text, boolean, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Rows inserted by the RPCs above run as service_role, which needs table privileges:
grant select, insert, update on public.projects, public.developers, public.facts, public.fact_sources to service_role;

commit;
