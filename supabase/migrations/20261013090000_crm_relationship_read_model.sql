-- CRM V1, step 2: the relationship read model (professionals only).
--
-- Read-only views of a business's customers (public.clients) built from the
-- records that already exist; no new table, no stored aggregate, no write:
--
--   crm_client_activity  per-customer appointment metrics, the one
--                        definition shared by the directory and the profile;
--   crm_list_clients     the directory: search, filters, orderings, keyset
--                        pagination, total of the matching customers;
--   crm_client_profile   one customer: current record, metrics, favourite
--                        service, value of completed services, upcoming
--                        appointments (bounded);
--   crm_client_timeline  one customer's relationship history, keyset
--                        paginated: appointments, loyalty ledger entries
--                        (with their reward redemption), emails.
--
-- Security: SECURITY INVOKER, so row level security on clients,
-- appointments, loyalty_events, reward_redemptions, rewards, email_events
-- and services stays the authority; each function also refuses a caller who
-- is not a member of p_business_id (`forbidden`) and filters every row by
-- p_business_id. Executable by authenticated only (never anon). STABLE: they
-- cannot write.
--
-- Time: every instant is compared with one reference instant per call
-- (p_as_of, by default now(), the transaction's start: the same value for
-- every statement of the call). No civil-date decision is taken here; wall
-- clocks are read separately from public.business_time.
--
-- Status semantics (public.appointment_status, as Booking and Agenda use it):
--   completed   the professional marked it completed (only possible once it
--               has started): a completed visit;
--   no_show     marked as a no-show: never a visit;
--   cancelled   never a visit, whatever its date;
--   confirmed   booked and not resolved: upcoming while its start is after
--               the reference instant; after it, "past confirmed", awaiting
--               an outcome, never counted as a visit.

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------

-- A customer's emails, newest first (timeline). The existing email indexes
-- serve the outbox worker (status, scheduled_for) and deduplication only:
-- without this one, every timeline page reads all of a business's emails.
create index email_events_client_timeline_idx
  on public.email_events (business_id, client_id, created_at desc, id)
  where client_id is not null;

-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------

