-- supabase/migrations/0002_geocode_cache.sql
--
-- Geocoding cache for the Geographic Scheduling Assistant. HCP address objects
-- carry no latitude/longitude (Task 0), so the sync path geocodes
-- street/city/state/zip -> lat/lng via the free US Census geocoder and caches
-- the result here, keyed by a normalized address string, so the same address is
-- never geocoded twice. `status` records definitive 'not_found' results too, so
-- unresolvable addresses are not retried every run. Transient failures (network,
-- timeout, 5xx) are NOT cached — they are retried on the next sync.
create table geocode_cache (
  address_key text primary key,        -- normalized "street, city, state, zip" (lowercased)
  lat double precision,                -- null when status = 'not_found'
  lng double precision,                -- null when status = 'not_found'
  status text not null,                -- 'found' | 'not_found'
  geocoded_at timestamptz not null default now()
);
