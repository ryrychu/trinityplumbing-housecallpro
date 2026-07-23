create table customers (
  id text primary key,                 -- Housecall Pro customer id
  first_name text,
  last_name text,
  company text,
  email text,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  lat double precision,
  lng double precision,
  raw jsonb not null,                   -- full HCP payload, for fields we haven't modeled yet
  updated_at timestamptz not null default now()
);

create table technicians (
  id text primary key,                  -- Housecall Pro employee id
  first_name text,
  last_name text,
  color_hex text,
  raw jsonb not null,
  updated_at timestamptz not null default now()
);

create table jobs (
  id text primary key,                  -- Housecall Pro job id
  customer_id text references customers(id),
  technician_id text references technicians(id),
  work_status text,                     -- e.g. scheduled, in_progress, completed, canceled
  is_emergency boolean not null default false,
  is_commercial boolean not null default false,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  total_amount_cents integer,
  service_address_lat double precision,
  service_address_lng double precision,
  raw jsonb not null,
  updated_at timestamptz not null default now()
);

create table estimates (
  id text primary key,
  job_id text references jobs(id),
  customer_id text references customers(id),
  status text,                          -- e.g. open, approved, declined
  amount_cents integer,
  raw jsonb not null,
  updated_at timestamptz not null default now()
);

create table invoices (
  id text primary key,
  job_id text references jobs(id),
  customer_id text references customers(id),
  status text,                          -- e.g. pending, paid, overdue
  amount_cents integer,
  due_date date,
  raw jsonb not null,
  updated_at timestamptz not null default now()
);

create table tags (
  id text primary key,
  name text not null
);

create table job_tags (
  job_id text references jobs(id),
  tag_id text references tags(id),
  primary key (job_id, tag_id)
);

create table notes (
  id text primary key,
  job_id text references jobs(id),
  body text,
  raw jsonb not null,
  created_at timestamptz not null default now()
);

create table attachments (
  id text primary key,
  job_id text references jobs(id),
  url text,
  content_type text,
  raw jsonb not null,
  created_at timestamptz not null default now()
);

-- Tracks the last successful poll per resource, so the backfill job knows where to resume.
create table sync_cursors (
  resource text primary key,            -- 'customers' | 'jobs' | 'estimates' | 'invoices' | 'technicians'
  last_synced_at timestamptz not null default now()
);

create index jobs_scheduled_start_idx on jobs (scheduled_start);
create index jobs_work_status_idx on jobs (work_status);
create index invoices_status_idx on invoices (status);
create index estimates_status_idx on estimates (status);
