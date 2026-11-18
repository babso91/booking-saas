-- M2-R07: repeat an appointment (docs/APPOINTMENT_SERIES_CONTRACT.md).
--
--   preview_appointment_series  computes the occurrences of a weekly rule in
--                               the business's civil time (DST resolved by
--                               private.resolve_local), quotes once, marks each
--                               date available / conflict / ambiguous /
--                               nonexistent / outside_horizon, and keeps the
--                               preview server side (its id is previewVersion).
--   commit_appointment_series   all or nothing, under the schedule lock: the
--                               quote and every selected date are checked
--                               again, then each occurrence is created by
--                               public.agenda_create_appointment (the same
--                               snapshots, rules and exclusion constraint as a
--                               single appointment), linked to its series.
--
-- An occurrence is an ordinary appointment afterwards: cancelling or moving
-- one leaves the others as they are. At most 12 occurrences per series.

create table private.series_previews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  actor uuid not null,
  input jsonb not null,
  quote jsonb not null,
  occurrences jsonb not null,
  created_at timestamptz not null default now()
);

create index series_previews_business_idx on private.series_previews (business_id, created_at);

create table private.appointment_series (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_id uuid not null,
  service_id uuid,
  option_choice_ids uuid[] not null default '{}',
  rule jsonb not null,
  request_id uuid not null,
  actor uuid not null,
  fingerprint text not null,
  response jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (business_id, request_id),
  unique (id, business_id),
  foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade
);

revoke all on private.series_previews, private.appointment_series from public, anon, authenticated;

alter table public.appointments
  add column series_id uuid,
  add constraint appointments_series_fk foreign key (series_id, business_id)
    references private.appointment_series (id, business_id) on delete set null (series_id);

create index appointments_series_idx on public.appointments (series_id) where series_id is not null;

comment on column public.appointments.series_id is
  'The series this appointment was created in (M2-R07), if any. Each occurrence remains an ordinary appointment.';

-- The series being committed, set for the length of the creation loop only.
create function private.link_appointment_series()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.series_id is null then
    new.series_id := nullif(pg_catalog.current_setting('private.series_id', true), '')::uuid;
  end if;
  return new;
end;
$$;

revoke all on function private.link_appointment_series() from public;

create trigger appointments_link_series
  before insert on public.appointments
  for each row execute function private.link_appointment_series();

-- ---------------------------------------------------------------------------

create function private.series_max_occurrences()
returns integer language sql immutable set search_path = '' as $$ select 12 $$;

revoke all on function private.series_max_occurrences() from public;

-- What the occurrence requested at local `p_local` may start at: its exact
-- instant; both instants of a repeated hour (earliest first); for a skipped
-- hour, the same time one hour later, proposed and never applied silently.
create function private.series_candidates(p_local timestamp, p_timezone text)
returns table (status text, candidates timestamptz[])
language plpgsql
stable
set search_path = ''
as $$
declare
  v_resolved record;
  v_shifted record;
begin
  select * into v_resolved from private.resolve_local(p_local, p_timezone);
  if v_resolved.status = 'exact' then
    return query select 'exact'::text, array[v_resolved.first_at];
  elsif v_resolved.status = 'ambiguous' then
    return query select 'ambiguous'::text, array[v_resolved.first_at, v_resolved.second_at];
  else
    select * into v_shifted from private.resolve_local(p_local + interval '1 hour', p_timezone);
    return query select 'nonexistent'::text,
      case when v_shifted.first_at is null then '{}'::timestamptz[] else array[v_shifted.first_at] end;
  end if;
end;
$$;

revoke all on function private.series_candidates(timestamp, text) from public;

-- Would an appointment of this length (plus buffer) at `p_start` collide?
create function private.series_collides(
  p_business_id uuid,
  p_start timestamptz,
  p_minutes integer,
  p_buffer integer
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.appointments a
    where a.business_id = p_business_id
      and a.status <> 'cancelled'
      and a.occupied_window && pg_catalog.tstzrange(
        p_start, p_start + pg_catalog.make_interval(mins => p_minutes + p_buffer), '[)')
  );
$$;

