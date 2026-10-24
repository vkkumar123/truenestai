-- S3a: K-RERA document extraction (D19). Additive only; 0001–0006 are never edited.
--
-- Owner decision (Fury, 2026-10-24): K-RERA documents reach TrueNest ONLY by staff upload. Staff
-- download a document from K-RERA by hand and upload it in admin; Claude reads the PDF and
-- extracts project details with page citations; staff review them. No automated access to
-- K-RERA, ever (D16: robots.txt disallows it; the search has a CAPTCHA).
--
-- This migration adds:
--   * document_extractions: one row per uploaded document version (idempotency key), its status,
--     error code, model and counts. Service role only. Status changes follow a guard trigger.
--   * fact_observations.document_id / page_number: an extracted value links to the uploaded
--     document and the page its citation came from. A document row needs no public URL (an
--     upload has none); its provenance is the document + page + excerpt instead.
--   * catalogue attributes a registration document states (rera_numbers, project_name,
--     promoter_name, address, plan_approvals). Schema metadata only, no property data.
--   * extraction_start / extraction_finish RPCs (service role): claim + finish atomically,
--     observations + extraction row + audit event in one transaction.
--   * facts_current redefined with SOURCE PRECEDENCE inside each truth level (owner, 2026-10-24:
--     "1st source should be K-RERA then other website"): official > estimated > unknown as
--     before, then source_type rera > govt > builder > everything else, then newest observed_at.
--     A verified KNOWN curated value still wins outright. Every other live value stays in
--     `conflicts`.
--
-- Every 0006 guarantee is kept: observations are always unverified, official needs an official
-- source type, excerpts are <= 20 words, history is append-only for every role, no anon or
-- authenticated access to any of these tables or views.

begin;

-- ---------------------------------------------------------------------------
-- Catalogue additions (KEEP IN SYNC with FACT_ATTRIBUTES in src/server/repositories/fact-store.ts;
-- a unit test compares them). address / rera_numbers map to the curated facts fields, so
-- facts_current compares an extracted value with the staff-curated one.
-- ---------------------------------------------------------------------------
insert into public.fact_attributes
  (entity_type, attribute, value_kind, unit, legally_significant, default_ttl_hours, legacy_field, description) values
  ('project', 'rera_numbers',               'json',   null,     true,  720,  'rera_numbers', 'RERA registration numbers as printed in a registration document'),
  ('project', 'project_name',               'text',   null,     false, 2160, null, 'Project name as printed in a registration document'),
  ('project', 'promoter_name',              'text',   null,     false, 2160, null, 'Promoter (company or organisation) as printed; never an individual''s name'),
  ('project', 'address',                    'text',   null,     false, 2160, 'address', 'Project address or site location as printed'),
  ('project', 'plan_approvals',             'json',   null,     true,  720,  null, 'Plan sanctions and other approvals listed in a document (not a check of their validity)');

-- ---------------------------------------------------------------------------
-- fact_observations: document link
-- ---------------------------------------------------------------------------
alter table public.fact_observations
  -- a deleted document version takes its extracted observations with it; the history trigger
  -- copies each deleted row into fact_observations_history first (constitution §4)
  add column document_id text references public.project_documents(id) on delete cascade,
  add column page_number integer check (page_number is null or page_number between 1 and 10000),
  add constraint fact_observations_document_page check ((document_id is null) = (page_number is null)),
  -- only extraction writes document rows, only from a regulator or fixture document, always with
  -- an excerpt (the provenance shown to staff: document + page + excerpt)
  add constraint fact_observations_document_extraction check (
    document_id is null
    or (added_by = 'extraction' and source_type in ('rera','fixture') and excerpt is not null));

-- Relaxed provenance rule: a known value needs a source URL OR (an uploaded document has none) a
-- document_id. Unchanged for every row without a document_id.
alter table public.fact_observations drop constraint fact_observations_value_matches_status;
alter table public.fact_observations add constraint fact_observations_value_matches_status check (
  (status = 'unknown' and value_text is null and value_num is null and value_date is null and value_json is null)
  or (status <> 'unknown' and (source_url is not null or document_id is not null)
      and (value_text is not null or value_num is not null or value_date is not null or value_json is not null)));

