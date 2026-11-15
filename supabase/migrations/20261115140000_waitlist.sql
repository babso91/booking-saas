-- M2-R06: waiting list (docs/WAITLIST_CONTRACT.md).
--
--   * A client asks, from the public booking of a visible service, to be told
--     when a time frees up in one to five civil windows (or « as soon as
--     possible »), at most 14 days ahead within the business's horizon. She
--     confirms from an email (double opt-in): nothing is ever sent to an
--     unconfirmed address. The business opts in (business_settings).
--   * NO HOLD. A freed interval (private.capacity_releases, written by every
--     cancellation or move) is a signal to look again: the worker asks the
--     canonical engine (private.available_slots) for times that became
--     possible, and offers the first one to the oldest eligible request
--     (FIFO), for 20 minutes at most. The public booking stays open: the first
--     commit wins.
--   * Claiming an offer books through private.create_public_booking_at (the
--     same checks, quote, abuse limits and exclusion constraint as any public
--     booking). A lost slot marks the offer `unavailable` (a typed answer, not
--     a rolled-back exception) and leaves her request active.
--   * Capabilities: the confirmation link and the offer link carry a random
--     token in the URL FRAGMENT (never sent to a server, never in a referrer);
--     only its SHA-256 is stored. Neither gives access to anything else.

alter table public.business_settings
  add column waitlist_enabled boolean not null default false;

alter table private.capacity_releases
  add column processed_at timestamptz,
  add column lease_until timestamptz;

create index capacity_releases_pending_idx
  on private.capacity_releases (occurred_at)
  where processed_at is null;

create table private.waitlist_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  service_id uuid not null,
  option_choice_ids uuid[] not null default '{}',
  windows jsonb not null,
  any_time boolean not null,
  first_name text not null,
  email extensions.citext not null,
  state text not null default 'pending_confirmation'
    check (state in ('pending_confirmation', 'active', 'consumed', 'withdrawn', 'expired')),
  version integer not null default 1,
  active_until timestamptz not null,
  confirm_token_hash text not null unique,
  confirm_expires_at timestamptz not null,
  request_id uuid not null,
  fingerprint text not null,
  network_key text not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (business_id, request_id),
  unique (id, business_id),
  foreign key (service_id, business_id)
    references public.services (id, business_id) on delete cascade
);

create index waitlist_requests_active_idx
  on private.waitlist_requests (business_id, created_at, id)
  where state = 'active';

create table private.waitlist_offers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  waitlist_request_id uuid not null,
  release_id uuid references private.capacity_releases (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  price_cents integer not null,
  duration_minutes integer not null,
  currency text not null,
  state text not null default 'offered'
    check (state in ('offered', 'expired', 'unavailable', 'booked')),
  version integer not null default 1,
  expires_at timestamptz not null,
  token_hash text not null unique,
  appointment_id uuid,
  claim_request_id uuid,
  created_at timestamptz not null default now(),
  foreign key (waitlist_request_id, business_id)
    references private.waitlist_requests (id, business_id) on delete cascade
);

-- At most one open offer per request.
create unique index waitlist_offers_one_open
  on private.waitlist_offers (waitlist_request_id) where state = 'offered';
create index waitlist_offers_open_idx
  on private.waitlist_offers (business_id, starts_at) where state = 'offered';

create table private.waitlist_log (
  network_key text not null,
  created_at timestamptz not null default now()
);

create index waitlist_log_idx on private.waitlist_log (network_key, created_at);

revoke all on private.waitlist_requests, private.waitlist_offers, private.waitlist_log
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------

create function private.waitlist_quote_revision(p_price integer, p_duration integer, p_currency text)
returns text language sql immutable set search_path = '' as $$
  select pg_catalog.md5(p_price::text || ':' || p_duration::text || ':' || p_currency)
$$;

revoke all on function private.waitlist_quote_revision(integer, integer, text) from public;

