-- Scheduling invariants required by availability computation and booking.
--
-- Corrections to the initial foundation:
--
-- * `businesses.timezone` accepted any text. An invalid zone would only fail
--   later, inside availability computation. It is now validated against the
--   IANA database known to PostgreSQL.
-- * A business could exist without `business_settings`, leaving booking rules
--   undefined. Settings are now created with the business.
-- * Weekly ranges of the same day could overlap.
-- * The exclusion constraint ignored the buffer between appointments and only
--   covered `confirmed` rows: two appointments could be glued together despite
--   a configured buffer, and marking an appointment `completed` or `no_show`
--   released its time slot. Only a cancellation releases a slot now.

-- ---------------------------------------------------------------------------
-- Business timezone
-- ---------------------------------------------------------------------------

create function private.assert_valid_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = new.timezone
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_timezone',
      detail = format('Unknown IANA time zone: %s', new.timezone);
  end if;

  return new;
end;
$$;

create trigger businesses_assert_valid_timezone
  before insert or update of timezone on public.businesses
  for each row execute function private.assert_valid_timezone();

comment on column public.businesses.timezone is
  'IANA time zone used to interpret business_hours and calendar dates.';

-- ---------------------------------------------------------------------------
-- Default booking settings
-- ---------------------------------------------------------------------------

create function private.create_default_business_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.business_settings (business_id)
  values (new.id)
  on conflict (business_id) do nothing;

  return new;
end;
$$;

create trigger businesses_create_default_settings
  after insert on public.businesses
  for each row execute function private.create_default_business_settings();

insert into public.business_settings (business_id)
select id from public.businesses
on conflict (business_id) do nothing;

-- ---------------------------------------------------------------------------
-- Weekly opening ranges
-- ---------------------------------------------------------------------------

comment on column public.business_hours.weekday is
  '0 = Sunday … 6 = Saturday, matching PostgreSQL extract(dow).';
comment on column public.business_hours.ends_at is
  'Exclusive local end time; 24:00 closes the range at midnight.';

-- `date + time` is immutable, so a fixed reference day turns local times into
-- comparable ranges. 24:00 maps to the following midnight.
alter table public.business_hours
  add constraint business_hours_no_overlap exclude using gist (
    business_id with =,
    weekday with =,
    tsrange(date '2000-01-03' + starts_at, date '2000-01-03' + ends_at, '[)') with &&
  );

-- ---------------------------------------------------------------------------
-- Appointment occupancy (duration + buffer)
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column buffer_minutes_snapshot integer not null default 0
    check (buffer_minutes_snapshot between 0 and 240),
  add column occupied_window tstzrange;

-- `timestamptz + interval` is only STABLE, so the occupied window cannot be a
-- generated column. A trigger derives it from trusted columns and overwrites
-- any value supplied by the caller.
create function private.set_appointment_occupied_window()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.occupied_window := pg_catalog.tstzrange(
    new.starts_at,
    new.ends_at + pg_catalog.make_interval(mins => new.buffer_minutes_snapshot),
    '[)'
  );

  return new;
end;
$$;

create trigger appointments_set_occupied_window
  before insert or update on public.appointments
  for each row execute function private.set_appointment_occupied_window();

update public.appointments set buffer_minutes_snapshot = buffer_minutes_snapshot;

alter table public.appointments
  alter column occupied_window set not null,
  add constraint appointments_occupied_window_consistent check (
    lower(occupied_window) = starts_at
    and upper(occupied_window) >= ends_at
    and lower_inc(occupied_window)
    and not upper_inc(occupied_window)
  );

alter table public.appointments
  drop constraint appointments_no_overlapping_confirmed;

alter table public.appointments
  add constraint appointments_no_overlap exclude using gist (
    business_id with =,
    occupied_window with &&
  ) where (status <> 'cancelled');

comment on column public.appointments.buffer_minutes_snapshot is
  'Buffer after the appointment, frozen from business_settings at booking time.';
comment on column public.appointments.occupied_window is
  'Derived by trigger: [starts_at, ends_at + buffer). Guarded by appointments_no_overlap.';
comment on constraint appointments_no_overlap on public.appointments is
  'Final guarantee against double booking: two non-cancelled appointments of one '
  'business can never share any instant of their occupied windows, buffer included.';

revoke all on function private.assert_valid_timezone() from public;
revoke all on function private.create_default_business_settings() from public;
revoke all on function private.set_appointment_occupied_window() from public;
