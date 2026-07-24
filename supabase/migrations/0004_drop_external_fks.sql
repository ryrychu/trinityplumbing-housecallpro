-- Phase 1.x (go-live Step 2 finding): drop hard foreign keys between mirrored
-- tables.
--
-- These tables mirror an external source of truth (Housecall Pro). HCP's list
-- endpoints do NOT guarantee referential completeness: a job can reference a
-- deactivated employee the /employees list no longer returns, or an archived
-- customer, and estimates/invoices can reference jobs outside the synced window.
-- With hard FKs, one dangling reference aborts the whole page upsert and the
-- entire sync run (observed: jobs page 1 failed on jobs_technician_id_fkey for a
-- job assigned to a 7th, deactivated technician while /employees returns 6).
--
-- The reference columns stay (id values are still recorded), and `raw` retains
-- the full payload. The dashboard reads each table independently (no PostgREST
-- embedded joins), so nothing depends on enforced integrity. Indexes are added
-- so joins on these columns stay fast without the FK.

alter table jobs      drop constraint if exists jobs_customer_id_fkey;
alter table jobs      drop constraint if exists jobs_technician_id_fkey;
alter table estimates drop constraint if exists estimates_job_id_fkey;
alter table estimates drop constraint if exists estimates_customer_id_fkey;
alter table invoices  drop constraint if exists invoices_job_id_fkey;
alter table invoices  drop constraint if exists invoices_customer_id_fkey;

create index if not exists jobs_customer_id_idx       on jobs (customer_id);
create index if not exists jobs_technician_id_idx     on jobs (technician_id);
create index if not exists estimates_job_id_idx       on estimates (job_id);
create index if not exists estimates_customer_id_idx  on estimates (customer_id);
create index if not exists invoices_job_id_idx        on invoices (job_id);
create index if not exists invoices_customer_id_idx   on invoices (customer_id);