-- The current quote of a request's service and options, or null if the
-- service is no longer bookable publicly.
create function private.waitlist_quote(
  p_business_id uuid,
  p_service_id uuid,
  p_option_choice_ids uuid[]
)
returns table (price_cents integer, duration_minutes integer, currency text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_service public.services;
  v_quote record;
  v_currency text;
begin
  select s.* into v_service
  from public.services s
  left join public.service_categories c on c.id = s.category_id
  where s.id = p_service_id and s.business_id = p_business_id and s.active
    and (s.category_id is null or c.visible);
  if not found then
    return;
  end if;
  select * into v_quote from private.quote_options(p_business_id, p_service_id, p_option_choice_ids);
  select st.currency into v_currency from public.business_settings st where st.business_id = p_business_id;
  return query select v_service.price_cents + v_quote.price_delta_cents,
    v_service.duration_minutes + v_quote.duration_delta_minutes,
    coalesce(v_currency, 'EUR');
end;
$$;

revoke all on function private.waitlist_quote(uuid, uuid, uuid[]) from public;

-- Does [p_start, p_end) fit in one of the request's windows?
create function private.waitlist_fits(
  p_request private.waitlist_requests,
  p_start timestamptz,
  p_end timestamptz,
  p_timezone text
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_request.any_time and p_end <= p_request.active_until
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_request.windows) w
      where p_start >= private.local_bound(
              (w ->> 'localDate')::date + pg_catalog.make_interval(mins => (w ->> 'startMinute')::integer),
              p_timezone)
        and p_end <= private.local_bound(
              (w ->> 'localDate')::date + pg_catalog.make_interval(mins => (w ->> 'endMinute')::integer),
              p_timezone)
    );
$$;

revoke all on function private.waitlist_fits(private.waitlist_requests, timestamptz, timestamptz, text) from public;

