-- supabase/migrations/0010_site_chat.sql
--
-- The website chat bubble (trinity.plumbing first). One row per visitor
-- conversation in chat_conversations, one per message in chat_messages, and
-- fixed-window message counters in chat_rate_limits.
--
-- No raw IP addresses: a rate-limit key holds an HMAC of the IP, salted with
-- the CHAT_IP_SALT env var. Message text is saved with phone numbers and email
-- addresses masked (src/lib/chat/redact.ts). The cron sync deletes
-- conversations 90 days after they start (messages go with them) and
-- rate-limit rows after 2 days (src/lib/chat/store.ts).
--
-- Numbered 0010 because 0009 belongs to the unmerged feat/pricebook-edit.
-- Keep the number even if this merges first, so the two never collide.
create table chat_conversations (
  id              uuid primary key,
  site            text not null check (char_length(site) between 1 and 40),
  started_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  message_count   int not null default 0
);

create table chat_messages (
  id              bigserial primary key,
  conversation_id uuid not null references chat_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  text            text not null check (char_length(text) <= 2000),
  emergency       boolean not null default false,
  created_at      timestamptz not null default now()
);

create table chat_rate_limits (
  key          text not null,               -- 'ip:<site>:<hmac>' or 'site:<site>'
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (key, window_start)
);

create index chat_conversations_started_at_idx on chat_conversations (started_at);
create index chat_messages_conversation_idx on chat_messages (conversation_id, id);
create index chat_rate_limits_window_idx on chat_rate_limits (window_start);

-- Only the server touches these, through the service-role key (which bypasses
-- RLS). RLS with no policies, and no grants for the browser-facing roles,
-- keeps the anon key that ships to the browser out, as in 0007 and 0008.
alter table chat_conversations enable row level security;
alter table chat_messages enable row level security;
alter table chat_rate_limits enable row level security;

revoke all on chat_conversations, chat_messages, chat_rate_limits from anon, authenticated;
revoke all on sequence chat_messages_id_seq from anon, authenticated;

-- Count one message in a window and return the new count, in one statement,
-- so two requests at the same moment can't both read the old count.
create function chat_rate_limit_hit(p_key text, p_window_start timestamptz) returns int
language sql as $$
  insert into chat_rate_limits as r (key, window_start, count)
  values (p_key, p_window_start, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning count;
$$;

-- Save one visitor message and its reply in one transaction. A conversation
-- id already used by another site is refused rather than mixed in.
create function chat_save_turn(
  p_conversation_id uuid,
  p_site text,
  p_user_text text,
  p_reply text,
  p_emergency boolean
) returns void
language plpgsql as $$
begin
  insert into chat_conversations as c (id, site, message_count)
  values (p_conversation_id, p_site, 2)
  on conflict (id) do update
    set last_message_at = now(), message_count = c.message_count + 2
    where c.site = excluded.site;
  if not found then
    raise exception 'chat conversation % belongs to another site', p_conversation_id;
  end if;
  insert into chat_messages (conversation_id, role, text, emergency)
  values (p_conversation_id, 'user', p_user_text, false),
         (p_conversation_id, 'assistant', p_reply, p_emergency);
end;
$$;

revoke execute on function chat_rate_limit_hit(text, timestamptz) from public, anon, authenticated;
revoke execute on function chat_save_turn(uuid, text, text, text, boolean) from public, anon, authenticated;
