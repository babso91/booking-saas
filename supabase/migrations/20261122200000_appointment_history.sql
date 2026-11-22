-- Point 100 (Higani backlog): who changed an appointment, and what.
--
-- Every write of an appointment that changes what the professional sees
-- (time, length, service, options, price, client, practitioner, status,
-- internal note) appends one entry, in the writer's own transaction, by a
-- trigger: no write path can forget it. An entry keeps the actor and the
-- changed fields, never the note's text nor the client's contact details
-- (only her id, read back at display time, so an erasure leaves nothing
-- behind here).
--
-- The actor:
-- - a signed-in user (auth.uid()): a member of the business, shown by her
--   name of today, or by the one kept then once she has left the team;
-- - otherwise the service role: the client herself, since only her flows
--   write appointments through it (public booking, client hub, waitlist);
--   tests/integration/appointment-history.test.ts pins the list of the
--   functions writing appointments so that a new one is labelled on purpose;
-- - otherwise (a database session, a script): the system.

create table private.appointment_changes (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  appointment_id uuid not null,
  version integer not null,
  changed_at timestamptz not null default pg_catalog.now(),
  actor_kind text not null check (actor_kind in ('member', 'client', 'system')),
  actor_user_id uuid,
  actor_name text check (actor_name is null or char_length(actor_name) <= 160),
  changes jsonb not null check (
    pg_catalog.jsonb_typeof(changes) = 'array'
    and pg_catalog.jsonb_array_length(changes) between 1 and 20
  ),
  -- Written by this migration for appointments that existed before it.
  backfilled boolean not null default false,
  foreign key (appointment_id, business_id)
    references public.appointments (id, business_id) on delete cascade,
  check ((actor_kind = 'member') = (actor_user_id is not null))
);

create index appointment_changes_appointment_idx
  on private.appointment_changes (appointment_id, id);

revoke all on table private.appointment_changes from public, anon, authenticated;

-- The name of a member as the business knows her: her practitioner name,
-- otherwise her profile.
create function private.history_actor_name(p_business_id uuid, p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select nullif(pg_catalog.btrim(s.display_name), '')
      from public.staff_members s
      where s.business_id = p_business_id and s.user_id = p_user_id
      order by s.created_at
      limit 1
    ),
    (
      select nullif(pg_catalog.btrim(pg_catalog.concat_ws(' ', p.first_name, p.last_name)), '')
      from public.profiles p
      where p.id = p_user_id
    )
  );
$$;

create function private.record_appointment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := '[]';
  v_user uuid := (select auth.uid());
  v_kind text;
begin
  if tg_op = 'INSERT' then
    v_changes := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'type', 'created',
      'startsAt', new.starts_at,
      'endsAt', new.ends_at,
      'serviceName', new.service_name_snapshot,
      'status', new.status,
      'inSeries', new.series_id is not null
    ));
  else
    if new.starts_at is distinct from old.starts_at then
      v_changes := v_changes || pg_catalog.jsonb_build_object(
        'type', 'moved',
        'from', pg_catalog.jsonb_build_object('startsAt', old.starts_at, 'endsAt', old.ends_at),
        'to', pg_catalog.jsonb_build_object('startsAt', new.starts_at, 'endsAt', new.ends_at)
      );
    elsif new.ends_at is distinct from old.ends_at then
      v_changes := v_changes || pg_catalog.jsonb_build_object(
        'type', 'duration',
        'fromMinutes', (extract(epoch from old.ends_at - old.starts_at) / 60)::integer,
        'toMinutes', (extract(epoch from new.ends_at - new.starts_at) / 60)::integer
      );
    end if;
    if new.service_id is distinct from old.service_id
      or new.service_name_snapshot is distinct from old.service_name_snapshot then
      v_changes := v_changes || pg_catalog.jsonb_build_object(
        'type', 'service',
        'from', old.service_name_snapshot,
        'to', new.service_name_snapshot
      );
    end if;
    if new.options_snapshot is distinct from old.options_snapshot then
      v_changes := v_changes || pg_catalog.jsonb_build_object('type', 'options');
    end if;
    if new.price_cents_snapshot is distinct from old.price_cents_snapshot
      or new.currency is distinct from old.currency then
      v_changes := v_changes || pg_catalog.jsonb_build_object(
        'type', 'price',
        'fromCents', old.price_cents_snapshot,
        'toCents', new.price_cents_snapshot,
        'fromCurrency', old.currency,
        'toCurrency', new.currency
      );
    end if;
    if new.client_id is distinct from old.client_id then
      v_changes := v_changes || pg_catalog.jsonb_build_object(
        'type', 'client', 'fromId', old.client_id, 'toId', new.client_id
      );
    end if;
    if new.staff_id is distinct from old.staff_id then
      v_changes := v_changes || pg_catalog.jsonb_build_object(
        'type', 'staff', 'fromId', old.staff_id, 'toId', new.staff_id
      );
    end if;
    if new.status is distinct from old.status then
      v_changes := v_changes || pg_catalog.jsonb_build_object(
        'type', 'status', 'from', old.status, 'to', new.status
      );
    end if;
    if new.internal_notes is distinct from old.internal_notes then
      v_changes := v_changes || pg_catalog.jsonb_build_object('type', 'notes');
    end if;
    if v_changes = '[]'::jsonb then
      return null;
    end if;
  end if;

  v_kind := case
    when v_user is not null then 'member'
    when (select auth.role()) = 'service_role' then 'client'
    else 'system'
  end;

  insert into private.appointment_changes (
    business_id, appointment_id, version, actor_kind, actor_user_id,
    actor_name, changes
  ) values (
    new.business_id, new.id, new.version, v_kind, v_user,
    case when v_user is not null
      then pg_catalog.left(private.history_actor_name(new.business_id, v_user), 160)
    end,
    v_changes
  );
  return null;
