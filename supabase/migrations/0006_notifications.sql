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
-- 2,217 invoices are already paid and ~hundreds of estimate options already
-- approved. Without these seeds the first notifier run treats every one as new
-- and posts thousands of Slack messages.

insert into notifications_sent (kind, entity_id)
select 'invoice_paid', id from invoices where status = 'paid'
on conflict do nothing;

-- Approval is per-option, so the key is "{estimate_id}:{option_id}". The '0'
-- fallback for an option with no id MUST match estimateOptionKey() in
-- src/lib/notifications/detect.ts, or seeded rows will fail to suppress the
-- notifications they exist to suppress.
insert into notifications_sent (kind, entity_id)
select 'estimate_approved', e.id || ':' || coalesce(o->>'id', '0')
from estimates e, jsonb_array_elements(e.raw->'options') o
where lower(o->>'approval_status') in ('approved', 'pro approved')
on conflict do nothing;
