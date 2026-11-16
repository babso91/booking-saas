-- Offers and codes with a quote tied to the chosen slot
-- (docs/OFFER_QUOTE_CONTRACT.md, R4-03).
--
-- A promotion: an automatic offer or a code, a percentage or an amount off
-- the basis (service + options), bounded by the basis (never a negative
-- total), with optional scope (services, dates, local days and hours,
-- notice) and quota. A quote reserves and consumes nothing; it is kept 10
-- minutes under a short opaque reference. The booking checks it again
-- under the schedule lock and consumes the quota in the same transaction:
-- a taken slot rolls the consumption back; a quota gone answers
-- promotion_exhausted, never the base price silently. A cancelled booking
-- gives its use back, once.

create table private.promotions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('offer', 'code')),
  -- Codes are matched case-insensitively, stored uppercase.
  code text check (code is null or code ~ '^[A-Z0-9_-]{3,32}$'),
  label text not null check (pg_catalog.char_length(label) between 1 and 80),
  percent_off integer check (percent_off between 1 and 100),
  amount_off_cents integer check (amount_off_cents between 1 and 1000000),
  currency text not null,
  min_basis_cents integer not null default 0 check (min_basis_cents >= 0),
  service_ids uuid[],
  valid_from timestamptz,
  valid_until timestamptz,
  -- ISO days (1 Monday … 7 Sunday) and minutes of the local day, start
  -- included, end excluded; null: any.
  weekdays integer[],
  local_start_minute integer check (local_start_minute between 0 and 1439),
  local_end_minute integer check (local_end_minute between 1 and 1440),
  min_notice_minutes integer not null default 0 check (min_notice_minutes between 0 and 525600),
  quota_limit integer check (quota_limit >= 1),
  quota_used integer not null default 0 check (quota_used >= 0),
  state text not null default 'active' check (state in ('active', 'paused')),
  version integer not null default 1,
  created_at timestamptz not null default pg_catalog.now(),
  check ((percent_off is null) <> (amount_off_cents is null)),
  check ((kind = 'code') = (code is not null)),
  check (quota_limit is null or quota_used <= quota_limit),
  check (local_start_minute is null or local_end_minute is null or local_start_minute < local_end_minute),
  check (valid_from is null or valid_until is null or valid_from < valid_until)
);

create unique index promotions_code_idx on private.promotions (business_id, code) where code is not null;
create index promotions_business_idx on private.promotions (business_id) where state = 'active';

create table private.offer_quotes (
  ref text primary key check (ref ~ '^[A-Za-z0-9_-]{16}$'),
  business_id uuid not null references public.businesses (id) on delete cascade,
  service_id uuid not null,
  choice_ids uuid[] not null,
  starts_at timestamptz not null,
  promotion_id uuid references private.promotions (id) on delete cascade,
  promotion_version integer,
  basis_cents integer not null,
  discount_cents integer not null,
  total_cents integer not null,
  currency text not null,
  duration_minutes integer not null,
  created_at timestamptz not null default pg_catalog.now(),
  valid_until timestamptz not null
);

create index offer_quotes_valid_until_idx on private.offer_quotes (valid_until);

create table private.promotion_consumptions (
  appointment_id uuid primary key,
  business_id uuid not null,
  promotion_id uuid not null references private.promotions (id) on delete cascade,
  promotion_version integer not null,
  discount_cents integer not null,
  consumed_at timestamptz not null default pg_catalog.now(),
  released_at timestamptz,
  foreign key (appointment_id, business_id)
    references public.appointments (id, business_id) on delete cascade
);

-- Refused codes per network (the M2 abuse guard for guessing codes).
create table private.offer_code_log (
  network_key text not null,
  business_id uuid not null,
  created_at timestamptz not null default pg_catalog.now()
);

create index offer_code_log_idx on private.offer_code_log (network_key, created_at);

revoke all on table private.promotions from public, anon, authenticated;
revoke all on table private.offer_quotes from public, anon, authenticated;
revoke all on table private.promotion_consumptions from public, anon, authenticated;
revoke all on table private.offer_code_log from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Eligibility and discount
-- ---------------------------------------------------------------------------

