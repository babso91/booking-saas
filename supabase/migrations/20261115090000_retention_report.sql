-- R4-01, measures: how many new clients come back (professionals only).
--
-- One read-only function, no table, no stored aggregate, no write:
--
--   crm_retention_report  the cohorts of the last 12 months: clients whose
--                         FIRST completed visit falls in a month (business
--                         time), how many came back within the window, and
--                         whether every client's window has ended.
--
-- Security: SECURITY INVOKER, like the CRM read model, so row level security
-- on appointments and businesses stays the authority; the function also
-- refuses a caller who is not a member of p_business_id (crm_assert_member:
-- `unauthenticated` / `forbidden`) and filters every row by p_business_id.
-- Executable by authenticated only (never anon). STABLE: it cannot write.
--
-- Definition (definitionVersion "retention-v1", docs/RETENTION_REPORT_PROPOSAL.md):
--   visit       an appointment whose status is `completed` (as in the CRM
--               read model: no_show, cancelled and past confirmed are never
--               visits), started at or before the reference instant. Its
--               time is its start (the visit time), read in business time.
--   first visit a client's earliest visit (start, then id).
--   comes back  a later visit on a LATER business day than the first, whose
--               business date is at most the first's + p_window_days. Two
--               appointments on the same day are one visit, not a return.
--   observed    a cohort is fully observed once the window of its last
--               possible first visit (the month's last day) has ended at the
--               reference instant: only then can its rate be read.
-- Computed from the current state of the agenda: a visit marked completed
-- then set back to confirmed simply stops counting; nothing is duplicated.
--
-- Time: one reference instant per call (p_as_of, by default now()).

create function public.crm_retention_report(
  p_business_id uuid,
  p_window_days integer,
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_timezone text;
  v_as_of_local timestamp;
  v_first_month date;
  v_cohorts jsonb;
begin
  perform public.crm_assert_member(p_business_id);
  if p_window_days is null or p_window_days not in (30, 60, 90) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'windowDays';
  end if;
  if p_as_of is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'asOf';
  end if;

  select b.timezone into v_timezone
  from public.businesses b
  where b.id = p_business_id;
  if v_timezone is null then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  v_as_of_local := p_as_of at time zone v_timezone;
  -- The current month and the 11 before it.
  v_first_month := (pg_catalog.date_trunc('month', v_as_of_local) - interval '11 months')::date;

  with visits as (
    select
      a.client_id,
      a.id,
      a.starts_at,
      (a.starts_at at time zone v_timezone)::date as local_day
    from public.appointments a
    where a.business_id = p_business_id
      and a.status = 'completed'
      and a.starts_at <= p_as_of
  ),
  firsts as (
    select distinct on (v.client_id)
      v.client_id,
      v.local_day as first_day
    from visits v
    order by v.client_id, v.starts_at, v.id
  ),
  cohort_clients as (
    select
      f.client_id,
      pg_catalog.date_trunc('month', f.first_day)::date as month,
      exists (
        select 1
        from visits r
        where r.client_id = f.client_id
          and r.local_day > f.first_day
          and r.local_day <= f.first_day + p_window_days
      ) as came_back
    from firsts f
    where f.first_day >= v_first_month
  ),
  cohorts as (
    select
      c.month,
      count(*)::integer as size,
      (count(*) filter (where c.came_back))::integer as returned
    from cohort_clients c
    group by c.month
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'month', pg_catalog.to_char(c.month, 'YYYY-MM'),
        'size', c.size,
        'returned', c.returned,
        -- Last possible first visit: the month's last day; its window ends
        -- at the end of that day + p_window_days, business time.
        'fullyObserved',
          ((c.month + interval '1 month')::date + p_window_days)::timestamp
            <= v_as_of_local
      )
      order by c.month
    ),
    '[]'::jsonb
  )
  into v_cohorts
  from cohorts c;

  return pg_catalog.jsonb_build_object(
    'definitionVersion', 'retention-v1',
    'windowDays', p_window_days,
    'asOf', p_as_of,
    'timeZone', v_timezone,
    'minCohortSize', 10,
    'cohorts', v_cohorts
  );
end;
$$;

comment on function public.crm_retention_report(uuid, integer, timestamptz) is
  'Retention cohorts of the last 12 months (retention-v1): first completed visit month, returns within 30/60/90 days, fully observed flag. Read-only, members only.';

revoke all on function public.crm_retention_report(uuid, integer, timestamptz) from public, anon;
grant execute on function public.crm_retention_report(uuid, integer, timestamptz) to authenticated;
