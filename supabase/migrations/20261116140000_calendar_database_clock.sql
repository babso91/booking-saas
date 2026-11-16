-- The outbound worker's pass start, from the database's clock
-- (docs/CALENDAR_OUTBOUND_CONTRACT.md). A pass claims only what was due by
-- its start (calendar_outbound_claim_mirrors, p_due_before), and due times
-- are written by the database (next_attempt_at). Taking the start from the
-- application server's clock made work just made due (a backfill) wait for
-- the next run whenever the database's clock was a few milliseconds ahead
-- (a hosted database, a virtual machine): one clock decides.

create function public.calendar_outbound_now()
returns timestamptz
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_catalog.clock_timestamp();
$$;

revoke all on function public.calendar_outbound_now() from public, anon, authenticated;
grant execute on function public.calendar_outbound_now() to service_role;