create function public.set_waitlist_enabled(p_business_id uuid, p_enabled boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null or not public.is_business_member(p_business_id)
     or not public.has_business_role(p_business_id, array['owner', 'admin']::public.business_member_role[]) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_enabled is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'enabled';
  end if;
  update public.business_settings st set waitlist_enabled = p_enabled where st.business_id = p_business_id;
  if not p_enabled then
    -- Nothing more is offered; open offers stop where they are.
    update private.waitlist_offers o set state = 'unavailable', version = o.version + 1
    where o.business_id = p_business_id and o.state = 'offered';
  end if;
  return p_enabled;
end;
$$;

revoke all on function public.set_waitlist_enabled(uuid, boolean) from public;
grant execute on function public.set_waitlist_enabled(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Request and confirmation (public, through the app's routes only)

create function public.waitlist_create_request(
  p_slug text,
  p_service_id uuid,
  p_option_choice_ids uuid[],
  p_windows jsonb,
  p_any_time boolean,
  p_first_name text,
  p_email text,
  p_request_id uuid,
  p_client_ip inet,
  p_confirm_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_business public.businesses;
  v_settings public.business_settings;
  v_quote record;
  v_options uuid[] := coalesce(p_option_choice_ids, '{}');
  v_email text := private.canonical_email(p_email);
  v_first_name text := pg_catalog.btrim(coalesce(p_first_name, ''));
  v_today date;
  v_last date;
  v_window jsonb;
  v_windows jsonb := '[]';
  v_dates text[] := '{}';
  v_until timestamptz;
  v_end timestamptz;
  v_network text;
  v_fingerprint text;
  v_existing private.waitlist_requests;
  v_id uuid;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_client_ip is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientIp';
  end if;
  if p_confirm_token_hash is null or p_confirm_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'token';
  end if;

  select b.* into v_business from public.businesses b where b.slug = p_slug;
  if not found then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;
  select st.* into v_settings from public.business_settings st where st.business_id = v_business.id;
  if not v_settings.waitlist_enabled then
    raise exception using errcode = 'P0001', message = 'waitlist_unavailable';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'serviceId', p_service_id, 'options', pg_catalog.to_jsonb(v_options), 'windows', p_windows,
    'anyTime', p_any_time, 'firstName', v_first_name, 'email', v_email)::text);
  select * into v_existing
  from private.waitlist_requests r
  where r.business_id = v_business.id and r.request_id = p_request_id;
  if found then
    if v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return pg_catalog.jsonb_build_object('id', v_existing.id, 'state', v_existing.state,
      'activeUntil', v_existing.active_until, 'replayed', true);
  end if;

  if pg_catalog.char_length(v_first_name) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'firstName';
  end if;
  if v_email is null or not private.email_recipient_valid(v_email) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'email';
  end if;

  select * into v_quote from private.waitlist_quote(v_business.id, p_service_id, v_options);
  if v_quote.price_cents is null then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  -- Windows: civil dates of the business, at most 14 days and its horizon.
  v_today := private.local_date_of(v_now, v_business.timezone);
  v_last := v_today + least(14, v_settings.maximum_booking_advance_days);
  if p_any_time is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'anyTime';
  end if;
  if p_any_time then
    if pg_catalog.jsonb_typeof(p_windows) = 'array' and pg_catalog.jsonb_array_length(p_windows) > 0 then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'windows';
    end if;
    v_until := private.local_day_start(v_last + 1, v_business.timezone);
  else
    if pg_catalog.jsonb_typeof(p_windows) is distinct from 'array'
       or pg_catalog.jsonb_array_length(p_windows) not between 1 and 5 then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'windows';
    end if;
    for v_window in select w from pg_catalog.jsonb_array_elements(p_windows) w loop
      begin
        if (v_window ->> 'localDate')::date < v_today or (v_window ->> 'localDate')::date > v_last
           or (v_window ->> 'startMinute')::integer < 0
           or (v_window ->> 'endMinute')::integer > 1440
           or (v_window ->> 'startMinute')::integer >= (v_window ->> 'endMinute')::integer
           or (v_window ->> 'localDate') || '/' || (v_window ->> 'startMinute') = any (v_dates) then
          raise exception using errcode = '22023', message = 'invalid_input', hint = 'windows';
        end if;
      exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
        raise exception using errcode = '22023', message = 'invalid_input', hint = 'windows';
      end;
      v_end := private.local_bound(
        (v_window ->> 'localDate')::date + pg_catalog.make_interval(mins => (v_window ->> 'endMinute')::integer),
        v_business.timezone);
      if v_end <= v_now then
        raise exception using errcode = '22023', message = 'invalid_input', hint = 'windows';
      end if;
      v_until := greatest(v_until, v_end);
      v_dates := v_dates || ((v_window ->> 'localDate') || '/' || (v_window ->> 'startMinute'));
      v_windows := v_windows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'localDate', v_window ->> 'localDate',
        'startMinute', (v_window ->> 'startMinute')::integer,
        'endMinute', (v_window ->> 'endMinute')::integer));
    end loop;
  end if;

  -- Abuse: per network, and per address in this business.
  v_network := private.client_hub_network_key(p_client_ip);
  if (select count(*) from private.waitlist_log l
      where l.network_key = v_network and l.created_at > v_now - interval '1 hour') >= 10
     or (select count(*) from private.waitlist_requests r
         where r.business_id = v_business.id and r.email = v_email
           and r.state in ('pending_confirmation', 'active')) >= 3 then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;
  insert into private.waitlist_log (network_key) values (v_network);
  delete from private.waitlist_log l where l.created_at < v_now - interval '1 day';

  insert into private.waitlist_requests (
    business_id, service_id, option_choice_ids, windows, any_time, first_name, email,
    active_until, confirm_token_hash, confirm_expires_at, request_id, fingerprint, network_key
  ) values (
    v_business.id, p_service_id, v_options, v_windows, p_any_time, v_first_name, v_email,
    v_until, p_confirm_token_hash, v_now + interval '24 hours', p_request_id, v_fingerprint, v_network
  )
  returning id into v_id;

  return pg_catalog.jsonb_build_object('id', v_id, 'state', 'pending_confirmation',
    'activeUntil', v_until, 'replayed', false,
    'businessName', v_business.name, 'firstName', v_first_name, 'email', v_email);
end;
$$;

