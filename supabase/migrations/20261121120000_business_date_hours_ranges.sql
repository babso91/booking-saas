-- Several opening ranges for one civil date (Higani point 219; a tester's
-- report of 21/11: "10h–12h" on a Tuesday removed her usual 18h–20h).
--
-- The date still REPLACES that day's usual openings, as before: rows already
-- saved keep their meaning (a professional who shortened a day is not made
-- bookable again). The editor starts from the usual ranges of that weekday,
-- so adding 10h–12h keeps 18h–20h, and a usual range can be removed.
-- Closing a whole day stays the job of closures (availability_exceptions).
-- private.opening_ranges already takes the union of every row of the date:
-- it is unchanged.

alter table public.business_date_hours
  drop constraint business_date_hours_pkey;
alter table public.business_date_hours
  add primary key (business_id, date, starts_at);

-- `date + time` is immutable; 24:00 maps to the following midnight.
alter table public.business_date_hours
  add constraint business_date_hours_no_overlap exclude using gist (
    business_id with =,
    "date" with =,
    tsrange("date" + starts_at, "date" + ends_at, '[)') with &&
  );

-- Replaces every range of one date at once, if they are still the ones the
-- editor read (`p_expected`, null when the date had none), under the shared
-- schedule lock: `stale_business_hours` otherwise, nothing written. Null
-- `p_ranges` restores the usual hours. Saving what the date already has
-- answers it, whatever `p_expected` (a retry whose answer was lost).
-- Ranges are objects {"starts_at": "HH:MM", "ends_at": "HH:MM"}.
create function public.set_business_date_ranges(
  p_business_id uuid,
  p_date date,
  p_ranges jsonb,
  p_expected jsonb
)
returns setof public.business_date_hours
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_date is null or p_date not between date '0001-01-01' and date '9999-12-31' then
    raise exception using errcode = '22023', message = 'invalid_hours', hint = 'date';
  end if;
  if p_ranges is not null and (
    pg_catalog.jsonb_typeof(p_ranges) <> 'array'
    or pg_catalog.jsonb_array_length(p_ranges) not between 1 and 12
  ) then
    raise exception using errcode = '22023', message = 'invalid_hours', hint = 'ranges';
  end if;
  if p_expected is not null and pg_catalog.jsonb_typeof(p_expected) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_hours', hint = 'expected';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(coalesce(p_ranges, '[]'))
      as r(starts_at time, ends_at time)
    where r.starts_at is null or r.ends_at is null
       or r.starts_at >= r.ends_at
       or extract(second from r.starts_at) <> 0
       or extract(second from r.ends_at) <> 0
  ) then
    raise exception using errcode = '22023', message = 'invalid_hours', hint = 'endsAt';
  end if;
  if exists (
    select 1
    from (
      select r.starts_at,
             pg_catalog.lag(r.ends_at) over (order by r.starts_at, r.ends_at) as previous_end
      from pg_catalog.jsonb_to_recordset(coalesce(p_ranges, '[]'))
        as r(starts_at time, ends_at time)
    ) ordered
    where ordered.starts_at < ordered.previous_end
  ) then
    raise exception using errcode = '22023', message = 'invalid_hours', hint = 'overlap';
  end if;

  -- Before any read or write of the schedule.
  perform private.lock_business_schedule(p_business_id);

  if exists (
    (
      select h.starts_at, h.ends_at
      from public.business_date_hours h
      where h.business_id = p_business_id and h.date = p_date
      except all
      select r.starts_at, r.ends_at
      from pg_catalog.jsonb_to_recordset(coalesce(p_ranges, '[]'))
        as r(starts_at time, ends_at time)
    )
    union all
    (
      select r.starts_at, r.ends_at
      from pg_catalog.jsonb_to_recordset(coalesce(p_ranges, '[]'))
        as r(starts_at time, ends_at time)
      except all
      select h.starts_at, h.ends_at
      from public.business_date_hours h
      where h.business_id = p_business_id and h.date = p_date
    )
  ) then
    if exists (
      (
        select h.starts_at, h.ends_at
        from public.business_date_hours h
        where h.business_id = p_business_id and h.date = p_date
        except all
        select e.starts_at, e.ends_at
        from pg_catalog.jsonb_to_recordset(coalesce(p_expected, '[]'))
          as e(starts_at time, ends_at time)
      )
      union all
      (
        select e.starts_at, e.ends_at
        from pg_catalog.jsonb_to_recordset(coalesce(p_expected, '[]'))
          as e(starts_at time, ends_at time)
        except all
        select h.starts_at, h.ends_at
        from public.business_date_hours h
        where h.business_id = p_business_id and h.date = p_date
      )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'stale_business_hours',
        hint = 'expected';
    end if;

    delete from public.business_date_hours
    where business_id = p_business_id and date = p_date;

    insert into public.business_date_hours (business_id, date, starts_at, ends_at)
    select p_business_id, p_date, r.starts_at, r.ends_at
    from pg_catalog.jsonb_to_recordset(coalesce(p_ranges, '[]'))
      as r(starts_at time, ends_at time);
  end if;

  return query
  select h.*
  from public.business_date_hours h
  where h.business_id = p_business_id and h.date = p_date
  order by h.starts_at;
end;
$$;

revoke all on function public.set_business_date_ranges(uuid, date, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.set_business_date_ranges(uuid, date, jsonb, jsonb)
  to authenticated;

-- The single-range call of the previous version (an app still deployed
-- while this migration runs): one range replaces every range of the date,
-- and its expected range must be the date's only one. Its upsert on
-- (business_id, date) no longer has a matching key.
create or replace function public.set_business_date_hours(
  p_business_id uuid,
  p_date date,
  p_starts_at time default null,
  p_ends_at time default null,
  p_expected_starts_at time default null,
  p_expected_ends_at time default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.set_business_date_ranges(
    p_business_id,
    p_date,
    case when p_starts_at is null and p_ends_at is null then null
      else pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'starts_at', p_starts_at, 'ends_at', p_ends_at))
    end,
    case when p_expected_starts_at is null and p_expected_ends_at is null then null
      else pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'starts_at', p_expected_starts_at, 'ends_at', p_expected_ends_at))
    end
  );
end;
$$;
