-- supabase/migrations/0008_enable_rls.sql
--
-- Closes public read access to every business table.
--
-- 0001-0006 created their tables without row level security, and Supabase grants
-- the anon and authenticated roles access to new public tables by default. The
-- anon key ships to the browser (the Trinity Ops login page), so anyone holding
-- it could read customers, jobs, invoices, estimates, attachments, leads and
-- technicians through the REST API. Found 2026-11-07.
--
-- The application never reads these tables with the anon key or a user session:
-- every query goes through the service-role client (src/lib/supabase/client.ts),
-- which bypasses RLS. The anon key is used only for sign-in (login page,
-- middleware, src/lib/mobile/session.ts). So enabling RLS with no policies, and
-- revoking the anon/authenticated grants, changes nothing for the app.
--
-- Any new table must enable RLS in its own migration, as 0007 does.

alter table public.attachments        enable row level security;
alter table public.customers          enable row level security;
alter table public.estimates          enable row level security;
alter table public.geocode_cache      enable row level security;
alter table public.invoices           enable row level security;
alter table public.jobs               enable row level security;
alter table public.leads              enable row level security;
alter table public.notifications_sent enable row level security;
alter table public.sync_cursors       enable row level security;
alter table public.technicians        enable row level security;
alter table public.declined_calls     enable row level security;

revoke all on
  public.attachments, public.customers, public.estimates, public.geocode_cache,
  public.invoices, public.jobs, public.leads, public.notifications_sent,
  public.sync_cursors, public.technicians, public.declined_calls
from anon, authenticated;
