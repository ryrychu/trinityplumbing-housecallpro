-- supabase/migrations/0009_pricebook_changes.sql
--
-- The Trinity Price Book Editor's change log and short-lived previews.
-- Materials are changed in HCP directly (status applied / failed / undone);
-- services can't be written through HCP's API, so their changes are requests
-- (pending / done / dismissed) posted to Slack and applied by hand.
-- before/after hold only the fields that changed, money in integer cents.
create table pricebook_changes (
  id               bigint generated always as identity primary key,
  batch_id         uuid not null,
  kind             text not null check (kind in ('material_update', 'material_create', 'service_request', 'undo')),
  item_uuid        text not null,
  item_name        text not null,
  item_kind        text not null check (item_kind in ('material', 'service')),
  category_uuid    text,
  before           jsonb,
  after            jsonb not null,
  status           text not null check (status in ('applied', 'failed', 'undone', 'pending', 'done', 'dismissed')),
  requested_by     text not null,          -- Supabase user id of the editor
  resolved_by      text,                   -- Supabase or Slack user id
  error_code       text,
  slack_channel_id text,
  slack_message_ts text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

create index pricebook_changes_batch_idx on pricebook_changes (batch_id);
create index pricebook_changes_created_idx on pricebook_changes (created_at desc);
create index pricebook_changes_pending_idx on pricebook_changes (item_uuid) where status = 'pending';

create table pricebook_previews (
  id                 uuid primary key,
  created_by_user_id text not null,
  payload            jsonb not null,
  expires_at         timestamptz not null,
  applied_at         timestamptz,
  created_at         timestamptz not null default now()
);

-- Server-only, through the service-role key. RLS with no policies keeps the anon key out.
alter table pricebook_changes enable row level security;
alter table pricebook_previews enable row level security;
