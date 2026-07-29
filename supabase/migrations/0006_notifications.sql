-- supabase/migrations/0006_notifications.sql
--
-- Dedupe ledger for Slack notifications. The rule everywhere is INSERT FIRST,
-- POST SECOND: a primary-key collision means "already notified, post nothing".
-- Idempotent under retries, overlapping cron runs, and duplicate HCP webhook
-- deliveries, with no locking.
create table notifications_sent (
  kind      text not null,   -- 'invoice_paid' | 'estimate_approved'
                             -- | 'daily_digest' | 'weekly_lookahead'
  entity_id text not null,
  sent_at   timestamptz not null default now(),
  primary key (kind, entity_id)
);

-- SEEDS — must stay in this file, never split into 0007.
-- Thousands of invoices are already paid and ~hundreds of estimate options
-- already approved (as of 2026-07-29, ~2,234 paid invoices; verify against live count).
-- Without these seeds the first notifier run treats every one as new
-- and posts thousands of Slack messages.

insert into notifications_sent (kind, entity_id)
select 'invoice_paid', id from invoices where status = 'paid'
on conflict do nothing;

-- Approval is per-option, so the key is "{estimate_id}:{option_id}". The '0'
-- fallback for an option with no id MUST match estimateOptionKey() in
-- src/lib/notifications/detect.ts, or seeded rows will fail to suppress the
-- notifications they exist to suppress.
-- Guard jsonb_array_elements with a type check: if a historical estimate has
-- options stored as null, an object, or a scalar, unguarded jsonb_array_elements
-- would raise an error and abort the entire insert, leaving estimate_approved
-- completely unseeded (the exact partial-seed state this migration exists to prevent).
insert into notifications_sent (kind, entity_id)
select 'estimate_approved', e.id || ':' || coalesce(o->>'id', '0')
from estimates e,
     jsonb_array_elements(
       case when jsonb_typeof(e.raw->'options') = 'array'
            then e.raw->'options'
            else '[]'::jsonb
       end
     ) o
where lower(o->>'approval_status') in ('approved', 'pro approved')
on conflict do nothing;
