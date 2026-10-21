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

-- Atomic fact replacement for staff edits (service role only): retires the current value,
-- inserts the new one with its sources, and stores the recomputed completeness.
create or replace function public.research_set_fact(
  p_project_id text,
  p_field text,            -- facts.field (snake_case)
  p_status text,
  p_value jsonb,
  p_verification text,
  p_sources jsonb,         -- [{sourceId, url, observedAt, documentDate?, note?}]
  p_completeness numeric
) returns text
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_fact_id text := gen_random_uuid()::text;
begin
  if p_field not in ('address','rera_numbers','construction_status','declared_possession') then
    raise exception 'unsupported research field %', p_field using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id) then
    raise exception 'project not found' using errcode = 'no_data_found';
  end if;
  update public.facts set is_current = false
    where project_id = p_project_id and field = p_field and unit_id is null and is_current;
  insert into public.facts (id, project_id, field, value, status, verification)
    values (v_fact_id, p_project_id, p_field, p_value, p_status, p_verification);
  insert into public.fact_sources (fact_id, source_id, url, observed_at, document_date, note)
    select v_fact_id, s->>'sourceId', s->>'url', (s->>'observedAt')::timestamptz,
           nullif(s->>'documentDate', '')::date, nullif(s->>'note', '')
    from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) s;
  update public.projects set completeness = p_completeness, last_checked_at = now() where id = p_project_id;
  return v_fact_id;
end $$;

revoke all on function public.research_set_fact(text, text, text, jsonb, text, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.research_set_fact(text, text, text, jsonb, text, jsonb, numeric) to service_role;

commit;
