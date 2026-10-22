-- M2: Supabase live. Review carry-overs (R1, R2, L9), advisor lead assignment, document storage.
-- Applies after 0001_core.sql and 0002_research_audit.sql.

begin;

-- ---------------------------------------------------------------------------
-- L9: helper functions used by RLS policies live in `private`, a schema that must NOT be in
-- the PostgREST "exposed schemas" list (Supabase default exposes only public + graphql_public),
-- so they cannot be probed via /rest/v1/rpc. Policies still call them (USAGE + EXECUTE granted).
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create or replace function private.is_published_project(pid text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.projects where id = pid and published)
$$;

create or replace function private.is_staff_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff_profiles where user_id = auth.uid() and role = 'admin')
$$;

revoke all on function private.is_published_project(text) from public;
revoke all on function private.is_staff_admin() from public;
grant execute on function private.is_published_project(text) to anon, authenticated, service_role;
grant execute on function private.is_staff_admin() to authenticated, service_role;

alter policy project_units_read_published on public.project_units
  using (private.is_published_project(project_id));
alter policy facts_read_published on public.facts
  using (is_current and private.is_published_project(project_id));
alter policy fact_sources_read_published on public.fact_sources
  using (exists (select 1 from public.facts f
                 where f.id = fact_sources.fact_id and f.is_current and private.is_published_project(f.project_id)));
alter policy regulatory_records_read_published on public.regulatory_records
  using (private.is_published_project(project_id));
alter policy regulatory_searches_read_published on public.regulatory_searches
  using (private.is_published_project(project_id));
alter policy project_documents_read_published on public.project_documents
  using (private.is_published_project(project_id));

drop function public.is_published_project(text);

-- ---------------------------------------------------------------------------
-- Advisor lead assignment: admins see/update all leads; advisors only leads assigned to them.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column assigned_to uuid references public.staff_profiles(user_id) on delete set null;
create index leads_assigned_idx on public.leads (assigned_to, created_at desc);

alter table public.lead_events drop constraint lead_events_event_type_check;
alter table public.lead_events add constraint lead_events_event_type_check
  check (event_type in ('created','status_changed','erased','retention_purged','assigned'));
alter table public.lead_events add column assigned_to uuid;

alter policy leads_staff_select on public.leads
  using (private.is_staff_admin() or (public.is_staff() and assigned_to = auth.uid()));
alter policy leads_staff_update on public.leads
  using (private.is_staff_admin() or (public.is_staff() and assigned_to = auth.uid()))
  with check (private.is_staff_admin() or (public.is_staff() and assigned_to = auth.uid()));
-- Only admins may (re)assign: assigned_to is not in the authenticated UPDATE column grant, so
-- assignment goes through the server (service role) after an admin check.
alter policy lead_events_staff_select on public.lead_events
  using (exists (select 1 from public.leads l where l.id = lead_events.lead_id));  -- inherits leads RLS
alter policy lead_events_staff_insert on public.lead_events
  with check (public.is_staff() and actor_id = auth.uid() and event_type = 'status_changed'
              and exists (select 1 from public.leads l where l.id = lead_events.lead_id));

