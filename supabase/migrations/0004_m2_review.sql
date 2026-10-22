-- M2 review fixes. New migration (rather than editing 0003) so every ledger stays consistent.
--   M1: private.settings — deployment marker read by the migration runner and the seed
--       (environment = 'production' refuses the SAMPLE seed).
--   L1: drop client (authenticated) grants on leads / lead_events. All lead access goes through the
--       server with the service role after requireStaff() + service-layer scoping; the RLS policies
--       stay in place as defence in depth should a grant ever be re-added.
begin;

create table if not exists private.settings (
  key text primary key check (key ~ '^[a-z_]+$'),
  value text not null,
  updated_at timestamptz not null default now(),
  constraint settings_environment_value check (key <> 'environment' or value in ('production', 'staging', 'development'))
);
revoke all on private.settings from public, anon, authenticated;
grant select, insert, update on private.settings to service_role;

revoke select, update on public.leads from authenticated;
revoke select, insert on public.lead_events from authenticated;

commit;