revoke all on function private.series_collides(uuid, timestamptz, integer, integer) from public;

-- The professional horizon of a series: from now to one year ahead.
create function private.series_in_horizon(p_start timestamptz, p_now timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select p_start > p_now and p_start <= p_now + interval '366 days'
$$;

revoke all on function private.series_in_horizon(timestamptz, timestamptz) from public;

-- Quote of the series: the catalogue's current price and duration with the
-- chosen options (private.quote_options), and the business's buffer.
create function private.series_quote(
  p_business_id uuid,
  p_service_id uuid,
  p_option_choice_ids uuid[]
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_service public.services;
  v_quote record;
  v_buffer integer;
begin
  select s.* into v_service
  from public.services s
  where s.id = p_service_id and s.business_id = p_business_id and s.active;
  if not found then
    raise exception using errcode = 'P0002', message = 'service_unavailable', hint = 'serviceId';
  end if;
  select * into v_quote from private.quote_options(p_business_id, p_service_id, p_option_choice_ids);
  select st.buffer_minutes into v_buffer from public.business_settings st where st.business_id = p_business_id;
  if v_service.duration_minutes + v_quote.duration_delta_minutes > 720 then
    raise exception using errcode = '22023', message = 'duration_too_long', hint = 'optionChoiceIds';
  end if;
  return pg_catalog.jsonb_build_object(
    'serviceName', v_service.name,
    'durationMinutes', v_service.duration_minutes + v_quote.duration_delta_minutes,
    'priceCents', v_service.price_cents + v_quote.price_delta_cents,
    'bufferMinutes', coalesce(v_buffer, 0)
  );
end;
$$;

revoke all on function private.series_quote(uuid, uuid, uuid[]) from public;

-- ---------------------------------------------------------------------------

create function public.preview_appointment_series(
  p_business_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_option_choice_ids uuid[],
  p_first_local_start timestamp,
  p_repeat_every_weeks integer,
  p_count integer,
  p_until_local_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_timezone text;
  v_quote jsonb;
  v_locals timestamp[] := '{}';
  v_local timestamp;
  v_rank integer := 0;
  v_candidate record;
  v_state text;
  v_occurrences jsonb := '[]';
  v_id uuid;
  v_options uuid[] := coalesce(p_option_choice_ids, '{}');
begin
  perform private.assert_agenda_access(p_business_id);
  if p_first_local_start is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'firstLocalStart';
  end if;
  if p_repeat_every_weeks is null or p_repeat_every_weeks not between 1 and 52 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'repeatEveryWeeks';
  end if;
  if (p_count is null) = (p_until_local_date is null) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'end';
  end if;
  if p_count is not null and p_count < 1 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'end';
  end if;
  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  -- The dates, in civil time: a repetition keeps the wall clock.
  v_local := p_first_local_start;
  loop
    exit when p_count is not null and v_rank >= p_count;
    exit when p_until_local_date is not null and v_local::date > p_until_local_date;
    v_rank := v_rank + 1;
    if v_rank > private.series_max_occurrences() then
      raise exception using errcode = 'P0001', message = 'too_many_occurrences', hint = 'end';
    end if;
    v_locals := v_locals || v_local;
    v_local := v_local + pg_catalog.make_interval(days => 7 * p_repeat_every_weeks);
  end loop;
  if v_rank = 0 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'end';
  end if;

  select b.timezone into v_timezone from public.businesses b where b.id = p_business_id;
  v_quote := private.series_quote(p_business_id, p_service_id, v_options);

  for v_rank in 1 .. pg_catalog.array_length(v_locals, 1) loop
    select * into v_candidate from private.series_candidates(v_locals[v_rank], v_timezone);
    if v_candidate.status = 'nonexistent' then
      v_state := 'nonexistent';
    elsif v_candidate.status = 'ambiguous' then
      v_state := 'ambiguous';
    elsif not private.series_in_horizon(v_candidate.candidates[1], v_now) then
      v_state := 'outside_horizon';
    elsif private.series_collides(p_business_id, v_candidate.candidates[1],
          (v_quote ->> 'durationMinutes')::integer, (v_quote ->> 'bufferMinutes')::integer) then
      v_state := 'conflict';
    else
      v_state := 'available';
    end if;
    v_occurrences := v_occurrences || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'key', 'o' || v_rank,
      'requestedLocalStart', pg_catalog.to_char(v_locals[v_rank], 'YYYY-MM-DD"T"HH24:MI:SS'),
      'utcCandidates', pg_catalog.to_jsonb(v_candidate.candidates),
      'state', v_state
    ));
  end loop;

  delete from private.series_previews p
  where p.business_id = p_business_id and p.created_at < v_now - interval '1 day';

  insert into private.series_previews (business_id, actor, input, quote, occurrences)
  values (
    p_business_id, (select auth.uid()),
    pg_catalog.jsonb_build_object(
      'clientId', p_client_id, 'serviceId', p_service_id, 'optionChoiceIds', pg_catalog.to_jsonb(v_options),
      'firstLocalStart', p_first_local_start, 'repeatEveryWeeks', p_repeat_every_weeks,
      'count', p_count, 'untilLocalDate', p_until_local_date
    ),
    v_quote, v_occurrences
  )
  returning id into v_id;

  return pg_catalog.jsonb_build_object(
    'previewVersion', v_id,
    'timeZone', v_timezone,
    'quote', pg_catalog.jsonb_build_object(
      'serviceName', v_quote ->> 'serviceName',
      'durationMinutes', (v_quote ->> 'durationMinutes')::integer,
      'priceCents', (v_quote ->> 'priceCents')::integer
    ),
    'occurrences', v_occurrences
  );
end;
$$;

create function public.commit_appointment_series(
  p_business_id uuid,
  p_request_id uuid,
  p_preview_version uuid,
  p_selected jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_actor uuid := (select auth.uid());
  v_fingerprint text;
  v_existing private.appointment_series;
  v_preview private.series_previews;
  v_timezone text;
  v_quote jsonb;
  v_item jsonb;
  v_occurrence jsonb;
  v_candidate record;
  v_start timestamptz;
  v_starts timestamptz[] := '{}';
  v_keys text[] := '{}';
  v_conflicts text[] := '{}';
  v_minutes integer;
  v_buffer integer;
  v_series uuid;
  v_ids uuid[] := '{}';
  v_appointment uuid;
  v_response jsonb;
  i integer;
  j integer;
begin
  perform private.assert_agenda_access(p_business_id);
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_preview_version is null then
    raise exception using errcode = 'P0001', message = 'series_stale';
  end if;
  if pg_catalog.jsonb_typeof(p_selected) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_selected) not between 1 and private.series_max_occurrences() then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'selected';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'previewVersion', p_preview_version, 'selected', p_selected)::text);

  perform private.lock_business_schedule(p_business_id);
  perform private.assert_agenda_access(p_business_id);
  v_now := pg_catalog.clock_timestamp();

  select * into v_existing
  from private.appointment_series s
  where s.business_id = p_business_id and s.request_id = p_request_id;
  if found then
    if v_existing.actor <> v_actor or v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return v_existing.response;
  end if;

  select * into v_preview
  from private.series_previews p
  where p.id = p_preview_version and p.business_id = p_business_id and p.actor = v_actor
    and p.created_at > v_now - interval '1 hour';
  if not found then
    raise exception using errcode = 'P0001', message = 'series_stale';
  end if;

  -- The price and duration shown must still be the catalogue's.
  v_quote := private.series_quote(
    p_business_id, (v_preview.input ->> 'serviceId')::uuid,
    array(select pg_catalog.jsonb_array_elements_text(v_preview.input -> 'optionChoiceIds')::uuid));
  if v_quote is distinct from v_preview.quote then
    raise exception using errcode = 'P0001', message = 'quote_changed';
  end if;
  v_minutes := (v_quote ->> 'durationMinutes')::integer;
  v_buffer := (v_quote ->> 'bufferMinutes')::integer;
  select b.timezone into v_timezone from public.businesses b where b.id = p_business_id;

  -- Every selected date: one the preview showed, with one of its candidates.
  for v_item in select x from pg_catalog.jsonb_array_elements(p_selected) x loop
    if (v_item ->> 'key') is null or (v_item ->> 'key') = any (v_keys) then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'selected';
    end if;
    select o into v_occurrence
    from pg_catalog.jsonb_array_elements(v_preview.occurrences) o
    where o ->> 'key' = v_item ->> 'key';
    if v_occurrence is null then
      raise exception using errcode = 'P0001', message = 'series_stale';
    end if;
    begin
      v_start := (v_item ->> 'startsAt')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'selected';
    end;
    select * into v_candidate
    from private.series_candidates((v_occurrence ->> 'requestedLocalStart')::timestamp, v_timezone);
    if v_start is null or not (v_start = any (v_candidate.candidates))
       or not private.series_in_horizon(v_start, v_now) then
      raise exception using errcode = 'P0001', message = 'series_stale';
    end if;
    if private.series_collides(p_business_id, v_start, v_minutes, v_buffer) then
      v_conflicts := v_conflicts || (v_item ->> 'key');
    end if;
    v_keys := v_keys || (v_item ->> 'key');
    v_starts := v_starts || v_start;
  end loop;

  -- Two selected dates that would collide with each other.
  for i in 1 .. pg_catalog.array_length(v_starts, 1) loop
    for j in i + 1 .. pg_catalog.array_length(v_starts, 1) loop
      if pg_catalog.tstzrange(v_starts[i], v_starts[i] + pg_catalog.make_interval(mins => v_minutes + v_buffer), '[)')
         && pg_catalog.tstzrange(v_starts[j], v_starts[j] + pg_catalog.make_interval(mins => v_minutes + v_buffer), '[)') then
        v_conflicts := v_conflicts || v_keys[j];
      end if;
    end loop;
  end loop;

  if pg_catalog.array_length(v_conflicts, 1) > 0 then
    raise exception using errcode = 'P0001', message = 'calendar_conflict',
      detail = pg_catalog.array_to_string(v_conflicts, ',');
  end if;

  insert into private.appointment_series (
    business_id, client_id, service_id, option_choice_ids, rule, request_id, actor, fingerprint
  ) values (
    p_business_id, (v_preview.input ->> 'clientId')::uuid, (v_preview.input ->> 'serviceId')::uuid,
    array(select pg_catalog.jsonb_array_elements_text(v_preview.input -> 'optionChoiceIds')::uuid),
    v_preview.input, p_request_id, v_actor, v_fingerprint
  )
  returning id into v_series;

  perform pg_catalog.set_config('private.series_id', v_series::text, true);
  for i in 1 .. pg_catalog.array_length(v_starts, 1) loop
    begin
      select c.appointment_id into v_appointment
      from public.agenda_create_appointment(
        p_business_id, (v_preview.input ->> 'serviceId')::uuid, v_starts[i],
        (v_preview.input ->> 'clientId')::uuid, null, null, null, null, null,
        -- One stable request per occurrence, derived from the series request.
        pg_catalog.md5(p_request_id::text || '/' || v_keys[i])::uuid,
        array(select pg_catalog.jsonb_array_elements_text(v_preview.input -> 'optionChoiceIds')::uuid)
      ) c;
    exception when others then
      if sqlerrm = 'schedule_conflict' then
        raise exception using errcode = 'P0001', message = 'calendar_conflict', detail = v_keys[i];
      end if;
      raise;
    end;
    v_ids := v_ids || v_appointment;
  end loop;
  perform pg_catalog.set_config('private.series_id', '', true);

  v_response := pg_catalog.jsonb_build_object('seriesId', v_series, 'appointmentIds', pg_catalog.to_jsonb(v_ids));
  update private.appointment_series s set response = v_response where s.id = v_series;
  return v_response;
end;
$$;

revoke all on function public.preview_appointment_series(uuid, uuid, uuid, uuid[], timestamp, integer, integer, date) from public, anon;
revoke all on function public.commit_appointment_series(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.preview_appointment_series(uuid, uuid, uuid, uuid[], timestamp, integer, integer, date) to authenticated;
grant execute on function public.commit_appointment_series(uuid, uuid, uuid, jsonb) to authenticated;
