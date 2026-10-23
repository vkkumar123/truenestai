-- M2.5: on-demand research jobs. A public search miss enqueues a job; a worker (Cloud Scheduler →
-- POST /api/internal/research/run) claims jobs, runs approved web research and stores survivors as
-- Lane B external_listings (always unverified), linked to the job in research_job_listings.
-- Service role only: no anon/authenticated grants, RLS on with no client policies.
-- See docs/RESEARCH_WORKER.md.

begin;

create table public.research_jobs (
  id uuid primary key default gen_random_uuid(),
  -- The buyer's raw query (staff-visible; never logged by the app).
  query_text text not null check (char_length(query_text) between 1 and 100),
  query_key text not null check (char_length(query_key) between 3 and 160),
  locality_id text references public.localities(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','done','no_results','failed')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  result_count integer not null default 0 check (result_count >= 0),
  -- Short machine code only: no PII, prompt or response text.
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  -- HMAC-SHA256 hex of the client IP (never the IP itself); null when no key is configured.
  requester_ip_hash text check (requester_ip_hash is null or requester_ip_hash ~ '^[0-9a-f]{64}$'),
  constraint research_jobs_finished_at check ((status in ('done','no_results','failed')) = (finished_at is not null))
);
-- At most one active job per normalised query. "Recent" (cache TTL) is checked in research_enqueue.
create unique index research_jobs_active_key on public.research_jobs (query_key) where status in ('queued','running');
create index research_jobs_key_finished_idx on public.research_jobs (query_key, finished_at desc)
  where status in ('done','no_results','failed');
create index research_jobs_queue_idx on public.research_jobs (requested_at) where status in ('queued','running');
create index research_jobs_requested_idx on public.research_jobs (requested_at desc);

create table public.research_job_listings (
  job_id uuid not null references public.research_jobs(id) on delete cascade,
  external_listing_id text not null references public.external_listings(id) on delete cascade,
  primary key (job_id, external_listing_id)
);
create index research_job_listings_listing_idx on public.research_job_listings (external_listing_id);

alter table public.research_jobs enable row level security;
alter table public.research_job_listings enable row level security;
revoke all on public.research_jobs, public.research_job_listings from public, anon, authenticated;
grant select, insert, update on public.research_jobs to service_role;
grant select, insert, delete on public.research_job_listings to service_role;
-- No policies for anon/authenticated: with RLS on and no grants they can neither see nor write.

-- ---------------------------------------------------------------------------
-- Enqueue (atomic), in order:
--   1. Queued jobs not picked up for 30 minutes (worker down or misconfigured) are marked
--      failed with error_code 'stalled', so they stop showing as "researching" and stop holding
--      their query key.
--   2. Reuse an active (queued/running) job for the key            → 'active'
--   3. Reuse a done/no_results job within p_cache_hours            → 'cached'
--   4. Reuse a failed job (including 'stalled') within 6 hours     → 'failed_recently'
--      (no automatic re-research of a failing query; the page shows "unavailable")
--   5. Global and per-requester 24-hour caps                        → 'daily_cap' / 'requester_cap'
--   6. Insert                                                       → 'queued'
-- A transaction-scoped advisory lock serialises enqueues so concurrent misses cannot exceed caps.
-- ---------------------------------------------------------------------------
create or replace function public.research_enqueue(
  p_query_text text,
  p_query_key text,
  p_locality_id text,
  p_ip_hash text,
  p_cache_hours integer,
  p_max_per_day integer,
  p_max_per_requester integer
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

  insert into public.research_jobs (query_text, query_key, locality_id, requester_ip_hash)
    values (left(p_query_text, 100), p_query_key, p_locality_id, p_ip_hash)
    returning * into v_job;
  return jsonb_build_object('outcome', 'queued', 'job', to_jsonb(v_job) - 'requester_ip_hash');
end $$;

-- Claim (atomic): oldest queued jobs, plus running jobs whose worker died (started over
-- p_stale_minutes ago) that still have a retry left. Stale running jobs that already used both
-- attempts are marked failed with error_code 'abandoned' instead of being reclaimed.
-- FOR UPDATE SKIP LOCKED lets concurrent workers take disjoint jobs.
create or replace function public.research_claim_jobs(p_limit integer, p_stale_minutes integer)
returns setof jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  update public.research_jobs
     set status = 'failed', error_code = 'abandoned', finished_at = now()
   where id in (
     select id from public.research_jobs
      where status = 'running' and attempts >= 2
        and started_at < now() - make_interval(mins => greatest(p_stale_minutes, 1))
      for update skip locked);

  return query
  update public.research_jobs j
     set status = 'running', started_at = now(), attempts = j.attempts + 1
   where j.id in (
     select id from public.research_jobs
      where status = 'queued'
         or (status = 'running' and attempts < 2
             and started_at < now() - make_interval(mins => greatest(p_stale_minutes, 1)))
      order by requested_at
      for update skip locked
      limit greatest(0, least(p_limit, 20)))
  returning to_jsonb(j) - 'requester_ip_hash';
end $$;

-- Finish: only a running job; 'queued' re-queues for one retry (refused once attempts >= 2, which
-- becomes 'failed'). Links the stored listings. Returns null when the job is not running.
create or replace function public.research_finish_job(
  p_id uuid,
  p_status text,
  p_result_count integer,
  p_error_code text,
  p_listing_ids text[]
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_job public.research_jobs;
  v_status text := p_status;
begin
  if p_status not in ('done','no_results','failed','queued') then
    raise exception 'invalid research job status %', p_status using errcode = '22023';
  end if;
  select * into v_job from public.research_jobs where id = p_id for update;
  if not found or v_job.status <> 'running' then
    return null;
  end if;
  if v_status = 'queued' and v_job.attempts >= 2 then
    v_status := 'failed';
  end if;
  update public.research_jobs
     set status = v_status,
         result_count = greatest(coalesce(p_result_count, 0), 0),
         error_code = p_error_code,
         finished_at = case when v_status = 'queued' then null else now() end
   where id = p_id
   returning * into v_job;
  insert into public.research_job_listings (job_id, external_listing_id)
    select p_id, x from unnest(coalesce(p_listing_ids, '{}'::text[])) as x
    on conflict do nothing;
  return to_jsonb(v_job) - 'requester_ip_hash';
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.research_enqueue(text, text, text, text, integer, integer, integer)',
    'public.research_claim_jobs(integer, integer)',
    'public.research_finish_job(uuid, text, integer, text, text[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