end;
$$;

revoke all on function private.history_actor_name(uuid, uuid) from public, anon, authenticated;
revoke all on function private.record_appointment_change() from public, anon, authenticated;

create trigger appointments_record_change
  after insert or update on public.appointments
  for each row execute function private.record_appointment_change();

-- Appointments that existed before: their creation, with its details when
-- nothing changed since (version 1), and one entry saying that earlier
-- changes were not recorded otherwise.
insert into private.appointment_changes (
  business_id, appointment_id, version, changed_at, actor_kind,
  actor_user_id, actor_name, changes, backfilled
)
select
  a.business_id, a.id, 1, a.created_at,
  case when a.created_by is null then 'client' else 'member' end,
  a.created_by,
  case when a.created_by is not null
    then pg_catalog.left(private.history_actor_name(a.business_id, a.created_by), 160)
  end,
  case when a.version = 1
    then pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'type', 'created',
      'startsAt', a.starts_at,
      'endsAt', a.ends_at,
      'serviceName', a.service_name_snapshot,
      'status', a.status,
      'inSeries', a.series_id is not null
    ))
    else '[{"type": "created"}]'::jsonb
  end,
  true
from public.appointments a
where not exists (
  select 1 from private.appointment_changes c where c.appointment_id = a.id
);

insert into private.appointment_changes (
  business_id, appointment_id, version, changed_at, actor_kind, changes,
  backfilled
)
select a.business_id, a.id, a.version, a.updated_at, 'system',
  '[{"type": "untracked"}]'::jsonb, true
from public.appointments a
where a.version > 1
  and not exists (
    select 1 from private.appointment_changes c
    where c.appointment_id = a.id and c.version > 1
  );

