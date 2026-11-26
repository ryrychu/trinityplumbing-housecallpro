-- supabase/migrations/0011_enable_rls.sql
--
-- Closes public access to every table in the public schema.
--
-- 0001-0006 created their tables without row level security, and Supabase
-- grants the anon and authenticated roles full access to new public tables by
-- default. The anon key ships to the browser (the Trinity Ops login page), so
-- anyone holding it could read customers, jobs, invoices, estimates,
-- attachments, leads and technicians through the REST API. Found 2026-11-07.
-- 0007 and later enable RLS on their own tables but leave the default grants.
--
-- The application never reads these tables with the anon key or a user
-- session: every query goes through the service-role client
-- (src/lib/supabase/client.ts), which bypasses RLS. The anon key is used only
-- for sign-in (login page, middleware, src/lib/mobile/session.ts). So enabling
-- RLS with no policies, and revoking the anon/authenticated grants, changes
-- nothing for the app.
--
-- Numbered 0011 because 0008 is task_checklists, 0009 is the price book branch
-- and 0010 is the site chat branch. It loops over whatever tables exist when it
-- runs, so it is correct whichever of those is applied first, and it is safe to
-- run again. If it is pushed before 0009 or 0010, push those later with
-- `npx supabase db push --include-all`.

do $$
declare
  t regclass;
begin
  for t in
    select c.oid::regclass
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      -- skip tables owned by an extension (none today)
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
      )
  loop
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on table %s from anon, authenticated', t);
  end loop;
end
$$;

revoke all on all sequences in schema public from anon, authenticated;

-- Tables and sequences created later (by this role, which runs the migrations)
-- no longer get the anon/authenticated grants. New tables must still enable
-- RLS in their own migration.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