create function public.waitlist_confirm_request(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request private.waitlist_requests;
begin
  select * into v_request from private.waitlist_requests r
  where r.confirm_token_hash = p_token_hash
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'waitlist_request_not_found';
  end if;
  if v_request.state = 'pending_confirmation' then
    if v_request.confirm_expires_at <= pg_catalog.now() or v_request.active_until <= pg_catalog.now() then
      update private.waitlist_requests r set state = 'expired', version = r.version + 1 where r.id = v_request.id;
      raise exception using errcode = 'P0002', message = 'waitlist_request_not_found';
    end if;
    update private.waitlist_requests r
    set state = 'active', confirmed_at = pg_catalog.now(), version = r.version + 1
    where r.id = v_request.id;
    v_request.state := 'active';
  end if;
  return pg_catalog.jsonb_build_object('id', v_request.id, 'state', v_request.state,
    'activeUntil', v_request.active_until);
end;
$$;

-- ---------------------------------------------------------------------------
-- Matching (the worker, service role)

create function public.waitlist_match(p_budget integer default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_release private.capacity_releases;
  v_business public.businesses;
  v_settings public.business_settings;
  v_request private.waitlist_requests;
  v_quote record;
  v_date date;
  v_slot record;
  v_token text;
  v_offer uuid;
  v_expires timestamptz;
  v_service_name text;
  v_sent jsonb := '[]';
  v_done integer := 0;
begin
  -- Housekeeping: past offers and requests.
  update private.waitlist_offers o set state = 'expired', version = o.version + 1
  where o.state = 'offered' and o.expires_at <= v_now;
  update private.waitlist_requests r set state = 'expired', version = r.version + 1
  where r.state in ('active', 'pending_confirmation') and r.active_until <= v_now;

  loop
    exit when v_done >= coalesce(p_budget, 20);
    -- One signal at a time, leased: two workers never take the same one.
    select * into v_release
    from private.capacity_releases c
    where c.processed_at is null and (c.lease_until is null or c.lease_until < v_now)
    order by c.occurred_at, c.id
    limit 1
    for update skip locked;
    exit when not found;
    update private.capacity_releases c set lease_until = v_now + interval '2 minutes' where c.id = v_release.id;
    v_done := v_done + 1;

    select b.* into v_business from public.businesses b where b.id = v_release.business_id;
    select st.* into v_settings from public.business_settings st where st.business_id = v_business.id;

    if v_settings.waitlist_enabled and v_release.occupied_until > v_now then
      perform private.lock_business_schedule(v_business.id);
      for v_request in
        select r.* from private.waitlist_requests r
        where r.business_id = v_business.id and r.state = 'active' and r.active_until > v_now
          and not exists (
            select 1 from private.waitlist_offers o
            where o.waitlist_request_id = r.id and o.state = 'offered')
        order by r.created_at, r.id
        limit 50
      loop
        select * into v_quote from private.waitlist_quote(v_business.id, v_request.service_id, v_request.option_choice_ids);
        continue when v_quote.price_cents is null;
        v_slot := null;
        -- Times that touch the freed interval, from the canonical engine.
        for v_date in
          select distinct private.local_date_of(t, v_business.timezone)
          from pg_catalog.unnest(array[v_release.occupied_from, v_release.occupied_until - interval '1 second']) t
        loop
          select s.starts_at, s.ends_at into v_slot
          from private.available_slots(v_business.id, v_request.service_id, v_date, v_now, v_request.option_choice_ids) s
          where s.starts_at < v_release.occupied_until
            and s.ends_at > v_release.occupied_from
            and private.waitlist_fits(v_request, s.starts_at, s.ends_at, v_business.timezone)
            and not exists (
              select 1 from private.waitlist_offers o
              where o.business_id = v_business.id and o.state = 'offered'
                and pg_catalog.tstzrange(o.starts_at, o.ends_at, '[)')
                    && pg_catalog.tstzrange(s.starts_at, s.ends_at, '[)'))
          order by s.starts_at
          limit 1;
          exit when v_slot.starts_at is not null;
        end loop;
        continue when v_slot.starts_at is null;

        v_expires := least(v_now + interval '20 minutes',
          v_slot.starts_at - pg_catalog.make_interval(mins => v_settings.minimum_booking_notice_minutes));
        continue when v_expires <= v_now;

        v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
        insert into private.waitlist_offers (
          business_id, waitlist_request_id, release_id, starts_at, ends_at,
          price_cents, duration_minutes, currency, expires_at, token_hash
        ) values (
          v_business.id, v_request.id, v_release.id, v_slot.starts_at, v_slot.ends_at,
          v_quote.price_cents, v_quote.duration_minutes, v_quote.currency, v_expires,
          pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex')
        )
        returning id into v_offer;

        select s.name into v_service_name from public.services s where s.id = v_request.service_id;
        -- The raw token leaves only here, to the worker that emails it.
        v_sent := v_sent || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'offerId', v_offer, 'token', v_token, 'email', v_request.email::text,
          'firstName', v_request.first_name, 'businessName', v_business.name,
          'serviceName', v_service_name, 'startsAt', v_slot.starts_at,
          'timezone', v_business.timezone, 'expiresAt', v_expires));
      end loop;
    end if;

    update private.capacity_releases c set processed_at = v_now, lease_until = null where c.id = v_release.id;
  end loop;

  return pg_catalog.jsonb_build_object('signals', v_done, 'offers', v_sent);
