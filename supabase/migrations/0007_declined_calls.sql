-- supabase/migrations/0007_declined_calls.sql
--
-- Calls Trinity turned down: crew too busy, or a contract customer too far
-- away. Logged one at a time by the office with `/trinity declined …`; totalled
-- weekly for Dave (about 15 a week means another van and plumber).
--
-- No raw phone numbers. phone_hash is an HMAC-SHA256 of the normalized
-- 10-digit number, salted with the DECLINED_PHONE_SALT env var, and exists only
-- so a repeat caller counts once per Mon–Sun week. Null when no number was
-- given; such a row always counts on its own.
--
-- The Monday report is de-duplicated through notifications_sent (0006) with
-- kind 'declined_weekly' and entity_id = the reported week's Monday
-- (YYYY-MM-DD, Eastern). That column is free text, so no change is needed there.
create table declined_calls (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  reason        text not null check (reason in ('busy', 'distance')),
  slack_user_id text not null,                -- who logged it (Slack member id)
  note          text check (note is null or char_length(note) <= 200),
  phone_hash    text                          -- salted hash, never the number
);

create index declined_calls_created_at_idx on declined_calls (created_at);
create index declined_calls_user_idx on declined_calls (slack_user_id, created_at desc);

-- Only the server touches this table, through the service-role key (which
-- bypasses RLS). Enabling RLS with no policies keeps the public anon key, which
-- ships to the browser, from reading or writing it.
alter table declined_calls enable row level security;
