-- Phase 1 completion: Leads + Attachments sync, first-class Tags/Notes.
-- No inter-table foreign keys (see 0004): HCP delivers records out of order.

create table leads (
  id          text primary key,          -- Housecall Pro lead id
  customer_id text,                       -- soft reference, no FK
  status      text,
  source      text,                       -- lead_source
  created_at  timestamptz,
  raw         jsonb not null,
  updated_at  timestamptz not null default now()
);

create table attachments (
  id           text primary key,          -- Housecall Pro attachment id
  parent_type  text not null,             -- 'customer' | 'job'
  parent_id    text not null,             -- soft reference
  file_name    text,
  content_type text,
  hcp_url      text,                       -- original HCP-hosted URL
  storage_path text,                       -- Supabase Storage path once re-hosted; null if not copied
  created_at   timestamptz,
  raw          jsonb not null,
  updated_at   timestamptz not null default now()
);

create index attachments_parent_idx on attachments (parent_type, parent_id);

alter table jobs      add column tags  text[] not null default '{}';
alter table jobs      add column notes text;
alter table customers add column tags  text[] not null default '{}';
alter table customers add column notes text;
