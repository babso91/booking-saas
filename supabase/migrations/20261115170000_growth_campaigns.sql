-- Rebooking and reactivation campaigns (docs/GROWTH_CAMPAIGNS_CONTRACT.md,
-- R4-01). Simulated sends only: no real marketing message can leave until
-- consent proof, sender identity and budget are approved.
--
-- A marketing queue of its own (growth_occurrences), apart from the
-- transactional outbox: a campaign never delays an appointment email.
--
-- Delivery of one occurrence:
--   claim      bounded rows, skip locked, a lease and a fencing token
--   authorize  under the customer's consent lock (marketing_consent), then
--              the occurrence, then the campaign: re-check the criteria,
--              future appointment, last visit, reachability, consent,
--              cadence and the campaign's units; reserve the units; mark
--              `handoff`
--   send       outside any transaction, with the stable delivery key
--   report     with the same fence: accepted (units used), rejected,
--              transient (nothing left: planned again), unknown (`uncertain`:
--              never retried before reconciliation by its key)
-- Lock order everywhere: consent subject → occurrence → campaign → budget.

create table private.growth_estimates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  criteria jsonb not null,
  channel text not null check (channel in ('email', 'sms')),
  message text not null,
  units_per_recipient integer not null check (units_per_recipient between 1 and 10),
  matched integer not null,
  eligible integer not null,
  suppressed jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table private.growth_budgets (
  business_id uuid not null references public.businesses (id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  -- First day of the month, in the business's time zone.
  period date not null,
  units_limit integer not null check (units_limit >= 0),
  -- Units promised to campaigns of this month (their caps), less what they
  -- gave back when they ended.
  units_committed integer not null default 0 check (units_committed >= 0),
  primary key (business_id, channel, period)
);

create table private.growth_campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  estimate_id uuid not null unique references private.growth_estimates (id),
  criteria jsonb not null,
  channel text not null check (channel in ('email', 'sms')),
  message text not null,
  units_per_recipient integer not null,
  budget_period date not null,
  max_units integer not null check (max_units between 1 and 100000),
  units_used integer not null default 0 check (units_used >= 0),
  units_reserved integer not null default 0 check (units_reserved >= 0),
  state text not null default 'scheduled'
    check (state in ('scheduled', 'running', 'paused', 'completed', 'cancelled')),
  version integer not null default 1,
  attribution_window_days integer not null default 14,
  request_id uuid not null,
  fingerprint text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  closed_at timestamptz,
  unique (business_id, request_id)
);

create table private.growth_occurrences (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references private.growth_campaigns (id) on delete cascade,
  business_id uuid not null,
  client_id uuid not null,
  channel text not null check (channel in ('email', 'sms')),
  status text not null check (status in (
    'planned', 'claimed', 'handoff', 'accepted', 'uncertain', 'failed', 'suppressed'
  )),
  suppression_reason text,
  lease_until timestamptz,
  fence integer not null default 0,
  attempts integer not null default 0,
  units integer,
  provider_ref text,
  handed_off_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  -- One per campaign × customer (a campaign is one channel, one period).
  unique (campaign_id, client_id),
  foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade
);

create index growth_occurrences_queue_idx
  on private.growth_occurrences (created_at, id) where status in ('planned', 'claimed');
create index growth_occurrences_contact_idx
  on private.growth_occurrences (client_id, channel, handed_off_at)
  where status in ('handoff', 'accepted', 'uncertain');
create index growth_occurrences_campaign_idx
  on private.growth_occurrences (campaign_id, status);

create table private.growth_state_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  request_id uuid not null,
  fingerprint text not null,
  response jsonb not null,
  primary key (business_id, request_id)
);

revoke all on table private.growth_estimates from public, anon, authenticated;
revoke all on table private.growth_budgets from public, anon, authenticated;
revoke all on table private.growth_campaigns from public, anon, authenticated;
revoke all on table private.growth_occurrences from public, anon, authenticated;
revoke all on table private.growth_state_requests from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

