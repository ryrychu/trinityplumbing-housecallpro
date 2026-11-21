-- supabase/migrations/0008_task_checklists.sql
--
-- Dave's daily Fieldy checklist in Slack. One row per Eastern day in
-- task_checklists, one row per task on it in task_checklist_items. Fieldy is
-- the source of truth for the tasks and whether they're done; these tables
-- hold the day's grouping and which Slack message shows it. Only task titles
-- and ids are stored, never recordings or summaries.
--
-- version goes up on every change; rendered_version is the version last shown
-- in Slack. behind (rendered_version < version) is what the 15-minute sync
-- uses to re-render a message whose last Slack update failed.
create table task_checklists (
  id                 bigint generated always as identity primary key,
  day                date not null unique,               -- Eastern calendar day
  channel_id         text not null,
  message_ts         text,                                -- null until posted
  built_by           text not null check (built_by in ('morning_ai', 'morning_rules', 'chatgpt')),
  version            int not null default 1,
  rendered_version   int not null default 0,
  behind             boolean generated always as (rendered_version < version) stored,
  overflow           int not null default 0,              -- open tasks past the 40-item cap
  finished_yesterday int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table task_checklist_items (
  id             bigint generated always as identity primary key,
  checklist_id   bigint not null references task_checklists (id) on delete cascade,
  position       int not null,
  group_name     text not null check (char_length(group_name) between 1 and 60),
  text           text not null check (char_length(text) between 1 and 75),
  fieldy_task_id text not null,
  done_at        timestamptz,
  done_via       text check (done_via in ('chatgpt', 'slack', 'fieldy')),
  unique (checklist_id, fieldy_task_id)
);

create index task_checklist_items_checklist_idx on task_checklist_items (checklist_id, position);
create index task_checklists_behind_idx on task_checklists (day) where behind;

-- Only the server touches these, through the service-role key (which bypasses
-- RLS). RLS with no policies keeps the browser's anon key out.
alter table task_checklists enable row level security;
alter table task_checklist_items enable row level security;

-- Bump the version; returns the new one.
create function task_checklist_touch(p_id bigint) returns int
language sql as $$
  update task_checklists set version = version + 1, updated_at = now()
  where id = p_id
  returning version;
$$;

-- Record what Slack is showing. greatest() so a slow, older render finishing
-- last can't make a newer one look unrendered.
create function task_checklist_rendered(p_id bigint, p_version int) returns void
language sql as $$
  update task_checklists set rendered_version = greatest(rendered_version, p_version)
  where id = p_id;
$$;

-- Swap a checklist's items in one transaction, so a render running at the
-- same moment never sees an empty list.
create function task_checklist_replace_items(p_id bigint, p_items jsonb) returns void
language plpgsql as $$
begin
  delete from task_checklist_items where checklist_id = p_id;
  insert into task_checklist_items (checklist_id, position, group_name, text, fieldy_task_id, done_at, done_via)
  select p_id,
         (i ->> 'position')::int,
         i ->> 'group_name',
         i ->> 'text',
         i ->> 'fieldy_task_id',
         (i ->> 'done_at')::timestamptz,
         i ->> 'done_via'
  from jsonb_array_elements(p_items) as i;
end;
$$;

-- Add one item at the end. A task already on the checklist is left alone.
create function task_checklist_append_item(p_id bigint, p_group text, p_text text, p_task_id text) returns void
language sql as $$
  insert into task_checklist_items (checklist_id, position, group_name, text, fieldy_task_id)
  select p_id, coalesce(max(position), 0) + 1, p_group, p_text, p_task_id
  from task_checklist_items
  where checklist_id = p_id
  on conflict (checklist_id, fieldy_task_id) do nothing;
$$;

revoke execute on function task_checklist_touch(bigint) from public, anon, authenticated;
revoke execute on function task_checklist_rendered(bigint, int) from public, anon, authenticated;
revoke execute on function task_checklist_replace_items(bigint, jsonb) from public, anon, authenticated;
revoke execute on function task_checklist_append_item(bigint, text, text, text) from public, anon, authenticated;