-- May `p` discount this booking, evaluated at `p_now` (quota aside)?
create function private.promotion_applies(
  p private.promotions,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_basis_cents integer,
  p_currency text,
  p_timezone text,
  p_now timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p.state = 'active'
    and p.currency = p_currency
    and p_starts_at > p_now
    and (p.valid_from is null or p_now >= p.valid_from)
    and (p.valid_until is null or p_now < p.valid_until)
    and p_basis_cents >= p.min_basis_cents
    and (p.service_ids is null or p_service_id = any (p.service_ids))
    and (p.weekdays is null
         or extract(isodow from p_starts_at at time zone p_timezone)::integer = any (p.weekdays))
    and (p.local_start_minute is null
         or (extract(hour from p_starts_at at time zone p_timezone) * 60
             + extract(minute from p_starts_at at time zone p_timezone))::integer >= p.local_start_minute)
    and (p.local_end_minute is null
         or (extract(hour from p_starts_at at time zone p_timezone) * 60
             + extract(minute from p_starts_at at time zone p_timezone))::integer < p.local_end_minute)
    and p_starts_at >= p_now + pg_catalog.make_interval(mins => p.min_notice_minutes);
$$;

-- The discount, bounded by the basis.
create function private.promotion_discount(p private.promotions, p_basis_cents integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(
    p_basis_cents,
    coalesce(p.amount_off_cents, (p_basis_cents * p.percent_off) / 100)
  );
$$;

revoke all on function private.promotion_applies(private.promotions, uuid, timestamptz, integer, text, text, timestamptz) from public;
revoke all on function private.promotion_discount(private.promotions, integer) from public;

-- ---------------------------------------------------------------------------
-- Quote (the public route, the service only)
-- ---------------------------------------------------------------------------

-- The exact quote for this slot and these answers, with a code if given
-- (a valid code is preferred to the automatic offer) or else the best
-- automatic offer. Reserves and consumes nothing. A refused code answers
-- {error: 'coupon_refused'} (one generic answer, whatever the reason; not
-- raised, so that the refusal is logged); rate_limited after 20 refused
-- codes per network per hour.
create function public.offer_quote(
  p_slug text,
  p_service_id uuid,
  p_option_choice_ids uuid[],
  p_starts_at timestamptz,
  p_coupon text,
  p_client_ip inet
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
  v_choice_ids uuid[] := private.sorted_ids(p_option_choice_ids);
  v_service public.services%rowtype;
  v_settings public.business_settings%rowtype;
  v_timezone text;
  v_quote record;
  v_base integer;
  v_options integer;
  v_basis integer;
  v_duration integer;
  v_coupon text := pg_catalog.upper(nullif(pg_catalog.btrim(p_coupon), ''));
  v_promotion private.promotions;
  v_discount integer := 0;
  v_ref text;
  v_valid_until timestamptz := pg_catalog.now() + interval '10 minutes';
  v_network_key text;
  v_source text;
begin
  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;
  if p_starts_at is null then
    raise exception using errcode = '22023', message = 'invalid_starts_at', hint = 'startsAt';
  end if;
  if not private.service_publicly_bookable(v_business_id, p_service_id) then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;
  select s.* into v_service from public.services s where s.id = p_service_id;
  select st.* into v_settings from public.business_settings st where st.business_id = v_business_id;
  select b.timezone into v_timezone from public.businesses b where b.id = v_business_id;
  select * into v_quote from private.quote_options(v_business_id, p_service_id, v_choice_ids);
  v_base := v_service.price_cents;
  v_options := v_quote.price_delta_cents;
  v_basis := v_base + v_options;
  v_duration := v_service.duration_minutes + v_quote.duration_delta_minutes;
  if v_duration > 720 then
    raise exception using errcode = '22023', message = 'duration_too_long', hint = 'optionChoiceIds';
  end if;

  -- The slot must be one she can book now.
  if not exists (
    select 1
    from private.compute_available_slots(
      v_business_id, private.local_date_of(p_starts_at, v_timezone), pg_catalog.now(), v_timezone,
      v_duration, v_settings.slot_interval_minutes, v_settings.buffer_minutes,
      v_settings.minimum_booking_notice_minutes, v_settings.maximum_booking_advance_days
    ) slot
    where slot.starts_at = p_starts_at
  ) then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end if;

  if v_coupon is not null then
    if p_client_ip is not null then
      v_network_key := private.abuse_key('network:' || case
        when pg_catalog.family(p_client_ip) = 4 then pg_catalog.host(p_client_ip)
        else pg_catalog.network(pg_catalog.set_masklen(p_client_ip, 64))::text
      end);
      -- Serialised per network, as the booking's own limits (2b).
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('offer_code:' || v_network_key, 0)
      );
      if (select pg_catalog.count(*) from private.offer_code_log l
          where l.network_key = v_network_key
            and l.created_at > pg_catalog.now() - interval '1 hour') >= 20 then
        raise exception using errcode = 'P0001', message = 'rate_limited';
      end if;
    end if;
    select p.* into v_promotion from private.promotions p
    where p.business_id = v_business_id and p.code = v_coupon
      and (p.quota_limit is null or p.quota_used < p.quota_limit)
      and private.promotion_applies(p, p_service_id, p_starts_at, v_basis, v_settings.currency, v_timezone, pg_catalog.now());
    if v_promotion.id is null then
      -- Answered, not raised: the refusal must stay in the log.
      if v_network_key is not null then
        insert into private.offer_code_log (network_key, business_id) values (v_network_key, v_business_id);
        delete from private.offer_code_log l
        where l.ctid in (
          select l2.ctid from private.offer_code_log l2
          where l2.created_at < pg_catalog.now() - interval '2 hours' limit 100
        );
      end if;
      return pg_catalog.jsonb_build_object('error', 'coupon_refused');
    end if;
    v_source := 'code';
  else
    select p.* into v_promotion from private.promotions p
    where p.business_id = v_business_id and p.kind = 'offer'
      and (p.quota_limit is null or p.quota_used < p.quota_limit)
      and private.promotion_applies(p, p_service_id, p_starts_at, v_basis, v_settings.currency, v_timezone, pg_catalog.now())
    order by private.promotion_discount(p, v_basis) desc, p.created_at, p.id
    limit 1;
    if v_promotion.id is not null then
      v_source := 'offer';
    end if;
  end if;
  if v_promotion.id is not null then
    v_discount := private.promotion_discount(v_promotion, v_basis);
  end if;

  v_ref := pg_catalog.translate(
    pg_catalog.encode(extensions.gen_random_bytes(12), 'base64'), '+/', '-_'
  );
  insert into private.offer_quotes (
    ref, business_id, service_id, choice_ids, starts_at, promotion_id, promotion_version,
    basis_cents, discount_cents, total_cents, currency, duration_minutes, valid_until
  ) values (
    v_ref, v_business_id, p_service_id, v_choice_ids, p_starts_at, v_promotion.id,
    v_promotion.version, v_basis, v_discount, v_basis - v_discount, v_settings.currency,
    v_duration, v_valid_until
  );
  -- Retention: expired quotes go, a bounded batch at a time.
  delete from private.offer_quotes q
  where q.ref in (
    select q2.ref from private.offer_quotes q2
    where q2.valid_until < pg_catalog.now() - interval '1 day' limit 100
  );

  return pg_catalog.jsonb_build_object(
    'quoteRef', v_ref,
    'startsAt', p_starts_at,
    'baseCents', v_base,
    'optionsCents', v_options,
    'discountCents', v_discount,
    'totalCents', v_basis - v_discount,
    'currency', v_settings.currency,
    'durationMinutes', v_duration,
    'depositCents', null,
    'validUntil', v_valid_until,
    'discountLabel', v_promotion.label,
    'discountSource', v_source
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Application inside the booking (create_public_booking_at)
-- ---------------------------------------------------------------------------

-- Under the schedule lock. The quote must still describe this booking
-- (same slot, answers, basis, duration, currency) and be valid; its offer
-- must still apply, at the same version; then its quota is consumed. The
-- whole booking rolls back if anything after fails (a taken slot).
create function private.offer_apply(
  p_business_id uuid,
  p_quote_ref text,
  p_service_id uuid,
  p_choice_ids uuid[],
  p_starts_at timestamptz,
  p_basis_cents integer,
  p_duration_minutes integer,
  p_currency text,
  p_timezone text,
  p_now timestamptz
)
returns table (total_cents integer, discount_cents integer, promotion_id uuid, promotion_version integer)
language plpgsql
set search_path = ''
as $$
declare
  v_quote private.offer_quotes;
  v_promotion private.promotions;
begin
  select * into v_quote from private.offer_quotes q where q.ref = p_quote_ref;
  if v_quote.ref is null or v_quote.business_id <> p_business_id
     or v_quote.service_id <> p_service_id or v_quote.choice_ids <> p_choice_ids
     or v_quote.starts_at <> p_starts_at or v_quote.basis_cents <> p_basis_cents
     or v_quote.duration_minutes <> p_duration_minutes or v_quote.currency <> p_currency
     or v_quote.valid_until <= p_now then
    raise exception using errcode = 'P0001', message = 'quote_changed';
  end if;
  if v_quote.promotion_id is null then
    return query select v_quote.total_cents, 0, null::uuid, null::integer;
    return;
  end if;

  select * into v_promotion from private.promotions p where p.id = v_quote.promotion_id for update;
  if v_promotion.id is null or v_promotion.version <> v_quote.promotion_version
     or not private.promotion_applies(v_promotion, p_service_id, p_starts_at, p_basis_cents, p_currency, p_timezone, p_now)
     or private.promotion_discount(v_promotion, p_basis_cents) <> v_quote.discount_cents then
    raise exception using errcode = 'P0001', message = 'quote_changed';
  end if;
  update private.promotions p set quota_used = p.quota_used + 1
  where p.id = v_promotion.id and (p.quota_limit is null or p.quota_used < p.quota_limit);
  if not found then
    raise exception using errcode = 'P0001', message = 'promotion_exhausted';
  end if;
  return query select v_quote.total_cents, v_quote.discount_cents, v_promotion.id, v_promotion.version;
end;
$$;

revoke all on function private.offer_apply(uuid, text, uuid, uuid[], timestamptz, integer, integer, text, text, timestamptz) from public;

-- A cancelled booking gives its use back, once.
create function private.promotion_release_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_consumption private.promotion_consumptions;
begin
  if old.status <> 'cancelled' and new.status = 'cancelled' then
    update private.promotion_consumptions c set released_at = pg_catalog.now()
    where c.appointment_id = new.id and c.released_at is null
    returning * into v_consumption;
    if v_consumption.appointment_id is not null then
      update private.promotions p set quota_used = greatest(p.quota_used - 1, 0)
      where p.id = v_consumption.promotion_id;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function private.promotion_release_on_cancel() from public;

create trigger appointments_promotion_release
  after update of status on public.appointments
  for each row execute function private.promotion_release_on_cancel();

-- ---------------------------------------------------------------------------
-- The professional's side (owner and admin)
-- ---------------------------------------------------------------------------

create function private.promotion_dto(p private.promotions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'code', p.code, 'label', p.label,
    'percentOff', p.percent_off, 'amountOffCents', p.amount_off_cents, 'currency', p.currency,
    'minBasisCents', p.min_basis_cents, 'serviceIds', p.service_ids,
    'validFrom', p.valid_from, 'validUntil', p.valid_until, 'weekdays', p.weekdays,
    'localStartMinute', p.local_start_minute, 'localEndMinute', p.local_end_minute,
    'minNoticeMinutes', p.min_notice_minutes, 'quotaLimit', p.quota_limit,
    'quotaUsed', p.quota_used, 'state', p.state, 'version', p.version
  );
$$;

create function private.promotion_manager(p_business_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null
     or not public.has_business_role(p_business_id, array['owner', 'admin']::public.business_member_role[]) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

revoke all on function private.promotion_dto(private.promotions) from public;
revoke all on function private.promotion_manager(uuid) from public;

create function public.promotion_list(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.promotion_manager(p_business_id);
  return coalesce((
    select pg_catalog.jsonb_agg(private.promotion_dto(p) order by p.created_at desc, p.id)
    from private.promotions p where p.business_id = p_business_id
  ), '[]'::jsonb);
end;
$$;

-- A new offer or code (`p_input`: the PromotionInput of the contract).
-- Its rule is fixed: to change it, pause it and create another (a quote
-- or a booking always refers to one rule).
create function public.promotion_create(p_business_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_promotion private.promotions;
  v_services uuid[];
  v_weekdays integer[];
begin
  perform private.promotion_manager(p_business_id);
  begin
    select pg_catalog.array_agg(value::uuid) into v_services
    from pg_catalog.jsonb_array_elements_text(nullif(p_input -> 'serviceIds', 'null'::jsonb));
    select pg_catalog.array_agg(value::integer order by value::integer) into v_weekdays
    from pg_catalog.jsonb_array_elements_text(nullif(p_input -> 'weekdays', 'null'::jsonb));
    insert into private.promotions (
      business_id, kind, code, label, percent_off, amount_off_cents, currency,
      min_basis_cents, service_ids, valid_from, valid_until, weekdays,
      local_start_minute, local_end_minute, min_notice_minutes, quota_limit
    ) values (
      p_business_id,
      p_input ->> 'kind',
      pg_catalog.upper(nullif(pg_catalog.btrim(p_input ->> 'code'), '')),
      pg_catalog.btrim(p_input ->> 'label'),
      (p_input ->> 'percentOff')::integer,
      (p_input ->> 'amountOffCents')::integer,
      (select st.currency from public.business_settings st where st.business_id = p_business_id),
      coalesce((p_input ->> 'minBasisCents')::integer, 0),
      v_services,
      (p_input ->> 'validFrom')::timestamptz,
      (p_input ->> 'validUntil')::timestamptz,
      v_weekdays,
      (p_input ->> 'localStartMinute')::integer,
      (p_input ->> 'localEndMinute')::integer,
      coalesce((p_input ->> 'minNoticeMinutes')::integer, 0),
      (p_input ->> 'quotaLimit')::integer
    )
    returning * into v_promotion;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'coupon_code_taken', hint = 'code';
    when check_violation or invalid_text_representation or not_null_violation
         or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'promotion';
  end;
  -- An empty list would mean « none », never « all »: refused.
  if (p_input -> 'serviceIds' = '[]'::jsonb) or (p_input -> 'weekdays' = '[]'::jsonb) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'promotion';
  end if;
  if v_weekdays is not null and not (v_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'weekdays';
  end if;
  if v_services is not null and (
    select pg_catalog.count(*) from public.services s
    where s.business_id = p_business_id and s.id = any (v_services)
  ) <> pg_catalog.cardinality(v_services) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'serviceIds';
  end if;
  return private.promotion_dto(v_promotion);
end;
$$;

-- pause or resume, on its version.
create function public.promotion_set_state(
  p_business_id uuid,
  p_promotion_id uuid,
  p_state text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_promotion private.promotions;
begin
  perform private.promotion_manager(p_business_id);
  if p_state is null or p_state not in ('active', 'paused') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'state';
  end if;
  select * into v_promotion from private.promotions p
  where p.id = p_promotion_id and p.business_id = p_business_id for update;
  if v_promotion.id is null then
    raise exception using errcode = 'P0002', message = 'promotion_not_found';
  end if;
  if v_promotion.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'version_conflict';
  end if;
  update private.promotions p set state = p_state, version = p.version + 1
  where p.id = v_promotion.id
  returning * into v_promotion;
  return private.promotion_dto(v_promotion);
end;
$$;

revoke all on function public.promotion_list(uuid) from public, anon;
revoke all on function public.promotion_create(uuid, jsonb) from public, anon;
revoke all on function public.promotion_set_state(uuid, uuid, text, integer) from public, anon;
grant execute on function public.promotion_list(uuid) to authenticated;
grant execute on function public.promotion_create(uuid, jsonb) to authenticated;
grant execute on function public.promotion_set_state(uuid, uuid, text, integer) to authenticated;

revoke all on function public.offer_quote(text, uuid, uuid[], timestamptz, text, inet) from public, anon, authenticated;
grant execute on function public.offer_quote(text, uuid, uuid[], timestamptz, text, inet) to service_role;

-- ---------------------------------------------------------------------------
-- The booking: the same function with the quote (2d) and its consumption.
-- ---------------------------------------------------------------------------

drop function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, inet, text, text, uuid[], integer, integer);
drop function private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text, uuid, inet, uuid[], integer, integer);

create function private.create_public_booking_at(p_now timestamp with time zone, p_slug text, p_service_id uuid, p_starts_at timestamp with time zone, p_first_name text, p_email text, p_last_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid, p_client_ip inet DEFAULT NULL::inet, p_option_choice_ids uuid[] DEFAULT NULL::uuid[], p_expected_price_cents integer DEFAULT NULL::integer, p_expected_duration_minutes integer DEFAULT NULL::integer, p_quote_ref text DEFAULT NULL::text)
 RETURNS TABLE(appointment_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, timezone text, service_name text, duration_minutes integer, price_cents integer, currency text, business_name text, status text, replayed boolean, options jsonb)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_business_id uuid;
  v_business_slug text;
  v_business_name text;
  v_timezone text;
  v_currency text;
  v_step integer;
  v_buffer integer;
  v_notice integer;
  v_max_days integer;
  v_service_name text;
  v_duration integer;
  v_price integer;
  v_first_name text := pg_catalog.btrim(p_first_name);
  v_last_name text := nullif(pg_catalog.btrim(p_last_name), '');
  v_email text := private.canonical_email(p_email);
  v_phone text := nullif(pg_catalog.btrim(p_phone), '');
  v_ends_at timestamptz;
  v_client_id uuid;
  v_appointment_id uuid;
  v_fingerprint text;
  v_existing record;
  v_network text;
  v_network_key text;
  v_email_key text;
  v_choice_ids uuid[] := private.sorted_ids(p_option_choice_ids);
  v_quote record;
  v_offer record;
begin
  if v_first_name is null or pg_catalog.char_length(v_first_name) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'invalid_first_name', hint = 'firstName';
  end if;
  if v_last_name is not null and pg_catalog.char_length(v_last_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_last_name', hint = 'lastName';
  end if;
  if v_email is null
    or pg_catalog.char_length(v_email) > 254
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_email', hint = 'email';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_phone', hint = 'phone';
  end if;
  if p_starts_at is null then
    raise exception using errcode = '22023', message = 'invalid_starts_at', hint = 'startsAt';
  end if;

  v_business_id := private.business_id_by_slug(p_slug);

  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  -- 1. Serialise with every other write to this schedule (bookings, blocks,
  --    weekly hours). Statements below run on snapshots taken after the lock.
  perform private.lock_business_schedule(v_business_id);

  -- 2a. A request already processed (a retry after a lost answer, a double
  --     submission): answered from its appointment, nothing is written,
  --     whatever the availability now. Under the schedule lock, so a
  --     concurrent identical request waits for the first and lands here.
  if p_request_id is not null then
    v_fingerprint := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        (pg_catalog.jsonb_build_object(
          'kind', 'public_booking',
          'service_id', p_service_id,
          'starts_at', extract(epoch from p_starts_at),
          'first_name', v_first_name,
          'last_name', v_last_name,
          'email', v_email,
          'phone', v_phone
        )
        -- Only when answers are given: a request without any keeps the
        -- fingerprint it had before options existed.
        || case when pg_catalog.cardinality(v_choice_ids) > 0
             then pg_catalog.jsonb_build_object('option_choice_ids', pg_catalog.to_jsonb(v_choice_ids))
             else '{}'::jsonb end
        -- Only with a quote (R4-03): the same keeps the same fingerprint.
        || case when p_quote_ref is not null
             then pg_catalog.jsonb_build_object('quote_ref', p_quote_ref)
             else '{}'::jsonb end
        )::text,
        'UTF8'
      )),
      'hex'
    );

    select a.id, a.creation_request_fingerprint, a.starts_at, a.ends_at,
           a.status::text as status, a.service_name_snapshot,
           a.duration_minutes_snapshot, a.price_cents_snapshot, a.currency,
           a.options_snapshot,
           b.name as business_name, b.timezone
    into v_existing
    from public.appointments a
    join public.businesses b on b.id = a.business_id
    where a.business_id = v_business_id
      and a.creation_request_id = p_request_id;

    if found then
      if v_existing.creation_request_fingerprint is distinct from v_fingerprint then
        raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
      end if;
      return query
      select
        v_existing.id, v_existing.starts_at, v_existing.ends_at,
        v_existing.timezone, v_existing.service_name_snapshot,
        v_existing.duration_minutes_snapshot, v_existing.price_cents_snapshot,
        v_existing.currency, v_existing.business_name,
        v_existing.status, true, v_existing.options_snapshot;
      return;
    end if;
  end if;

  -- 2b. Abuse limits on new bookings (never on replays), counted in
  --     private.public_booking_log within this transaction. The network
  --     identity is the caller's address as the trusted ingress gave it to
  --     the route: one IPv4 address, or one IPv6 /64 (what a single
  --     subscriber usually holds). Identities are stored as keyed HMACs
  --     (private.abuse_key), never in clear:
  --       - per network: 5 per rolling hour and 15 per 24 hours, all
  --         businesses;
  --       - per network in this business: 3 per 24 hours;
  --       - per customer email in this business: 10 per 24 hours (an email
  --         is cheap to vary: a secondary limit only).
  --     One answer for all of them (rate_limited): nothing tells which one,
  --     nor whether the email is known.
  if p_client_ip is not null then
    v_network := case
      when pg_catalog.family(p_client_ip) = 4
        then pg_catalog.host(p_client_ip)
      else pg_catalog.network(pg_catalog.set_masklen(p_client_ip, 64))::text
    end;
    v_network_key := private.abuse_key('network:' || v_network);
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('public_booking_network:' || v_network_key, 0)
    );
  end if;
  v_email_key := private.abuse_key('email:' || v_email);

  if (
    v_network_key is not null
    and (
      (
        select pg_catalog.count(*)
        from private.public_booking_log l
        where l.network_key = v_network_key
          and l.created_at > p_now - interval '1 hour'
      ) >= 5
      or (
        select pg_catalog.count(*)
        from private.public_booking_log l
        where l.network_key = v_network_key
          and l.created_at > p_now - interval '24 hours'
      ) >= 15
      or (
        select pg_catalog.count(*)
        from private.public_booking_log l
        where l.network_key = v_network_key
          and l.business_id = v_business_id
          and l.created_at > p_now - interval '24 hours'
      ) >= 3
    )
  ) or (
    select pg_catalog.count(*)
    from private.public_booking_log l
    where l.business_id = v_business_id
      and l.email_key = v_email_key
      and l.created_at > p_now - interval '24 hours'
  ) >= 10 then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  -- 2. Read business, settings and service once and lock them in share mode
  --    until commit: a concurrent change either commits before (and is read
  --    here) or waits for this transaction. These values are the only ones
  --    used for validation, occupied window and insertion.
  select
    b.slug::text, b.name, b.timezone,
    st.currency, st.slot_interval_minutes, st.buffer_minutes,
    st.minimum_booking_notice_minutes, st.maximum_booking_advance_days,
    s.name, s.duration_minutes, s.price_cents
  into
    v_business_slug, v_business_name, v_timezone,
    v_currency, v_step, v_buffer, v_notice, v_max_days,
    v_service_name, v_duration, v_price
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  join public.services s on s.business_id = b.id
  where b.id = v_business_id
    and s.id = p_service_id
    and s.active
  for share of b, st, s;

  -- Bookable online: active, in no category or a visible one. Category
  -- and option writes take the schedule lock held here: they come before
  -- this read or after this commit.
  if not found or not private.service_publicly_bookable(v_business_id, p_service_id) then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  -- 2c. Price and duration from her answers, by the server's rule only.
  select * into v_quote
  from private.quote_options(v_business_id, p_service_id, v_choice_ids);
  v_duration := v_duration + v_quote.duration_delta_minutes;
  v_price := v_price + v_quote.price_delta_cents;
  if v_duration > 720 then
    raise exception using errcode = '22023', message = 'duration_too_long', hint = 'optionChoiceIds';
  end if;

  -- 2d. Her quote (R4-03): checked again now, its offer's quota consumed
  --     under the schedule lock (lock order: schedule, then the offer's
  --     row). Nothing matches any more: quote_changed; quota gone:
  --     promotion_exhausted. Never the base price silently.
  if p_quote_ref is not null then
    select * into v_offer
    from private.offer_apply(
      v_business_id, p_quote_ref, p_service_id, v_choice_ids, p_starts_at,
      v_price, v_duration, v_currency, v_timezone, p_now
    );
    v_price := v_offer.total_cents;
  end if;

  -- What she was shown, when the client says it: a price or a duration
  -- that changed since is refused, never booked silently.
  if (p_expected_price_cents is not null and p_expected_price_cents <> v_price)
    or (p_expected_duration_minutes is not null and p_expected_duration_minutes <> v_duration) then
    raise exception using errcode = 'P0001', message = 'quote_changed';
  end if;

  -- 3. Validate the requested start with exactly those values, on the real
  --    civil day that contains it (the day the listing attributed it to).
  if not exists (
    select 1
    from private.compute_available_slots(
      v_business_id,
      private.local_date_of(p_starts_at, v_timezone),
      p_now,
      v_timezone,
      v_duration,
      v_step,
      v_buffer,
      v_notice,
      v_max_days
    ) slot
    where slot.starts_at = p_starts_at
  ) then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end if;

  v_ends_at := p_starts_at + pg_catalog.make_interval(mins => v_duration);

  -- The customer of this business with this email: an existing record is
  -- linked as it is, never completed nor changed by an unverified visitor
  -- (private.resolve_public_client); a new one is created.
  v_client_id := private.resolve_public_client(
    v_business_id, v_first_name, v_last_name, v_email, v_phone
  );

  -- 4. Insert with the same values. The exclusion constraint and the schedule
  --    triggers remain the final guarantees.
  begin
    insert into public.appointments (
      business_id,
      client_id,
      service_id,
      starts_at,
      ends_at,
      status,
      service_name_snapshot,
      duration_minutes_snapshot,
      price_cents_snapshot,
      currency,
      buffer_minutes_snapshot,
      client_first_name_snapshot,
      client_last_name_snapshot,
      client_email_snapshot,
      client_phone_snapshot,
      creation_request_id,
      creation_request_fingerprint,
      options_snapshot
    )
    values (
      v_business_id,
      v_client_id,
      p_service_id,
      p_starts_at,
      v_ends_at,
      'confirmed',
      v_service_name,
      v_duration,
      v_price,
      v_currency,
      v_buffer,
      v_first_name,
      v_last_name,
      v_email,
      v_phone,
      p_request_id,
      v_fingerprint,
      v_quote.options
    )
    returning id into v_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'slot_unavailable';
    when raise_exception then
      if sqlerrm = 'schedule_conflict' then
        raise exception using errcode = 'P0001', message = 'slot_unavailable';
      end if;
      raise;
  end;

  -- (Nested: PL/pgSQL evaluates both sides of AND, and v_offer is only
  -- assigned with a quote.)
  if p_quote_ref is not null then
    if v_offer.promotion_id is not null then
      insert into private.promotion_consumptions (
        appointment_id, business_id, promotion_id, promotion_version, discount_cents
      ) values (
        v_appointment_id, v_business_id, v_offer.promotion_id, v_offer.promotion_version,
        v_offer.discount_cents
      );
    end if;
  end if;

  insert into public.email_events (
    business_id,
    client_id,
    appointment_id,
    type,
    recipient_email,
    payload,
    dedupe_key
  )
  values (
    v_business_id,
    v_client_id,
    v_appointment_id,
    'booking_confirmation',
    v_email,
    pg_catalog.jsonb_build_object(
      'appointment_id', v_appointment_id,
      'business_slug', v_business_slug,
      'business_name', v_business_name,
      'timezone', v_timezone,
      'service_name', v_service_name,
      'options', v_quote.options,
      'starts_at', p_starts_at,
      'ends_at', v_ends_at,
      'local_starts_at', private.wall_clock(p_starts_at, v_timezone),
      'local_ends_at', private.wall_clock(v_ends_at, v_timezone),
      'client_first_name', v_first_name
    ),
    'booking_confirmation:' || v_appointment_id::text
  );

  insert into private.public_booking_log (business_id, network_key, email_key, created_at)
  values (v_business_id, v_network_key, v_email_key, p_now);

  -- Retention: entries older than the longest window (24 h) plus a margin
  -- are useless; a bounded batch goes with each booking (index on
  -- created_at), and private.purge_public_booking_log does the rest.
  perform private.purge_public_booking_log(p_now - interval '48 hours', 100);

  return query
  select
    v_appointment_id,
    p_starts_at,
    v_ends_at,
    v_timezone,
    v_service_name,
    v_duration,
    v_price,
    v_currency,
    v_business_name,
    'confirmed'::text,
    false,
    v_quote.options;
end;
$function$;


revoke all on function private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text, uuid, inet, uuid[], integer, integer, text) from public;

create function public.create_public_booking(p_slug text, p_service_id uuid, p_starts_at timestamp with time zone, p_first_name text, p_email text, p_request_id uuid, p_client_ip inet, p_last_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_option_choice_ids uuid[] DEFAULT NULL::uuid[], p_expected_price_cents integer DEFAULT NULL::integer, p_expected_duration_minutes integer DEFAULT NULL::integer, p_quote_ref text DEFAULT NULL::text)
 RETURNS TABLE(appointment_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, timezone text, service_name text, duration_minutes integer, price_cents integer, currency text, business_name text, status text, replayed boolean, options jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  -- The trusted ingress identity is required: no booking without it (the
  -- route refuses first; this is the database's own check).
  if p_client_ip is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientIp';
  end if;

  return query
  select *
  from private.create_public_booking_at(
    pg_catalog.now(),
    p_slug,
    p_service_id,
    p_starts_at,
    p_first_name,
    p_email,
    p_last_name,
    p_phone,
    p_request_id,
    p_client_ip,
    p_option_choice_ids,
    p_expected_price_cents,
    p_expected_duration_minutes,
    p_quote_ref
  );
end;
$function$;

revoke all on function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, inet, text, text, uuid[], integer, integer, text) from public, anon, authenticated;
grant execute on function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, inet, text, text, uuid[], integer, integer, text) to service_role;