-- Uniqueness: rows without a document keep the 0006 key (entity, attribute, source_url). Document
-- rows are keyed by (entity, attribute, document_id): one value per attribute per document version.
-- (the 0006 unique constraint has a generated, truncated name: look it up by its columns)
do $$
declare v_name text;
begin
  select c.conname into strict v_name from pg_constraint c
    where c.conrelid = 'public.fact_observations'::regclass and c.contype = 'u'
      and (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
          = array['entity_type','entity_id','attribute','source_url'];
  execute format('alter table public.fact_observations drop constraint %I', v_name);
end $$;
create unique index fact_observations_source_url_uq on public.fact_observations
  (entity_type, entity_id, attribute, source_url) nulls not distinct where document_id is null;
create unique index fact_observations_document_uq on public.fact_observations
  (entity_type, entity_id, attribute, document_id) where document_id is not null;
create index fact_observations_document_idx on public.fact_observations (document_id) where document_id is not null;

-- A document row belongs to the document's project and cites the document's registry source;
-- document_id never changes (identity).
create or replace function public.tn_fact_observations_document_validate() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_project text;
  v_source text;
begin
  if tg_op = 'UPDATE' and new.document_id is distinct from old.document_id then
    raise exception 'fact_observations.document_id cannot change' using errcode = 'check_violation';
  end if;
  if new.document_id is not null then
    select project_id, source_id into v_project, v_source from public.project_documents where id = new.document_id;
    if not found then
      raise exception 'unknown document %', new.document_id using errcode = 'foreign_key_violation';
    end if;
    if new.entity_type <> 'project' or new.entity_id <> v_project then
      raise exception 'a document observation must belong to the document''s project' using errcode = 'check_violation';
    end if;
    if new.source_id <> v_source then
      raise exception 'a document observation must cite the document''s source' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger fact_observations_document_validate before insert or update on public.fact_observations
  for each row execute function public.tn_fact_observations_document_validate();

-- History keeps the document link too (append-only table: adding nullable columns is DDL only).
alter table public.fact_observations_history
  add column document_id text,
  add column page_number integer;

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
      is_sample, created_at, updated_at, operation, document_id, page_number)
    values (old.id, old.entity_type, old.entity_id, old.attribute, old.value_text, old.value_num, old.value_date,
      old.value_json, old.unit, old.status, old.confidence, old.estimate_basis, old.source_id, old.source_url,
      old.source_type, old.observed_at, old.last_verified_at, old.ttl_hours, old.excerpt, old.added_by,
      old.verification, old.is_sample, old.created_at, old.updated_at, tg_op, old.document_id, old.page_number);
  return null;
end $$;
revoke all on function public.tn_fact_observations_to_history() from public, anon, authenticated;
revoke all on function public.tn_fact_observations_document_validate() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- document_extractions: one row per document version (document_id unique = idempotency key).
-- running → succeeded | failed | unsupported. failed → running (retry). succeeded and unsupported
-- are final: the document version is immutable, so its extraction is never re-run.
-- ---------------------------------------------------------------------------
create table public.document_extractions (
  id text primary key default gen_random_uuid()::text,
  document_id text not null unique references public.project_documents(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  status text not null check (status in ('running','succeeded','failed','unsupported')),
  error_code text check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  model text check (model is null or model ~ '^[a-z0-9][a-z0-9.\-]{1,80}$'),
  document_sha256 text check (document_sha256 is null or document_sha256 ~ '^[0-9a-f]{64}$'),
  kept_count integer not null default 0 check (kept_count >= 0),
  dropped_count integer not null default 0 check (dropped_count >= 0),
  -- reason code → count (e.g. {"not_cited": 1, "personal_data": 1}); never values or text
  dropped_reasons jsonb not null default '{}'::jsonb check (jsonb_typeof(dropped_reasons) = 'object'),
  attempts integer not null default 1 check (attempts between 1 and 100),
  requested_by text not null check (char_length(requested_by) between 1 and 100),
  requested_role text not null check (requested_role in ('advisor','admin')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_extractions_finished check ((status = 'running') = (finished_at is null)),
  constraint document_extractions_error_code check (
    (status in ('failed','unsupported')) = (error_code is not null)),
  constraint document_extractions_counts check (status = 'succeeded' or kept_count = 0)
);
create index document_extractions_project_idx on public.document_extractions (project_id);

create or replace function public.tn_document_extractions_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old; -- cascade from deleting the document or project (SAMPLE cleanup)
    end if;
    raise exception 'document_extractions rows cannot be deleted' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'running' then
      raise exception 'a new extraction starts as running' using errcode = 'check_violation';
    end if;
    if new.project_id is distinct from (select project_id from public.project_documents where id = new.document_id) then
      raise exception 'document_extractions.project_id must be the document''s project' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.document_id is distinct from old.document_id
     or new.project_id is distinct from old.project_id or new.created_at is distinct from old.created_at then
    raise exception 'document_extractions identity columns cannot change' using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'running' and new.status in ('succeeded','failed','unsupported'))
    or (old.status = 'failed' and new.status = 'running')
    or (old.status = 'running' and new.status = 'running')) then
    raise exception 'invalid extraction status change % → %', old.status, new.status using errcode = 'check_violation';
  end if;
  if old.status in ('succeeded','unsupported') then
    raise exception 'a finished extraction (%) is final', old.status using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.tn_document_extractions_guard() from public, anon, authenticated;