-- The caller is a member of the business (RLS gives the same answer row by
-- row; this gives a clear error instead of an empty result).
create function public.crm_assert_member(p_business_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Metrics: one definition
-- ---------------------------------------------------------------------------

-- Per customer of the business (or one customer): counts by outcome, first
-- and last completed visit (the appointment's start: the visit time; the
-- instant it was marked completed is completed_at, not used here), upcoming
-- appointments (confirmed, starting after p_as_of) and the next one (earliest
-- start, then id). Customers without any appointment have no row.
create function public.crm_client_activity(
  p_business_id uuid,
  p_as_of timestamptz,
  p_client_id uuid default null
)
returns table (
  client_id uuid,
  completed_count integer,
  cancelled_count integer,
  no_show_count integer,
  past_confirmed_count integer,
  upcoming_count integer,
  first_completed_at timestamptz,
  last_completed_at timestamptz,
  next_appointment_id uuid,
  next_starts_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.crm_assert_member(p_business_id);
  if p_as_of is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'asOf';
  end if;

  return query
  select
    a.client_id,
    (count(*) filter (where a.status = 'completed'))::integer,
    (count(*) filter (where a.status = 'cancelled'))::integer,
    (count(*) filter (where a.status = 'no_show'))::integer,
    (count(*) filter (where a.status = 'confirmed' and a.starts_at <= p_as_of))::integer,
    (count(*) filter (where a.status = 'confirmed' and a.starts_at > p_as_of))::integer,
    min(a.starts_at) filter (where a.status = 'completed'),
    max(a.starts_at) filter (where a.status = 'completed'),
    (pg_catalog.array_agg(a.id order by a.starts_at, a.id)
      filter (where a.status = 'confirmed' and a.starts_at > p_as_of))[1],
    min(a.starts_at) filter (where a.status = 'confirmed' and a.starts_at > p_as_of)
  from public.appointments a
  where a.business_id = p_business_id
    and (p_client_id is null or a.client_id = p_client_id)
  group by a.client_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Directory
-- ---------------------------------------------------------------------------

-- One page of the business's customers.
--
-- Search (p_query, trimmed; empty = everyone): case-insensitive substring
-- (ILIKE, wildcards escaped) of the first name, last name, "first last",
-- "last first", email or phone, names compared in Unicode NFC; and, when the
-- query has at least 3 digits, those digits within the phone's digits
-- ("0612" finds "06 12 34 56 78"). Accents are significant.
--
-- Filters: all, upcoming (an upcoming appointment), no_upcoming, visited (at
-- least one completed visit), never_visited.
--
-- Orderings, each completed by id ascending (unique, so total):
--   name              lower("first last") ascending;
--   newest            created_at descending;
--   last_visit        last completed visit descending, never visited last;
--   next_appointment  next appointment ascending, none last;
--   most_visits       completed visits descending.
-- Keyset pagination: the next page starts after (sort key, id) of the last
-- row read, given back as p_after_* (sort_text for name, sort_at for the
-- instants, sort_count for most_visits; ±infinity stand for "none").
-- At most p_limit + 1 rows: the extra one says another page exists.
-- total_count: matching customers of this business (search and filter, not
-- the cursor).
create function public.crm_list_clients(
  p_business_id uuid,
  p_query text default null,
  p_filter text default 'all',
  p_sort text default 'name',
  p_limit integer default 25,
  p_as_of timestamptz default null,
  p_after_text text default null,
  p_after_at timestamptz default null,
  p_after_count integer default null,
  p_after_id uuid default null
)
returns table (
  id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  created_at timestamptz,
  completed_count integer,
  last_completed_at timestamptz,
  upcoming_count integer,
  next_appointment_id uuid,
  next_starts_at timestamptz,
  sort_text text,
  sort_at timestamptz,
  sort_count integer,
  total_count bigint,
  as_of timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.now());
  v_query text := nullif(pg_catalog.btrim(pg_catalog.normalize(coalesce(p_query, ''), 'NFC')), '');
  v_pattern text;
  v_digits text;
begin
  perform public.crm_assert_member(p_business_id);

  if p_filter is null or p_filter not in ('all', 'upcoming', 'no_upcoming', 'visited', 'never_visited') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'filter';
  end if;
  if p_sort is null or p_sort not in ('name', 'newest', 'last_visit', 'next_appointment', 'most_visits') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'sort';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'limit';
  end if;
  if pg_catalog.char_length(v_query) > 100 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'query';
  end if;
  if p_after_id is not null and (
    (p_sort = 'name' and p_after_text is null)
    or (p_sort in ('newest', 'last_visit', 'next_appointment') and p_after_at is null)
    or (p_sort = 'most_visits' and p_after_count is null)
  ) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'cursor';
  end if;

  if v_query is not null then
    v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
      v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits := pg_catalog.regexp_replace(v_query, '\D', '', 'g');
    if pg_catalog.char_length(v_digits) < 3 then
      v_digits := null;
    end if;
  end if;

  return query
  with activity as (
    select * from public.crm_client_activity(p_business_id, v_as_of)
  ),
  matching as (
    select
      c.id,
      c.first_name,
      c.last_name,
      c.email::text as email,
      c.phone,
      c.created_at,
      coalesce(x.completed_count, 0) as completed_count,
      x.last_completed_at,
      coalesce(x.upcoming_count, 0) as upcoming_count,
      x.next_appointment_id,
      x.next_starts_at,
      pg_catalog.lower(c.first_name || ' ' || coalesce(c.last_name, '')) as name_key
    from public.clients c
    left join activity x on x.client_id = c.id
    where c.business_id = p_business_id
      and (
        v_pattern is null
        or pg_catalog.normalize(c.first_name, 'NFC') ilike v_pattern
        or pg_catalog.normalize(coalesce(c.last_name, ''), 'NFC') ilike v_pattern
        or pg_catalog.normalize(c.first_name || ' ' || coalesce(c.last_name, ''), 'NFC') ilike v_pattern
        or pg_catalog.normalize(coalesce(c.last_name, '') || ' ' || c.first_name, 'NFC') ilike v_pattern
        or c.email::text ilike v_pattern
        or c.phone ilike v_pattern
        or (v_digits is not null
            and pg_catalog.regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || v_digits || '%')
      )
      and (
        p_filter = 'all'
        or (p_filter = 'upcoming' and coalesce(x.upcoming_count, 0) > 0)
        or (p_filter = 'no_upcoming' and coalesce(x.upcoming_count, 0) = 0)
        or (p_filter = 'visited' and coalesce(x.completed_count, 0) > 0)
        or (p_filter = 'never_visited' and coalesce(x.completed_count, 0) = 0)
      )
  ),
  keyed as (
    select
      m.*,
      case when p_sort = 'name' then m.name_key end as k_text,
      case p_sort
        when 'newest' then m.created_at
        when 'last_visit' then coalesce(m.last_completed_at, '-infinity'::timestamptz)
        when 'next_appointment' then coalesce(m.next_starts_at, 'infinity'::timestamptz)
      end as k_at,
      case when p_sort = 'most_visits' then m.completed_count end as k_count,
      pg_catalog.count(*) over () as total
    from matching m
  )
  select
    k.id, k.first_name, k.last_name, k.email, k.phone, k.created_at,
    k.completed_count, k.last_completed_at, k.upcoming_count,
    k.next_appointment_id, k.next_starts_at,
    k.k_text, k.k_at, k.k_count, k.total, v_as_of
  from keyed k
  where p_after_id is null
    or (p_sort = 'name' and (k.k_text, k.id) > (p_after_text, p_after_id))
    or (p_sort = 'next_appointment' and (k.k_at, k.id) > (p_after_at, p_after_id))
    or (p_sort in ('newest', 'last_visit')
        and (k.k_at < p_after_at or (k.k_at = p_after_at and k.id > p_after_id)))
    or (p_sort = 'most_visits'
        and (k.k_count < p_after_count or (k.k_count = p_after_count and k.id > p_after_id)))
  order by
    k.k_text asc,
    case when p_sort in ('newest', 'last_visit') then k.k_at end desc,
    case when p_sort = 'next_appointment' then k.k_at end asc,
    k.k_count desc,
    k.id asc
  limit p_limit + 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profile
-- ---------------------------------------------------------------------------

-- One customer of the business (`client_not_found` otherwise, also for an id
-- of another business), at one reference instant (now()):
--   client          the current record (not a historical snapshot);
--   activity        the shared metrics (crm_client_activity);
--   favoriteService the service of most completed visits; ties: the most
--                   recent such visit, then service id. Its name is the
--                   service's current name (appointments keep the name each
--                   was booked under; see the timeline);
--   completedValue  per currency: the sum of the prices recorded on completed
--                   appointments (price_cents_snapshot, the price agreed at
--                   booking) and their number. Not a payment: nothing in the
--                   database records what was paid;
--   upcoming        the next p_upcoming_limit upcoming appointments (start,
--                   then id), the first being the next appointment.
create function public.crm_client_profile(
  p_business_id uuid,
  p_client_id uuid,
  p_upcoming_limit integer default 5
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_as_of timestamptz := pg_catalog.now();
  v_client public.clients%rowtype;
  v_activity record;
  v_favorite jsonb;
  v_value jsonb;
  v_upcoming jsonb;
begin
  perform public.crm_assert_member(p_business_id);
  if p_upcoming_limit is null or p_upcoming_limit not between 1 and 20 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'upcomingLimit';
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = p_client_id
    and c.business_id = p_business_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'client_not_found';
  end if;

  select * into v_activity
  from public.crm_client_activity(p_business_id, v_as_of, p_client_id);

  select pg_catalog.jsonb_build_object(
    'serviceId', f.service_id,
    'currentName', s.name,
    'active', s.active,
    'completedCount', f.completed
  )
  into v_favorite
  from (
    select a.service_id, count(*)::integer as completed, max(a.starts_at) as latest
    from public.appointments a
    where a.business_id = p_business_id
      and a.client_id = p_client_id
      and a.status = 'completed'
    group by a.service_id
    order by count(*) desc, max(a.starts_at) desc, a.service_id
    limit 1
  ) f
  left join public.services s
    on s.id = f.service_id and s.business_id = p_business_id;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'currency', v.currency,
    'amountCents', v.amount,
    'appointmentCount', v.appointments
  ) order by v.currency), '[]'::jsonb)
  into v_value
  from (
    select a.currency, sum(a.price_cents_snapshot)::bigint as amount, count(*)::integer as appointments
    from public.appointments a
    where a.business_id = p_business_id
      and a.client_id = p_client_id
      and a.status = 'completed'
    group by a.currency
  ) v;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', u.id,
    'status', u.status,
    'startsAt', u.starts_at,
    'endsAt', u.ends_at,
    'serviceId', u.service_id,
    'serviceName', u.service_name_snapshot,
    'durationMinutes', u.duration_minutes_snapshot,
    'priceCents', u.price_cents_snapshot,
    'currency', u.currency
  ) order by u.starts_at, u.id), '[]'::jsonb)
  into v_upcoming
  from (
    select a.*
    from public.appointments a
    where a.business_id = p_business_id
      and a.client_id = p_client_id
      and a.status = 'confirmed'
      and a.starts_at > v_as_of
    order by a.starts_at, a.id
    limit p_upcoming_limit
  ) u;

  return pg_catalog.jsonb_build_object(
    'asOf', v_as_of,
    'client', pg_catalog.jsonb_build_object(
      'id', v_client.id,
      'firstName', v_client.first_name,
      'lastName', v_client.last_name,
      'email', v_client.email::text,
      'phone', v_client.phone,
      'createdAt', v_client.created_at,
      'updatedAt', v_client.updated_at
    ),
    'activity', pg_catalog.jsonb_build_object(
      'completedCount', coalesce(v_activity.completed_count, 0),
      'cancelledCount', coalesce(v_activity.cancelled_count, 0),
      'noShowCount', coalesce(v_activity.no_show_count, 0),
      'pastConfirmedCount', coalesce(v_activity.past_confirmed_count, 0),
      'upcomingCount', coalesce(v_activity.upcoming_count, 0),
      'firstCompletedAt', v_activity.first_completed_at,
      'lastCompletedAt', v_activity.last_completed_at,
      'nextAppointmentId', v_activity.next_appointment_id,
      'nextStartsAt', v_activity.next_starts_at
    ),
    'favoriteService', v_favorite,
    'completedValue', v_value,
    'upcoming', v_upcoming
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Timeline
-- ---------------------------------------------------------------------------

-- One page of a customer's relationship history, newest first. Only
-- persisted facts, one event per business fact:
--   appointment  every appointment of the customer except the upcoming ones
--                (confirmed, starting after p_as_of: shown apart, in the
--                profile); dated by its start. Its contact is the
--                appointment's own snapshot, its service name and price the
--                ones recorded on it; completed_at is when it was marked
--                completed (null when unknown);
--   loyalty      a loyalty_events ledger entry, dated by its creation; a
--                reward redemption is part of the ledger entry it references
--                (reward_redemptions.loyalty_event_id, unique), never an
--                event of its own;
--   email        an email_events row, dated by its creation (when it was
--                recorded): its status says scheduled (pending), sending,
--                sent, failed or cancelled; delivery is not tracked. No
--                payload, provider identifier or error text.
-- Identity: "<kind>:<uuid>", stable. Order: occurred_at descending, then
-- event id descending, compared byte by byte (collation "C": independent of
-- the database locale), a total order. Keyset: the next page starts strictly after
-- (p_before_at, p_before_id), the last event read; p_as_of, returned with
-- every row, must be given back so every page excludes the same upcoming
-- appointments. At most p_limit + 1 rows: the extra one says another page
-- exists. data: the event's fields (crm read model contract).
create function public.crm_client_timeline(
  p_business_id uuid,
  p_client_id uuid,
  p_limit integer default 20,
  p_as_of timestamptz default null,
  p_before_at timestamptz default null,
  p_before_id text default null
)
returns table (
  event_id text,
  kind text,
  occurred_at timestamptz,
  as_of timestamptz,
  data jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.now());
begin
  perform public.crm_assert_member(p_business_id);
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'limit';
  end if;
  if (p_before_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'cursor';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found';
  end if;

  return query
  with events as (
    select
      'appointment:' || a.id::text as event_id,
      'appointment'::text as kind,
      a.starts_at as occurred_at,
      pg_catalog.jsonb_build_object(
        'id', a.id,
        'status', a.status,
        'startsAt', a.starts_at,
        'endsAt', a.ends_at,
        'serviceId', a.service_id,
        'serviceName', a.service_name_snapshot,
        'durationMinutes', a.duration_minutes_snapshot,
        'priceCents', a.price_cents_snapshot,
        'currency', a.currency,
        'source', case when a.created_by is null then 'public' else 'manual' end,
        'completedAt', a.completed_at,
        'cancellationReason', a.cancellation_reason,
        'contact', pg_catalog.jsonb_build_object(
          'firstName', a.client_first_name_snapshot,
          'lastName', a.client_last_name_snapshot,
          'email', a.client_email_snapshot,
          'phone', a.client_phone_snapshot
        )
      ) as data
    from public.appointments a
    where a.business_id = p_business_id
      and a.client_id = p_client_id
      and not (a.status = 'confirmed' and a.starts_at > v_as_of)
    union all
    select
      'loyalty:' || l.id::text,
      'loyalty',
      l.created_at,
      pg_catalog.jsonb_build_object(
        'id', l.id,
        'type', l.type,
        'pointsDelta', l.points_delta,
        'reason', l.reason,
        'appointmentId', l.appointment_id,
        'redemption', (
          select pg_catalog.jsonb_build_object(
            'id', r.id,
            'rewardId', r.reward_id,
            'rewardName', w.name,
            'pointsSpent', r.points_spent,
            'redeemedAt', r.redeemed_at
          )
          from public.reward_redemptions r
          left join public.rewards w
            on w.id = r.reward_id and w.business_id = r.business_id
          where r.loyalty_event_id = l.id
            and r.business_id = l.business_id
        )
      )
    from public.loyalty_events l
    where l.business_id = p_business_id
      and l.client_id = p_client_id
    union all
    select
      'email:' || e.id::text,
      'email',
      e.created_at,
      pg_catalog.jsonb_build_object(
        'id', e.id,
        'type', e.type,
        'status', e.status,
        'scheduledFor', e.scheduled_for,
        'sentAt', e.sent_at,
        'recipientEmail', e.recipient_email::text,
        'appointmentId', e.appointment_id
      )
    from public.email_events e
    where e.business_id = p_business_id
      and e.client_id = p_client_id
  )
  select ev.event_id, ev.kind, ev.occurred_at, v_as_of, ev.data
  from events ev
  where p_before_at is null
    or (ev.occurred_at, ev.event_id collate "C") < (p_before_at, p_before_id collate "C")
  order by ev.occurred_at desc, ev.event_id collate "C" desc
  limit p_limit + 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: members' sessions only
-- ---------------------------------------------------------------------------

revoke all on function public.crm_assert_member(uuid) from public, anon;
revoke all on function public.crm_client_activity(uuid, timestamptz, uuid) from public, anon;
revoke all on function public.crm_list_clients(
  uuid, text, text, text, integer, timestamptz, text, timestamptz, integer, uuid
) from public, anon;
revoke all on function public.crm_client_profile(uuid, uuid, integer) from public, anon;
revoke all on function public.crm_client_timeline(
  uuid, uuid, integer, timestamptz, timestamptz, text
) from public, anon;

grant execute on function public.crm_assert_member(uuid) to authenticated;
grant execute on function public.crm_client_activity(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.crm_list_clients(
  uuid, text, text, text, integer, timestamptz, text, timestamptz, integer, uuid
) to authenticated;
grant execute on function public.crm_client_profile(uuid, uuid, integer) to authenticated;
grant execute on function public.crm_client_timeline(
  uuid, uuid, integer, timestamptz, timestamptz, text
) to authenticated;