-- A business wall clock, as the agenda shows it.
create function private.history_local(p_at timestamptz, p_timezone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.to_char(p_at at time zone p_timezone, 'YYYY-MM-DD"T"HH24:MI');
$$;

-- One change, ready to read: wall clocks and the names of today.
create function private.history_change_view(
  p_business_id uuid,
  p_change jsonb,
  p_timezone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type text := p_change ->> 'type';
begin
  if v_type = 'created' and p_change ? 'startsAt' then
    return p_change || pg_catalog.jsonb_build_object(
      'localStartsAt', private.history_local((p_change ->> 'startsAt')::timestamptz, p_timezone),
      'localEndsAt', private.history_local((p_change ->> 'endsAt')::timestamptz, p_timezone)
    );
  elsif v_type = 'moved' then
    return p_change || pg_catalog.jsonb_build_object(
      'from', (p_change -> 'from') || pg_catalog.jsonb_build_object(
        'localStartsAt', private.history_local((p_change #>> '{from,startsAt}')::timestamptz, p_timezone),
        'localEndsAt', private.history_local((p_change #>> '{from,endsAt}')::timestamptz, p_timezone)
      ),
      'to', (p_change -> 'to') || pg_catalog.jsonb_build_object(
        'localStartsAt', private.history_local((p_change #>> '{to,startsAt}')::timestamptz, p_timezone),
        'localEndsAt', private.history_local((p_change #>> '{to,endsAt}')::timestamptz, p_timezone)
      )
    );
  elsif v_type = 'client' then
    return p_change || pg_catalog.jsonb_build_object(
      'fromName', (
        select nullif(pg_catalog.btrim(pg_catalog.concat_ws(' ', c.first_name, c.last_name)), '')
        from public.clients c
        where c.business_id = p_business_id and c.id = (p_change ->> 'fromId')::uuid
      ),
      'toName', (
        select nullif(pg_catalog.btrim(pg_catalog.concat_ws(' ', c.first_name, c.last_name)), '')
        from public.clients c
        where c.business_id = p_business_id and c.id = (p_change ->> 'toId')::uuid
      )
    );
  elsif v_type = 'staff' then
    return p_change || pg_catalog.jsonb_build_object(
      'fromName', (
        select s.display_name from public.staff_members s
        where s.business_id = p_business_id and s.id = (p_change ->> 'fromId')::uuid
      ),
      'toName', (
        select s.display_name from public.staff_members s
        where s.business_id = p_business_id and s.id = (p_change ->> 'toId')::uuid
      )
    );
  end if;
  return p_change;
end;
$$;

revoke all on function private.history_local(timestamptz, text) from public, anon, authenticated;
revoke all on function private.history_change_view(uuid, jsonb, text) from public, anon, authenticated;

-- The history of one appointment, newest first (100 entries at most), for
-- whoever may read the appointment: an owner or admin, or the practitioner
-- it is assigned to.
create function public.appointment_history(
  p_business_id uuid,
  p_appointment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member boolean;
  v_staff uuid;
  v_timezone text;
  v_user uuid := (select auth.uid());
  v_entries jsonb;
  v_total integer;
begin
  if p_business_id is null or p_appointment_id is null then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  v_member := public.is_business_member(p_business_id);
  if not v_member and not exists (
    select 1 from public.staff_members s
    where s.business_id = p_business_id
      and s.id = any (private.my_practitioner_staff_ids())
  ) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select a.staff_id, b.timezone into v_staff, v_timezone
  from public.appointments a
  join public.businesses b on b.id = a.business_id
  where a.id = p_appointment_id and a.business_id = p_business_id;
  if not found
    or (not v_member and (v_staff is null or not v_staff = any (private.my_practitioner_staff_ids()))) then
    raise exception using errcode = 'P0002', message = 'appointment_not_found';
  end if;

  select count(*) into v_total
  from private.appointment_changes c
  where c.appointment_id = p_appointment_id and c.business_id = p_business_id;

  select coalesce(pg_catalog.jsonb_agg(entry order by entry_id desc), '[]')
  into v_entries
  from (
    select c.id as entry_id, pg_catalog.jsonb_build_object(
      'id', c.id,
      'version', c.version,
      'at', c.changed_at,
      'localAt', private.history_local(c.changed_at, v_timezone),
      'actor', pg_catalog.jsonb_build_object(
        'kind', c.actor_kind,
        'name', case when c.actor_kind = 'member'
          then coalesce(private.history_actor_name(p_business_id, c.actor_user_id), c.actor_name)
        end,
        'isYou', c.actor_user_id is not null and c.actor_user_id = v_user
      ),
      'backfilled', c.backfilled,
      'changes', (
        select pg_catalog.jsonb_agg(
          private.history_change_view(p_business_id, change.value, v_timezone)
          order by change.ordinality
        )
        from pg_catalog.jsonb_array_elements(c.changes) with ordinality as change(value, ordinality)
      )
    ) as entry
    from private.appointment_changes c
    where c.appointment_id = p_appointment_id and c.business_id = p_business_id
    order by c.id desc
    limit 100
  ) latest;

  return pg_catalog.jsonb_build_object(
    'timeZone', v_timezone,
    'entries', v_entries,
    'truncated', v_total > 100
  );
end;
$$;

revoke all on function public.appointment_history(uuid, uuid) from public, anon;
grant execute on function public.appointment_history(uuid, uuid) to authenticated;