create trigger document_extractions_guard before insert or update or delete on public.document_extractions
  for each row execute function public.tn_document_extractions_guard();
create trigger document_extractions_no_truncate before truncate on public.document_extractions
  for each statement execute function public.tn_reject_audit_mutation();

-- Audit vocabulary: field 'documents' / action 'document_extracted' (FactAuditEvent).
alter table public.fact_review_events drop constraint fact_review_events_action_check;
alter table public.fact_review_events add constraint fact_review_events_action_check check (action in
  ('fact_set','verification_changed','published','unpublished','basics_updated','created','document_uploaded',
   'document_extracted'));

-- ---------------------------------------------------------------------------
-- extraction_start: claims the extraction of one document version.
--   started      a new row, or a retry of a failed one / of a running one older than p_stale_minutes
--   done         already succeeded or unsupported (idempotent: never re-run)
--   in_progress  running and not stale
--   not_found    no such document
-- ---------------------------------------------------------------------------
create or replace function public.extraction_start(
  p_document_id text, p_model text, p_actor_id text, p_actor_role text, p_stale_minutes integer
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_doc record;
  v_row public.document_extractions;
begin
  select id, project_id, sha256 into v_doc from public.project_documents where id = p_document_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into v_row from public.document_extractions where document_id = p_document_id for update;
  if not found then
    insert into public.document_extractions (document_id, project_id, status, model, document_sha256, requested_by, requested_role)
      values (p_document_id, v_doc.project_id, 'running', p_model, v_doc.sha256, p_actor_id, p_actor_role)
      returning * into v_row;
    return jsonb_build_object('outcome', 'started', 'extraction', to_jsonb(v_row));
  end if;
  if v_row.status in ('succeeded','unsupported') then
    return jsonb_build_object('outcome', 'done', 'extraction', to_jsonb(v_row));
  end if;
  if v_row.status = 'running' and v_row.started_at > now() - make_interval(mins => greatest(p_stale_minutes, 1)) then
    return jsonb_build_object('outcome', 'in_progress', 'extraction', to_jsonb(v_row));
  end if;
  update public.document_extractions set
      status = 'running', error_code = null, model = p_model, kept_count = 0, dropped_count = 0,
      dropped_reasons = '{}'::jsonb, attempts = attempts + 1, requested_by = p_actor_id, requested_role = p_actor_role,
      started_at = now(), finished_at = null
    where id = v_row.id returning * into v_row;
  return jsonb_build_object('outcome', 'started', 'extraction', to_jsonb(v_row));
end $$;

-- ---------------------------------------------------------------------------
-- extraction_finish: records the outcome of a RUNNING extraction. For 'succeeded', writes each
-- validated value as an unverified, official, rera (or fixture) observation of the document's
-- project, with page + excerpt, then the counts and one audit event — all in this transaction.
-- p_values: [{attribute, value_text?, value_num?, value_date?, value_json?, page_number, excerpt}]
-- ---------------------------------------------------------------------------
create or replace function public.extraction_finish(
  p_extraction_id text, p_status text, p_error_code text, p_values jsonb, p_dropped_count integer,
  p_dropped_reasons jsonb, p_actor_id text, p_actor_role text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_row public.document_extractions;
  v_doc record;
  v_source_type text;
  v_kept integer := 0;
  v_now timestamptz := now();
  v jsonb;
begin
  if p_status not in ('succeeded','failed','unsupported') then
    raise exception 'invalid extraction outcome %', p_status using errcode = 'check_violation';
  end if;
  select * into v_row from public.document_extractions where id = p_extraction_id for update;
  if not found or v_row.status <> 'running' then
    return jsonb_build_object('status', 'not_running');
  end if;
  select d.id, d.project_id, d.source_id, d.source_url, d.observed_at, d.title, d.version, s.type as source_kind, p.is_sample
    into v_doc
    from public.project_documents d
    join public.sources s on s.id = d.source_id
    join public.projects p on p.id = d.project_id
    where d.id = v_row.document_id;
  if p_status = 'succeeded' then
    v_source_type := case v_doc.source_kind when 'regulator' then 'rera' when 'fixture' then 'fixture' end;
    if v_source_type is null then
      raise exception 'only regulator or fixture documents can be extracted' using errcode = 'check_violation';
    end if;
    for v in select * from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) loop
      insert into public.fact_observations (entity_type, entity_id, attribute, value_text, value_num, value_date, value_json,
          unit, status, source_id, source_url, source_type, observed_at, last_verified_at, ttl_hours, excerpt, added_by,
          verification, is_sample, document_id, page_number)
        select 'project', v_doc.project_id, a.attribute, v->>'value_text', (v->>'value_num')::numeric, (v->>'value_date')::date,
               case when jsonb_typeof(v->'value_json') in ('array','object') then v->'value_json' end,
               a.unit, 'official', v_doc.source_id, v_doc.source_url, v_source_type,
               v_doc.observed_at, greatest(v_now, v_doc.observed_at), a.default_ttl_hours, v->>'excerpt', 'extraction',
               'unverified', v_doc.is_sample, v_doc.id, (v->>'page_number')::integer
        from public.fact_attributes a
        where a.entity_type = 'project' and a.attribute = v->>'attribute'
      on conflict (entity_type, entity_id, attribute, document_id) where document_id is not null do update set
        value_text = excluded.value_text, value_num = excluded.value_num, value_date = excluded.value_date,
        value_json = excluded.value_json, unit = excluded.unit, source_url = excluded.source_url,
        last_verified_at = excluded.last_verified_at, excerpt = excluded.excerpt, page_number = excluded.page_number;
      if not found then
        raise exception 'unknown attribute %', v->>'attribute' using errcode = 'check_violation';
      end if;
      v_kept := v_kept + 1;
    end loop;
  end if;
  update public.document_extractions set
      status = p_status, error_code = case when p_status = 'succeeded' then null else p_error_code end,
      kept_count = v_kept, dropped_count = greatest(coalesce(p_dropped_count, 0), 0),
      dropped_reasons = coalesce(p_dropped_reasons, '{}'::jsonb), finished_at = v_now
    where id = v_row.id returning * into v_row;
  insert into public.fact_review_events (project_id, field, action, actor_id, actor_role, note)
    values (v_doc.project_id, 'documents', 'document_extracted', p_actor_id, p_actor_role,
            format('document extraction %s: %s v%s, %s value(s) kept, %s dropped%s', p_status, v_doc.title, v_doc.version,
                   v_kept, v_row.dropped_count,
                   case when p_status = 'succeeded' then '' else ' (' || coalesce(p_error_code, 'error') || ')' end));
  return jsonb_build_object('status', 'ok', 'extraction', to_jsonb(v_row));
end $$;

revoke all on function public.extraction_start(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.extraction_finish(text, text, text, jsonb, integer, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.extraction_start(text, text, text, text, integer) to service_role;
grant execute on function public.extraction_finish(text, text, text, jsonb, integer, jsonb, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- facts_current, redefined (same columns, same order): source precedence inside each truth
-- level (D19). Precedence: a KNOWN curated value whose verification is source_confirmed or
-- reviewed wins; otherwise official > estimated > unknown; then source_type rera > govt >
-- builder > everything else; then newest observed_at; then id. Every other live row is listed in
-- `conflicts` (never hidden, constitution §3). Mirror: compareCandidates in fact-store.ts.
-- ---------------------------------------------------------------------------
create or replace view public.facts_current with (security_invoker = true) as
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
    f.status = 'known' and f.verification in ('source_confirmed','reviewed')
  from public.facts f
  join public.fact_attributes a on a.entity_type = 'project' and a.legacy_field = f.field
  join public.projects p on p.id = f.project_id
  cross join lateral (select coalesce(public.tn_curated_truth_status(f.id, f.status), f.truth_status) as truth) tr
  cross join lateral (select case when a.value_kind = 'date' and jsonb_typeof(f.value) = 'string'
                                  then public.tn_try_date(f.value #>> '{}') end as d) dt
  left join lateral (
    select fs.source_id, fs.url, fs.observed_at, s.type
    from public.fact_sources fs join public.sources s on s.id = fs.source_id
    where fs.fact_id = f.id
    order by public.tn_source_is_official(s.id, s.type, s.status) desc, fs.observed_at desc, fs.id
    limit 1
  ) ls on true
  where f.is_current and f.unit_id is null and (f.status = 'unknown' or ls.source_id is not null)
),
ranked as (
  select c.*,
    row_number() over (
      partition by c.entity_type, c.entity_id, c.attribute
      order by c.curated_verified desc,
               array_position(array['official','estimated','unknown'], c.truth_status),
               -- D19 (owner, 2026-10-24): K-RERA first, then government, then the builder, then the rest
               coalesce(array_position(array['rera','govt','builder'], c.source_type), 4),
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

-- facts_history needs no change: it does not rank, and the history table keeps document_id and
-- page_number for staff reads.

-- ---------------------------------------------------------------------------
-- RLS + grants: service role only (Supabase default privileges grant ALL; revoke first).
-- ---------------------------------------------------------------------------
alter table public.document_extractions enable row level security;
revoke all on public.document_extractions from public, anon, authenticated, service_role;
grant select, insert, update on public.document_extractions to service_role;   -- no delete
-- create or replace view keeps the view's ACL; restated: service role read only
revoke all on public.facts_current from public, anon, authenticated, service_role;
grant select on public.facts_current to service_role;

commit;