-- Simulated monthly units per channel until the owner sets a budget.
create function private.growth_default_limit(p_channel text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_channel when 'email' then 2000 else 500 end;
$$;

-- No two marketing messages on one channel within this time.
create function private.growth_cadence()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '14 days';
$$;

-- Units of one message: an email is one. An SMS in the GSM alphabet is 160
-- septets for one part, 153 per part beyond (^ { } \ [ ~ ] | € take two);
-- otherwise UCS-2: 70 code units, 67 per part beyond (a character beyond
-- U+FFFF, an emoji, takes two).
create function private.growth_units(p_channel text, p_message text)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_basic text := E'@£' || pg_catalog.chr(36)
    || E'¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?'
    || E'¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  v_extended text := E'^{}\\[~]|€';
  v_length integer;
begin
  if p_channel = 'email' then
    return 1;
  end if;
  if pg_catalog.translate(p_message, v_basic || v_extended, '') = '' then
    v_length := pg_catalog.char_length(p_message)
      + pg_catalog.char_length(p_message) - pg_catalog.char_length(pg_catalog.translate(p_message, v_extended, ''));
    return case when v_length <= 160 then 1 else pg_catalog.ceil(v_length / 153.0)::integer end;
  end if;
  v_length := pg_catalog.char_length(p_message)
    + pg_catalog.char_length(pg_catalog.regexp_replace(p_message, '[^\U00010000-\U0010FFFF]', '', 'g'));
  return case when v_length <= 70 then 1 else pg_catalog.ceil(v_length / 67.0)::integer end;
end;
$$;

-- Validates closed V1 criteria; answers them normalized. Never notes,
-- answers, images or any sensitive field.
create function private.growth_criteria(p_business_id uuid, p_criteria jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_kind text := p_criteria ->> 'kind';
  v_days integer;
  v_services uuid[];
begin
  if v_kind = 'rebooking' then
    begin
      v_days := (p_criteria ->> 'afterDays')::integer;
      select pg_catalog.array_agg(distinct value::uuid) into v_services
      from pg_catalog.jsonb_array_elements_text(p_criteria -> 'serviceIds');
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'criteria';
    end;
    if v_days is null or v_days not between 1 and 730
       or v_services is null or pg_catalog.cardinality(v_services) not between 1 and 50
       or (select pg_catalog.count(*) from public.services s
           where s.id = any (v_services) and s.business_id = p_business_id)
          <> pg_catalog.cardinality(v_services) then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'criteria';
    end if;
    return pg_catalog.jsonb_build_object(
      'kind', 'rebooking', 'afterDays', v_days,
      'serviceIds', (select pg_catalog.jsonb_agg(s order by s) from pg_catalog.unnest(v_services) s)
    );
  elsif v_kind = 'reactivation' then
    begin
      v_days := (p_criteria ->> 'inactiveDays')::integer;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'criteria';
    end;
    if v_days is null or v_days not between 1 and 1095 then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'criteria';
    end if;
    return pg_catalog.jsonb_build_object('kind', 'reactivation', 'inactiveDays', v_days);
  end if;
  raise exception using errcode = '22023', message = 'invalid_input', hint = 'criteria';
end;
$$;

-- The customers the criteria match at `p_as_of` (one or every customer of
-- the business), each with the first reason that keeps her out, or null
-- (eligible). Reasons, in order: future_appointment,
-- last_visit_not_completed, unreachable, no_consent, recent_contact.
create function private.growth_audience(
  p_business_id uuid,
  p_criteria jsonb,
  p_channel text,
  p_as_of timestamptz,
  p_client_id uuid default null
)
returns table (client_id uuid, reason text)
language sql
stable
set search_path = ''
as $$
  with family as (
    select coalesce(pg_catalog.array_agg(value::uuid), '{}'::uuid[]) as ids
    from pg_catalog.jsonb_array_elements_text(coalesce(p_criteria -> 'serviceIds', '[]'::jsonb))
  ),
  stats as (
    select a.client_id,
      pg_catalog.max(a.starts_at) filter (
        where a.status = 'completed' and a.starts_at <= p_as_of
      ) as last_completed,
      pg_catalog.max(a.starts_at) filter (
        where a.status = 'completed' and a.starts_at <= p_as_of
          and a.service_id = any (f.ids)
      ) as last_completed_family,
      (pg_catalog.array_agg(a.status order by a.starts_at desc, a.id desc)
        filter (where a.starts_at <= p_as_of and a.status <> 'confirmed'))[1] as last_past_status,
      coalesce(pg_catalog.bool_or(a.status = 'confirmed' and a.starts_at > p_as_of), false) as has_future
    from public.appointments a
    cross join family f
    where a.business_id = p_business_id
      and (p_client_id is null or a.client_id = p_client_id)
    group by a.client_id, f.ids
  ),
  matched as (
    select s.*
    from stats s
    where case p_criteria ->> 'kind'
      when 'rebooking' then s.last_completed_family
        <= p_as_of - pg_catalog.make_interval(days => (p_criteria ->> 'afterDays')::integer)
      when 'reactivation' then s.last_completed
        <= p_as_of - pg_catalog.make_interval(days => (p_criteria ->> 'inactiveDays')::integer)
      else false
    end
  )
  select m.client_id,
    case
      when m.has_future then 'future_appointment'
      when m.last_past_status in ('cancelled', 'no_show') then 'last_visit_not_completed'
      when (p_channel = 'email' and c.email is null) or (p_channel = 'sms' and c.phone is null)
        then 'unreachable'
      when private.consent_state(m.client_id, 'marketing', p_channel) <> 'granted' then 'no_consent'
      when exists (
        select 1 from private.growth_occurrences o
        where o.client_id = m.client_id and o.channel = p_channel
          and o.status in ('handoff', 'accepted', 'uncertain')
          and o.handed_off_at > p_as_of - private.growth_cadence()
      ) then 'recent_contact'
    end
  from matched m
  join public.clients c on c.id = m.client_id and c.business_id = p_business_id;
$$;

create function private.growth_assert_manager(p_business_id uuid)
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

create function private.growth_period(p_business_id uuid, p_at timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select pg_catalog.date_trunc('month', p_at at time zone b.timezone)::date
  from public.businesses b where b.id = p_business_id;
$$;

create function private.growth_campaign_dto(p_campaign_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'campaignId', c.id,
    'version', c.version,
    'state', c.state,
    'channel', c.channel,
    'maxUnits', c.max_units,
    'unitsUsed', c.units_used,
    'counts', pg_catalog.jsonb_build_object(
      -- A closed campaign has nothing pending: what was left never leaves.
      'pending', pg_catalog.count(*) filter (
        where o.status in ('planned', 'claimed') and c.state in ('scheduled', 'running', 'paused')
      ),
      'handedOff', pg_catalog.count(*) filter (where o.status = 'handoff'),
      'accepted', pg_catalog.count(*) filter (where o.status = 'accepted'),
      'uncertain', pg_catalog.count(*) filter (where o.status = 'uncertain'),
      'failed', pg_catalog.count(*) filter (where o.status = 'failed'),
      'suppressed', pg_catalog.count(*) filter (where o.status = 'suppressed')
    ),
    'suppressedByReason', coalesce((
      select pg_catalog.jsonb_object_agg(r.reason, r.n)
      from (
        select o2.suppression_reason as reason, pg_catalog.count(*) as n
        from private.growth_occurrences o2
        where o2.campaign_id = c.id and o2.status = 'suppressed'
        group by o2.suppression_reason
      ) r
    ), '{}'::jsonb),
    -- Bookings made by a customer within the window after her message was
    -- accepted: a declared window, no causality claimed.
    'attributedBookings', (
      select pg_catalog.count(distinct a.id)
      from private.growth_occurrences o3
      join public.appointments a
        on a.client_id = o3.client_id and a.business_id = c.business_id
       and a.created_at > o3.accepted_at
       and a.created_at <= o3.accepted_at + pg_catalog.make_interval(days => c.attribution_window_days)
      where o3.campaign_id = c.id and o3.status = 'accepted'
    ),
    'attributionWindowDays', c.attribution_window_days,
    'simulated', true
  )
  from private.growth_campaigns c
  left join private.growth_occurrences o on o.campaign_id = c.id
  where c.id = p_campaign_id
  group by c.id;
$$;

-- Gives the month's budget back what the campaign will no longer use (its
-- cap less units used and still reserved by uncertain deliveries).
create function private.growth_close(p_campaign_id uuid, p_state text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_campaign private.growth_campaigns;
begin
  update private.growth_campaigns c
  set state = p_state, closed_at = pg_catalog.now(), version = c.version + 1
  where c.id = p_campaign_id
  returning * into v_campaign;
  update private.growth_budgets g
  set units_committed = greatest(
    0, g.units_committed - (v_campaign.max_units - v_campaign.units_used - v_campaign.units_reserved)
  )
  where g.business_id = v_campaign.business_id and g.channel = v_campaign.channel
    and g.period = v_campaign.budget_period;
end;
$$;

-- Completes a running campaign with nothing left to hand off.
create function private.growth_maybe_complete(p_campaign_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from private.growth_campaigns c
    where c.id = p_campaign_id and c.state in ('scheduled', 'running')
  ) and not exists (
    select 1 from private.growth_occurrences o
    where o.campaign_id = p_campaign_id and o.status in ('planned', 'claimed', 'handoff')
  ) then
    perform private.growth_close(p_campaign_id, 'completed');
  end if;
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.growth_default_limit(text)',
    'private.growth_cadence()',
    'private.growth_units(text, text)',
    'private.growth_criteria(uuid, jsonb)',
    'private.growth_audience(uuid, jsonb, text, timestamptz, uuid)',
    'private.growth_assert_manager(uuid)',
    'private.growth_period(uuid, timestamptz)',
    'private.growth_campaign_dto(uuid)',
    'private.growth_close(uuid, text)',
    'private.growth_maybe_complete(uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The professional's side (owner and admin)
-- ---------------------------------------------------------------------------

-- Counts only: never a customer's name. Valid 15 minutes; any change of the
-- criteria, channel or message needs a new estimate.
create function public.growth_estimate(
  p_business_id uuid,
  p_criteria jsonb,
  p_channel text,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_criteria jsonb;
  v_message text := pg_catalog.btrim(coalesce(p_message, ''));
  v_units integer;
  v_max_length integer;
  v_matched integer;
  v_eligible integer;
  v_suppressed jsonb;
  v_estimate private.growth_estimates;
begin
  perform private.growth_assert_manager(p_business_id);
  if p_channel is null or p_channel not in ('email', 'sms') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'channel';
  end if;
  v_max_length := case p_channel when 'email' then 2000 else 612 end;
  if v_message = '' or pg_catalog.char_length(v_message) > v_max_length then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'message';
  end if;
  -- An SMS: at most four parts.
  if private.growth_units(p_channel, v_message) > 4 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'message';
  end if;
  v_criteria := private.growth_criteria(p_business_id, p_criteria);
  v_units := private.growth_units(p_channel, v_message);

  with audience as (
    select * from private.growth_audience(p_business_id, v_criteria, p_channel, pg_catalog.now())
  ),
  reasons as (
    select x.reason, pg_catalog.count(*) as n from audience x
    where x.reason is not null group by x.reason
  )
  select (select pg_catalog.count(*) from audience),
    (select pg_catalog.count(*) from audience x where x.reason is null),
    coalesce((select pg_catalog.jsonb_object_agg(r.reason, r.n) from reasons r), '{}'::jsonb)
  into v_matched, v_eligible, v_suppressed;

  insert into private.growth_estimates (
    business_id, created_by, criteria, channel, message, units_per_recipient,
    matched, eligible, suppressed, expires_at
  ) values (
    p_business_id, (select auth.uid()), v_criteria, p_channel, v_message, v_units,
    v_matched, v_eligible, v_suppressed, pg_catalog.now() + interval '15 minutes'
  )
  returning * into v_estimate;

  return pg_catalog.jsonb_build_object(
    'estimateId', v_estimate.id,
    'matched', v_matched,
    'eligible', v_eligible,
    'suppressedByReason', v_suppressed,
    'estimatedUnits', v_eligible * v_units,
    'estimateExpiresAt', v_estimate.expires_at,
    'timeZone', (select b.timezone from public.businesses b where b.id = p_business_id),
    'simulated', true
  );
end;
$$;

-- Plans the campaign of a fresh estimate, under the month's budget: its
-- cap is committed against the budget (quota_exceeded beyond). The
-- audience is evaluated again now; each customer is checked once more just
-- before her message (growth_authorize). Replayed by requestId.
create function public.growth_schedule(
  p_business_id uuid,
  p_estimate_id uuid,
  p_max_units integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fingerprint text := pg_catalog.md5(pg_catalog.concat_ws('|', p_estimate_id, p_max_units));
  v_campaign private.growth_campaigns;
  v_estimate private.growth_estimates;
  v_period date;
  v_budget private.growth_budgets;
begin
  perform private.growth_assert_manager(p_business_id);
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_max_units is null or p_max_units not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'maxUnits';
  end if;
  -- Two calls with one requestId (whatever their estimate) run one after
  -- the other: the second replays or answers idempotency_conflict.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('growth_schedule:' || p_business_id::text || ':' || p_request_id::text, 0)
  );

  select * into v_estimate from private.growth_estimates e
  where e.id = p_estimate_id and e.business_id = p_business_id
  for update;

  select * into v_campaign from private.growth_campaigns c
  where c.business_id = p_business_id and c.request_id = p_request_id;
  if found then
    if v_campaign.fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return private.growth_campaign_dto(v_campaign.id);
  end if;

  if v_estimate.id is null or v_estimate.used_at is not null
     or v_estimate.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'estimate_stale';
  end if;

  v_period := private.growth_period(p_business_id, pg_catalog.now());
  insert into private.growth_budgets (business_id, channel, period, units_limit)
  values (p_business_id, v_estimate.channel, v_period, private.growth_default_limit(v_estimate.channel))
  on conflict do nothing;
  select * into v_budget from private.growth_budgets g
  where g.business_id = p_business_id and g.channel = v_estimate.channel and g.period = v_period
  for update;
  if v_budget.units_committed + p_max_units > v_budget.units_limit then
    raise exception using errcode = 'P0001', message = 'quota_exceeded';
  end if;
  update private.growth_budgets g set units_committed = g.units_committed + p_max_units
  where g.business_id = p_business_id and g.channel = v_estimate.channel and g.period = v_period;

  update private.growth_estimates e set used_at = pg_catalog.now() where e.id = v_estimate.id;

  insert into private.growth_campaigns (
    business_id, estimate_id, criteria, channel, message, units_per_recipient,
    budget_period, max_units, request_id, fingerprint, created_by
  ) values (
    p_business_id, v_estimate.id, v_estimate.criteria, v_estimate.channel, v_estimate.message,
    v_estimate.units_per_recipient, v_period, p_max_units, p_request_id, v_fingerprint,
    (select auth.uid())
  )
  returning * into v_campaign;

  insert into private.growth_occurrences (
    campaign_id, business_id, client_id, channel, status, suppression_reason
  )
  select v_campaign.id, p_business_id, a.client_id, v_campaign.channel,
    case when a.reason is null then 'planned' else 'suppressed' end, a.reason
  from private.growth_audience(p_business_id, v_campaign.criteria, v_campaign.channel, pg_catalog.now()) a
  order by a.client_id;

  perform private.growth_maybe_complete(v_campaign.id);
  return private.growth_campaign_dto(v_campaign.id);
end;
$$;

create function public.growth_read(p_business_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.growth_assert_manager(p_business_id);
  if not exists (
    select 1 from private.growth_campaigns c
    where c.id = p_campaign_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0001', message = 'campaign_not_found';
  end if;
  return private.growth_campaign_dto(p_campaign_id);
end;
$$;

-- pause (pending messages wait; handed-off ones may still arrive), resume,
-- cancel (pending messages never leave; the unused cap goes back to the
-- budget). Replayed by requestId; version_conflict on a stale version.
create function public.growth_set_state(
  p_business_id uuid,
  p_campaign_id uuid,
  p_expected_version integer,
  p_request_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fingerprint text := pg_catalog.md5(pg_catalog.concat_ws('|', p_campaign_id, p_expected_version, p_action));
  v_replay private.growth_state_requests;
  v_campaign private.growth_campaigns;
  v_response jsonb;
begin
  perform private.growth_assert_manager(p_business_id);
  if p_action is null or p_action not in ('pause', 'resume', 'cancel') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'action';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;

  select * into v_campaign from private.growth_campaigns c
  where c.id = p_campaign_id and c.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_not_found';
  end if;

  select * into v_replay from private.growth_state_requests r
  where r.business_id = p_business_id and r.request_id = p_request_id;
  if found then
    if v_replay.fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return v_replay.response;
  end if;

  if v_campaign.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'version_conflict';
  end if;
  if v_campaign.state in ('completed', 'cancelled')
     or (p_action = 'pause' and v_campaign.state = 'paused')
     or (p_action = 'resume' and v_campaign.state <> 'paused') then
    raise exception using errcode = 'P0001', message = 'campaign_closed';
  end if;

  if p_action = 'cancel' then
    perform private.growth_close(v_campaign.id, 'cancelled');
  else
    update private.growth_campaigns c
    set state = case p_action when 'pause' then 'paused' else 'running' end,
        version = c.version + 1
    where c.id = v_campaign.id;
    if p_action = 'resume' then
      perform private.growth_maybe_complete(v_campaign.id);
    end if;
  end if;

  v_response := private.growth_campaign_dto(v_campaign.id);
  insert into private.growth_state_requests (business_id, request_id, fingerprint, response)
  values (p_business_id, p_request_id, v_fingerprint, v_response);
  return v_response;
end;
$$;

revoke all on function public.growth_estimate(uuid, jsonb, text, text) from public, anon;
revoke all on function public.growth_schedule(uuid, uuid, integer, uuid) from public, anon;
revoke all on function public.growth_read(uuid, uuid) from public, anon;
revoke all on function public.growth_set_state(uuid, uuid, integer, uuid, text) from public, anon;
grant execute on function public.growth_estimate(uuid, jsonb, text, text) to authenticated;
grant execute on function public.growth_schedule(uuid, uuid, integer, uuid) to authenticated;
grant execute on function public.growth_read(uuid, uuid) to authenticated;
grant execute on function public.growth_set_state(uuid, uuid, integer, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The worker (the service only)
-- ---------------------------------------------------------------------------

-- Claims up to `p_limit` planned occurrences of active campaigns (and
-- claims whose lease ran out), oldest first, skipping rows another worker
-- holds. Each claim bumps the fence: a slower worker's later report is
-- refused.
create function public.growth_claim(p_limit integer, p_lease_seconds integer)
returns table (occurrence_id uuid, fence integer)
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select o.id
    from private.growth_occurrences o
    join private.growth_campaigns c on c.id = o.campaign_id
    where c.state in ('scheduled', 'running')
      and (o.status = 'planned' or (o.status = 'claimed' and o.lease_until < pg_catalog.now()))
    order by o.created_at, o.id
    limit least(greatest(p_limit, 1), 200)
    for update of o skip locked
  )
  update private.growth_occurrences o
  set status = 'claimed',
      lease_until = pg_catalog.now()
        + pg_catalog.make_interval(secs => least(greatest(p_lease_seconds, 10), 600)),
      fence = o.fence + 1,
      updated_at = pg_catalog.clock_timestamp()
  from picked
  where o.id = picked.id
  returning o.id, o.fence;
$$;

-- The last check before her message, under her consent lock. Answers
-- {outcome:'send', ...} (units reserved, `handoff`), 'suppressed' (reason),
-- 'deferred' (paused: planned again), 'closed' (cancelled or completed) or
-- 'stale' (another worker's fence, or the lease ran out).
create function public.growth_authorize(
  p_occurrence_id uuid,
  p_fence integer,
  p_unsubscribe_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client_id uuid;
  v_occurrence private.growth_occurrences;
  v_campaign private.growth_campaigns;
  v_reason text;
  v_matched boolean;
  v_client public.clients;
begin
  select o.client_id into v_client_id from private.growth_occurrences o where o.id = p_occurrence_id;
  if v_client_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'stale');
  end if;
  perform private.lock_consent_subject(v_client_id);

  select * into v_occurrence from private.growth_occurrences o where o.id = p_occurrence_id for update;
  if v_occurrence.fence <> p_fence or v_occurrence.status <> 'claimed'
     or v_occurrence.lease_until <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('outcome', 'stale');
  end if;
  select * into v_campaign from private.growth_campaigns c where c.id = v_occurrence.campaign_id for update;

  if v_campaign.state = 'paused' then
    update private.growth_occurrences o
    set status = 'planned', lease_until = null, updated_at = pg_catalog.clock_timestamp()
    where o.id = v_occurrence.id;
    return pg_catalog.jsonb_build_object('outcome', 'deferred');
  end if;
  if v_campaign.state not in ('scheduled', 'running') then
    update private.growth_occurrences o
    set status = 'planned', lease_until = null, updated_at = pg_catalog.clock_timestamp()
    where o.id = v_occurrence.id;
    return pg_catalog.jsonb_build_object('outcome', 'closed');
  end if;

  select true, a.reason into v_matched, v_reason
  from private.growth_audience(
    v_campaign.business_id, v_campaign.criteria, v_campaign.channel, pg_catalog.now(), v_client_id
  ) a;
  if v_matched is null then
    v_reason := 'no_longer_matching';
  elsif v_reason is null
        and v_campaign.units_used + v_campaign.units_reserved + v_campaign.units_per_recipient
            > v_campaign.max_units then
    v_reason := 'budget_exhausted';
  end if;

  if v_reason is not null then
    update private.growth_occurrences o
    set status = 'suppressed', suppression_reason = v_reason, lease_until = null,
        updated_at = pg_catalog.clock_timestamp()
    where o.id = v_occurrence.id;
    perform private.growth_maybe_complete(v_campaign.id);
    return pg_catalog.jsonb_build_object('outcome', 'suppressed', 'reason', v_reason);
  end if;

  if p_unsubscribe_token_hash is null or p_unsubscribe_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'unsubscribe';
  end if;
  insert into private.unsubscribe_links (business_id, client_id, channel, token_hash, expires_at)
  values (v_campaign.business_id, v_client_id, v_campaign.channel, p_unsubscribe_token_hash,
          pg_catalog.now() + interval '1 year');

  update private.growth_occurrences o
  set status = 'handoff', units = v_campaign.units_per_recipient,
      handed_off_at = pg_catalog.now(), lease_until = null,
      updated_at = pg_catalog.clock_timestamp()
  where o.id = v_occurrence.id;
  update private.growth_campaigns c
  set units_reserved = c.units_reserved + v_campaign.units_per_recipient, state = 'running'
  where c.id = v_campaign.id;

  select * into v_client from public.clients c where c.id = v_client_id;
  return pg_catalog.jsonb_build_object(
    'outcome', 'send',
    'deliveryKey', v_occurrence.id,
    'channel', v_campaign.channel,
    'recipient', case v_campaign.channel when 'email' then v_client.email::text else v_client.phone end,
    'firstName', v_client.first_name,
    'businessName', (select b.name from public.businesses b where b.id = v_campaign.business_id),
    'message', v_campaign.message,
    'units', v_campaign.units_per_recipient
  );
end;
$$;

-- The transport's answer, with the fence of the claim:
--   accepted   taken by the provider (not proof of receipt): units used
--   rejected   refused for good: failed, units released
--   transient  nothing was delivered (or the provider never saw the key):
--              planned again, at most 3 attempts; units released
--   unknown    answer lost after handoff: `uncertain`, units kept; only
--              reconciliation by its key (accepted, rejected, transient)
--              moves it on
-- Answers the occurrence's status, or 'stale'.
create function public.growth_report(
  p_occurrence_id uuid,
  p_fence integer,
  p_outcome text,
  p_provider_ref text default null,
  p_actual_units integer default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_occurrence private.growth_occurrences;
  v_campaign private.growth_campaigns;
  v_status text;
  v_used integer;
begin
  if p_outcome is null or p_outcome not in ('accepted', 'rejected', 'transient', 'unknown') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'outcome';
  end if;
  select * into v_occurrence from private.growth_occurrences o where o.id = p_occurrence_id for update;
  if v_occurrence.id is null or v_occurrence.fence <> p_fence
     or v_occurrence.status not in ('handoff', 'uncertain')
     or (v_occurrence.status = 'uncertain' and p_outcome = 'unknown') then
    return 'stale';
  end if;
  select * into v_campaign from private.growth_campaigns c where c.id = v_occurrence.campaign_id for update;

  v_used := least(greatest(coalesce(p_actual_units, v_occurrence.units), 1), v_occurrence.units);
  v_status := case p_outcome
    when 'accepted' then 'accepted'
    when 'rejected' then 'failed'
    when 'unknown' then 'uncertain'
    else case when v_occurrence.attempts + 1 >= 3 then 'failed' else 'planned' end
  end;

  update private.growth_occurrences o
  set status = v_status,
      attempts = o.attempts + case when p_outcome = 'transient' then 1 else 0 end,
      provider_ref = coalesce(pg_catalog.left(p_provider_ref, 200), o.provider_ref),
      accepted_at = case when v_status = 'accepted' then pg_catalog.now() end,
      handed_off_at = case when v_status = 'planned' then null else o.handed_off_at end,
      updated_at = pg_catalog.clock_timestamp()
  where o.id = v_occurrence.id;

  if v_status <> 'uncertain' then
    update private.growth_campaigns c
    set units_reserved = greatest(0, c.units_reserved - v_occurrence.units),
        units_used = c.units_used + case when v_status = 'accepted' then v_used else 0 end
    where c.id = v_occurrence.campaign_id;
    -- Closed already: its cap went back to the budget except these units,
    -- still reserved then. What was not used goes back now.
    if v_campaign.state in ('completed', 'cancelled') then
      update private.growth_budgets g
      set units_committed = greatest(0, g.units_committed - (
        v_occurrence.units - case when v_status = 'accepted' then v_used else 0 end))
      where g.business_id = v_campaign.business_id and g.channel = v_campaign.channel
        and g.period = v_campaign.budget_period;
    end if;
  end if;

  perform private.growth_maybe_complete(v_occurrence.campaign_id);
  return v_status;
end;
$$;

-- Uncertain deliveries to reconcile by their key, oldest first. A handoff
-- whose report never came (the worker stopped between handing it to the
-- transport and reporting) becomes uncertain after 5 minutes: it may have
-- left, so it is reconciled, never resent blindly.
create function public.growth_uncertain(p_limit integer)
returns table (occurrence_id uuid, fence integer, channel text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.growth_occurrences o
  set status = 'uncertain', updated_at = pg_catalog.clock_timestamp()
  where o.status = 'handoff' and o.handed_off_at < pg_catalog.now() - interval '5 minutes';
  return query
    select o.id, o.fence, o.channel
    from private.growth_occurrences o
    where o.status = 'uncertain'
    order by o.updated_at, o.id
    limit least(greatest(p_limit, 1), 200);
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.growth_claim(integer, integer)',
    'public.growth_authorize(uuid, integer, text)',
    'public.growth_report(uuid, integer, text, text, integer)',
    'public.growth_uncertain(integer)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
