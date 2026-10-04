-- Reproducible plan of the external busy-period lookup used by availability
-- (private.external_busy) and by manual conflicts.
--
--   docker exec -i supabase_db_booking-saas psql -U postgres -v events=2000 \
--     < scripts/perf/calendar-busy-explain.sql
--   (then -v events=10000)
--
-- Everything runs in one transaction that is rolled back: the local database
-- is left untouched. Foreign keys are not checked while seeding
-- (session_replication_role = replica): only the shape of the data matters.
-- Data: one business with :events busy periods spread over the 400-day sync
-- window, plus 20 other businesses with 2,500 periods each (noise the index
-- must skip).

\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica;

create temp table perf_ids on commit drop as
select gen_random_uuid() as business_id, gen_random_uuid() as connection_id,
       gen_random_uuid() as calendar_id, n as tenant
from pg_catalog.generate_series(0, 20) n;

insert into public.businesses (id, name, slug, contact_email, timezone, created_by)
select business_id, 'Perf ' || tenant, 'perf-' || tenant || '-' || pg_catalog.left(business_id::text, 8),
       'perf@example.test', 'Europe/Paris', gen_random_uuid()
from perf_ids;

insert into public.calendar_connections (id, business_id, provider, provider_account_id, account_email)
select connection_id, business_id, 'google', 'sub-' || business_id, 'perf@example.test'
from perf_ids;

insert into public.external_calendars
  (id, business_id, connection_id, provider_calendar_id, name, timezone, selected_for_blocking)
select calendar_id, business_id, connection_id, 'cal', 'Travail', 'Europe/Paris', true
from perf_ids;

-- Target business (tenant 0): :events periods of 1 h, 10 % transparent.
insert into public.external_calendar_events
  (business_id, external_calendar_id, provider_event_id, starts_at, ends_at, all_day, busy, sync_generation)
select p.business_id, p.calendar_id, 'e' || i,
       pg_catalog.date_trunc('hour', pg_catalog.now()) - interval '1 day'
         + (i * (interval '401 days' / :events)),
       pg_catalog.date_trunc('hour', pg_catalog.now()) - interval '1 day'
         + (i * (interval '401 days' / :events)) + interval '1 hour',
       false, i % 10 <> 0, 1
from perf_ids p, pg_catalog.generate_series(1, :events) i
where p.tenant = 0;

-- Noise: 20 × 2,500 periods in other businesses.
insert into public.external_calendar_events
  (business_id, external_calendar_id, provider_event_id, starts_at, ends_at, all_day, busy, sync_generation)
select p.business_id, p.calendar_id, 'e' || i,
       pg_catalog.date_trunc('hour', pg_catalog.now()) + (i * interval '4 hours'),
       pg_catalog.date_trunc('hour', pg_catalog.now()) + (i * interval '4 hours') + interval '1 hour',
       false, true, 1
from perf_ids p, pg_catalog.generate_series(1, 2500) i
where p.tenant > 0;

analyze public.external_calendar_events;

select pg_catalog.count(*) filter (where e.business_id = p.business_id) as target_events,
       pg_catalog.count(*) as all_events
from public.external_calendar_events e, perf_ids p
where p.tenant = 0;

\echo '--- One day (slot listing of a date) ---'
select business_id as target from perf_ids where tenant = 0 \gset
explain (analyze, buffers, costs off, timing off, summary on)
select coalesce(pg_catalog.range_agg(e.busy_window), '{}'::pg_catalog.tstzmultirange)
from public.external_calendar_events e
where e.business_id = :'target'
  and e.busy
  and e.busy_window && pg_catalog.tstzrange(
    pg_catalog.date_trunc('day', pg_catalog.now()) + interval '30 days',
    pg_catalog.date_trunc('day', pg_catalog.now()) + interval '31 days', '[)');

\echo '--- Through private.external_busy (as availability calls it), 30 days ---'
explain (analyze, buffers, costs off, timing off, summary on)
select private.external_busy(
  :'target',
  pg_catalog.date_trunc('day', pg_catalog.now()),
  pg_catalog.date_trunc('day', pg_catalog.now()) + interval '30 days');

\echo '--- Whole sync window (worst case: every period of the business) ---'
explain (analyze, buffers, costs off, timing off, summary on)
select coalesce(pg_catalog.range_agg(e.busy_window), '{}'::pg_catalog.tstzmultirange)
from public.external_calendar_events e
where e.business_id = :'target'
  and e.busy
  and e.busy_window && pg_catalog.tstzrange(
    pg_catalog.now() - interval '1 day', pg_catalog.now() + interval '400 days', '[)');

rollback;