end;
$$;

-- ---------------------------------------------------------------------------
-- Offer: read and claim (her token, through the app's routes only)

create function private.waitlist_offer_json(p_offer_id uuid, p_now timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', o.id,
    'version', o.version,
    'state', case when o.state = 'offered' and o.expires_at <= p_now then 'expired' else o.state end,
    'serviceName', s.name,
    'startsAt', o.starts_at,
    'endsAt', o.ends_at,
    'localStartsAt', pg_catalog.to_char(o.starts_at at time zone b.timezone, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'timezone', b.timezone,
    'businessName', b.name,
    'priceCents', o.price_cents,
    'durationMinutes', o.duration_minutes,
    'currency', o.currency,
    'quoteRevision', private.waitlist_quote_revision(o.price_cents, o.duration_minutes, o.currency),
    'expiresAt', o.expires_at,
    'requestActive', r.state = 'active' and r.active_until > p_now
  )
  from private.waitlist_offers o
  join private.waitlist_requests r on r.id = o.waitlist_request_id
  join public.businesses b on b.id = o.business_id
  join public.services s on s.id = r.service_id
  where o.id = p_offer_id;
$$;

revoke all on function private.waitlist_offer_json(uuid, timestamptz) from public;

create function public.waitlist_offer(p_offer_id uuid, p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from private.waitlist_offers o where o.id = p_offer_id and o.token_hash = p_token_hash
  ) then
    raise exception using errcode = 'P0002', message = 'waitlist_offer_not_found';
  end if;
  return private.waitlist_offer_json(p_offer_id, pg_catalog.now());
end;
$$;

-- Returns { offer } on success or replay, { error, offer } when the slot was
-- lost (the offer is marked unavailable in the same transaction).
create function public.waitlist_claim(
  p_offer_id uuid,
  p_token_hash text,
  p_request_id uuid,
  p_expected_version integer,
  p_expected_quote_revision text,
  p_client_ip inet
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_offer private.waitlist_offers;
  v_request private.waitlist_requests;
  v_business public.businesses;
  v_quote record;
  v_booking record;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  select * into v_offer from private.waitlist_offers o where o.id = p_offer_id and o.token_hash = p_token_hash;
  if not found then
    raise exception using errcode = 'P0002', message = 'waitlist_offer_not_found';
  end if;

  -- planning → request → offer
  perform private.lock_business_schedule(v_offer.business_id);
  select * into v_request from private.waitlist_requests r where r.id = v_offer.waitlist_request_id for update;
  select * into v_offer from private.waitlist_offers o where o.id = p_offer_id for update;
  v_now := pg_catalog.clock_timestamp();

  if v_offer.state = 'booked' then
    if v_offer.claim_request_id = p_request_id then
      return pg_catalog.jsonb_build_object('offer', private.waitlist_offer_json(v_offer.id, v_now));
    end if;
    raise exception using errcode = 'P0001', message = 'offer_unavailable';
  end if;
  if p_expected_version is null or v_offer.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_offer';
  end if;
  if v_offer.state = 'unavailable' then
    raise exception using errcode = 'P0001', message = 'offer_unavailable';
  end if;
  if v_offer.state = 'expired' or v_offer.expires_at <= v_now then
    raise exception using errcode = 'P0001', message = 'offer_expired';
  end if;
  if v_request.state <> 'active' then
    raise exception using errcode = 'P0001', message = 'offer_unavailable';
  end if;

  select * into v_quote from private.waitlist_quote(v_offer.business_id, v_request.service_id, v_request.option_choice_ids);
  if v_quote.price_cents is null
     or private.waitlist_quote_revision(v_quote.price_cents, v_quote.duration_minutes, v_quote.currency)
        is distinct from p_expected_quote_revision
     or p_expected_quote_revision is distinct from
        private.waitlist_quote_revision(v_offer.price_cents, v_offer.duration_minutes, v_offer.currency) then
    raise exception using errcode = 'P0001', message = 'quote_changed';
  end if;

  select b.* into v_business from public.businesses b where b.id = v_offer.business_id;
  begin
    select * into v_booking
    from private.create_public_booking_at(
      v_now, v_business.slug::text, v_request.service_id, v_offer.starts_at,
      v_request.first_name, v_request.email::text, null, null,
      p_request_id, p_client_ip, v_request.option_choice_ids,
      v_offer.price_cents, v_offer.duration_minutes
    );
  exception when others then
    if sqlerrm in ('slot_unavailable', 'schedule_conflict') then
      update private.waitlist_offers o set state = 'unavailable', version = o.version + 1 where o.id = v_offer.id;
      return pg_catalog.jsonb_build_object('error', 'offer_unavailable',
        'offer', private.waitlist_offer_json(v_offer.id, v_now));
    end if;
    raise;
  end;

  update private.waitlist_offers o
  set state = 'booked', version = o.version + 1, appointment_id = v_booking.appointment_id,
      claim_request_id = p_request_id
  where o.id = v_offer.id;
  update private.waitlist_requests r set state = 'consumed', version = r.version + 1 where r.id = v_request.id;
  -- Other open offers on the same time are no longer possible.
  update private.waitlist_offers o set state = 'unavailable', version = o.version + 1
  where o.business_id = v_offer.business_id and o.state = 'offered' and o.id <> v_offer.id
    and pg_catalog.tstzrange(o.starts_at, o.ends_at, '[)') && pg_catalog.tstzrange(v_offer.starts_at, v_offer.ends_at, '[)');

  return pg_catalog.jsonb_build_object('offer', private.waitlist_offer_json(v_offer.id, v_now),
    'appointmentId', v_booking.appointment_id);
end;
$$;

revoke all on function public.waitlist_create_request(text, uuid, uuid[], jsonb, boolean, text, text, uuid, inet, text) from public, anon, authenticated;
revoke all on function public.waitlist_confirm_request(text) from public, anon, authenticated;
revoke all on function public.waitlist_match(integer) from public, anon, authenticated;
revoke all on function public.waitlist_offer(uuid, text) from public, anon, authenticated;
revoke all on function public.waitlist_claim(uuid, text, uuid, integer, text, inet) from public, anon, authenticated;
grant execute on function public.waitlist_create_request(text, uuid, uuid[], jsonb, boolean, text, text, uuid, inet, text) to service_role;
grant execute on function public.waitlist_confirm_request(text) to service_role;
grant execute on function public.waitlist_match(integer) to service_role;
grant execute on function public.waitlist_offer(uuid, text) to service_role;
grant execute on function public.waitlist_claim(uuid, text, uuid, integer, text, inet) to service_role;