-- Assignment (service role only, after the server's admin check): row lock + change + audit
-- in one transaction. Withdrawn leads cannot be (re)assigned; the assignee must be staff.
create or replace function public.lead_assign(p_lead_id uuid, p_assignee uuid, p_actor_id uuid) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_status text;
  v_prev uuid;
begin
  select status, assigned_to into v_status, v_prev from public.leads where id = p_lead_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_status = 'withdrawn' then
    return jsonb_build_object('status', 'withdrawn');
  end if;
  if p_assignee is not null and not exists (select 1 from public.staff_profiles where user_id = p_assignee) then
    return jsonb_build_object('status', 'unknown_assignee');
  end if;
  if v_prev is not distinct from p_assignee then
    return jsonb_build_object('status', 'unchanged');
  end if;
  update public.leads set assigned_to = p_assignee where id = p_lead_id;
  insert into public.lead_events (lead_id, actor_id, event_type, assigned_to)
    values (p_lead_id, p_actor_id, 'assigned', p_assignee);
  return jsonb_build_object('status', 'ok');
end $$;

-- ---------------------------------------------------------------------------
-- R2: completeness computed in SQL (KEEP IN SYNC with computeCompleteness in
-- src/research/publish.ts: 4 research facts + "≥1 unit with known price and area", over 5,
-- rounded to 3 decimals). A parity test compares both.
-- ---------------------------------------------------------------------------
create or replace function public.tn_compute_completeness(p_project_id text) returns numeric
language sql stable security invoker set search_path = public, pg_temp as $$
  select round((
    (select count(*) from public.facts f
      where f.project_id = p_project_id and f.is_current and f.unit_id is null and f.status = 'known'
        and f.field in ('address','rera_numbers','construction_status','declared_possession'))
    + case when exists (
        select 1 from public.project_units u
        where u.project_id = p_project_id
          and exists (select 1 from public.facts f where f.unit_id = u.id and f.is_current and f.status = 'known' and f.field = 'unit_price_inr')
          and exists (select 1 from public.facts f where f.unit_id = u.id and f.is_current and f.status = 'known' and f.field = 'unit_carpet_area_sqft'))
      then 1 else 0 end
  )::numeric / 5, 3)
$$;

-- Readiness uses the live SQL completeness (not the stored column), so it equals
-- evaluatePublishReadiness exactly (parity test: tests/db/migrate-seed.test.ts).
create or replace function public.tn_publish_blockers(p_project_id text) returns text[]
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  c_min_completeness constant numeric := 0.6;                          -- PUBLISH_MIN_COMPLETENESS
  c_rera_ok constant text[] := array['source_confirmed', 'reviewed'];  -- RERA verification required
  b text[] := '{}';
  v_completeness numeric;
  r record;
begin
  v_completeness := public.tn_compute_completeness(p_project_id);  -- R2/R4: same formula as TS
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

drop function public.research_set_fact(text, text, text, jsonb, text, jsonb, numeric, text, text);

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
  update public.facts set is_current = false
    where project_id = p_project_id and field = p_field and unit_id is null and is_current;
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

-- R1: verification change applies only if the fact row is still current AND its verification is
-- still what the reviewer saw (p_expected_from), compared under the row lock.
drop function public.research_set_verification(text, text, text, text, text, text, text);

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
  update public.facts set verification = p_to where id = p_fact_id;
  insert into public.fact_review_events (project_id, field, action, from_verification, to_verification, actor_id, actor_role, note)
    values (p_project_id, public.tn_research_field_label(p_field), 'verification_changed', v_from, p_to,
            p_actor_id, p_actor_role, p_note);
  v_auto := public.tn_auto_unpublish_if_not_ready(p_project_id, p_actor_id, p_actor_role);
  return jsonb_build_object('status', 'ok', 'from', v_from, 'auto_unpublished', v_auto);
end $$;

-- ---------------------------------------------------------------------------
-- Documents in Storage (private bucket `project-documents`)
-- ---------------------------------------------------------------------------
alter table public.project_documents
  add column content_type text check (content_type is null or content_type in ('application/pdf','image/png','image/jpeg')),
  add column size_bytes bigint check (size_bytes is null or (size_bytes > 0 and size_bytes <= 15728640)),
  add column sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  add column uploaded_by text,
  add constraint project_documents_storage_path_format check (
    storage_path is null or storage_path ~ '^[A-Za-z0-9-]+/[a-z0-9-]+/v[0-9]+/[A-Za-z0-9._-]+$');

-- Document upload: version allocation + row + audit in one transaction (service role only).
-- Audit: field 'documents' / action 'document_uploaded' (FactAuditEvent).
alter table public.fact_review_events drop constraint fact_review_events_field_check;
alter table public.fact_review_events add constraint fact_review_events_field_check check (field in
  ('address','reraNumbers','constructionStatus','declaredPossession','published','basics','documents'));
alter table public.fact_review_events drop constraint fact_review_events_action_check;
alter table public.fact_review_events add constraint fact_review_events_action_check check (action in
  ('fact_set','verification_changed','published','unpublished','basics_updated','created','document_uploaded'));
create or replace function public.research_add_document(
  p_project_id text, p_document_key text, p_title text, p_kind text, p_document_date date,
  p_source_id text, p_source_url text, p_storage_path text, p_content_type text, p_size_bytes bigint,
  p_sha256 text, p_version integer, p_actor_id text, p_actor_role text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_id text := gen_random_uuid()::text;
  v_next integer;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select coalesce(max(version), 0) + 1 into v_next from public.project_documents
    where project_id = p_project_id and document_key = p_document_key;
  if v_next <> p_version then
    return jsonb_build_object('status', 'conflict', 'next_version', v_next);
  end if;
  insert into public.project_documents (id, project_id, document_key, title, kind, version, document_date, source_id,
      source_url, observed_at, storage_path, content_type, size_bytes, sha256, uploaded_by)
    values (v_id, p_project_id, p_document_key, p_title, p_kind, p_version, p_document_date, p_source_id,
      p_source_url, now(), p_storage_path, p_content_type, p_size_bytes, p_sha256, p_actor_id);
  insert into public.fact_review_events (project_id, field, action, actor_id, actor_role, note)
    values (p_project_id, 'documents', 'document_uploaded', p_actor_id, p_actor_role,
            format('document uploaded: %s v%s (%s)', p_document_key, p_version, p_kind));
  return jsonb_build_object('status', 'ok', 'id', v_id);
end $$;

-- Bucket: created here when the Storage schema exists (hosted Supabase); otherwise skipped.
-- No storage.objects policies are granted to anon/authenticated: Storage RLS denies by default,
-- uploads and signed URLs are issued by the server with the service role (staff-gated).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('project-documents', 'project-documents', false, 15728640,
              array['application/pdf', 'image/png', 'image/jpeg'])
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.tn_compute_completeness(text)',
    'public.tn_publish_blockers(text)',
    'public.lead_assign(uuid, uuid, uuid)',
    'public.research_set_fact(text, text, text, jsonb, text, jsonb, text, text)',
    'public.research_set_verification(text, text, text, text, text, text, text, text)',
    'public.research_add_document(text, text, text, text, date, text, text, text, text, bigint, text, integer, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

grant select, insert, update on public.project_documents, public.leads, public.lead_events to service_role;

commit;
