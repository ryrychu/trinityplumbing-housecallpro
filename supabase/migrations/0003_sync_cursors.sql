-- supabase/migrations/0003_sync_cursors.sql
--
-- Cursor bookmarks for incremental polling. HCP list endpoints do NOT support a
-- modified-since filter (item 4 probe: updated_after/updated_since/etc. are all
-- ignored), but they DO honor sort_by=updated_at&sort_direction=desc. So the
-- cron sorts newest-first and stops paging as soon as it reaches a record at or
-- before `last_updated_at`, instead of resyncing all ~3k jobs / ~2.9k invoices
-- every 15 minutes. A null (or missing) cursor triggers a full backfill.
create table sync_cursors (
  resource text primary key,          -- 'customers' | 'jobs' | 'estimates' | 'invoices'
  last_updated_at timestamptz,        -- max updated_at synced so far; null = never synced
  synced_at timestamptz not null default now()
);
