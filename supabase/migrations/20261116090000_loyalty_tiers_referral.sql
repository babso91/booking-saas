-- VIP tiers and referral (docs/LOYALTY_TIERS_CONTRACT.md, R4-02), on the
-- loyalty engine (20261020090000_loyalty_engine.sql) without a second
-- ledger.
--
-- Tiers: computed from completed visits in a rolling window, never from
-- the points balance (spending points never lowers a tier). Changing the
-- thresholds rewrites nothing: nothing is stored per customer.
--
-- Referral: a customer gets her own link from her Client Hub (an attested
-- relationship). A first booking through it, by a new customer of the
-- business, is claimed once (unique per referred customer). When that
-- booking is completed, the referrer is credited in the ledger with the
-- points frozen at the claim; reopening it reverses the credit (a
-- correction entry), completing it again credits a new generation. Never
-- two credits for one completion, never self-referral.

alter type public.loyalty_event_type add value if not exists 'referral_reward';

create table private.loyalty_tier_rules (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  -- [{ id, name, threshold, perk }], thresholds strictly increasing.
  tiers jsonb not null default '[]'::jsonb,
  window_days integer not null default 365 check (window_days between 30 and 730),
  -- Points to the referrer for a referred first visit; null: no referral.
  referral_points integer check (referral_points between 1 and 10000),
  version integer not null default 1,
  updated_at timestamptz not null default pg_catalog.now()
);

create table private.referral_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  client_id uuid not null,
  -- An attribution code shown in her link, not a credential: it opens
  -- nothing (no Hub, no CRM), it only names who referred a booking. Kept as
  -- is so her current link can be shown again.
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{22}$'),
  request_id uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique (business_id, request_id),
  foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade
);

-- One link in use per customer (expired ones are replaced, revoked kept).
create unique index referral_links_current_idx
  on private.referral_links (client_id) where revoked_at is null;

create table private.referrals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  link_id uuid not null references private.referral_links (id) on delete cascade,
  referrer_client_id uuid not null,
  referred_client_id uuid not null,
  source_appointment_id uuid not null,
  -- Frozen at the claim: a later program change never pays twice nor
  -- differently for the same first visit.
  reward_points integer not null check (reward_points > 0),
  rule_version integer not null,
  state text not null default 'claimed'
    check (state in ('claimed', 'rewarded', 'rejected', 'reversed')),
  reject_reason text,
  generation integer not null default 0,
  claimed_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  -- The first admissible attribution of a customer of this business.
  unique (business_id, referred_client_id),
  unique (source_appointment_id),
  check (referrer_client_id <> referred_client_id),
  foreign key (referrer_client_id, business_id)
    references public.clients (id, business_id) on delete cascade,
  foreign key (referred_client_id, business_id)
    references public.clients (id, business_id) on delete cascade,
  foreign key (source_appointment_id, business_id)
    references public.appointments (id, business_id) on delete cascade
);

create index referrals_referrer_idx on private.referrals (referrer_client_id);

revoke all on table private.loyalty_tier_rules from public, anon, authenticated;
revoke all on table private.referral_links from public, anon, authenticated;
revoke all on table private.referrals from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rules (owner and admin)
-- ---------------------------------------------------------------------------

create function private.loyalty_rules_dto(p_business_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'tiers', coalesce(r.tiers, '[]'::jsonb),
    'windowDays', coalesce(r.window_days, 365),
    'referralPoints', r.referral_points,
    'version', coalesce(r.version, 0)
  )
  from (select 1) one
  left join private.loyalty_tier_rules r on r.business_id = p_business_id;
$$;

create function private.loyalty_rules_manager(p_business_id uuid)
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

revoke all on function private.loyalty_rules_dto(uuid) from public;
revoke all on function private.loyalty_rules_manager(uuid) from public;

create function public.loyalty_get_growth_rules(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.loyalty_rules_dto(p_business_id);
end;
$$;

-- Replaces the tiers, their window and the referral reward, based on
-- `p_expected_version` (0 before the first save; version_conflict
-- otherwise). 0 to 5 tiers, thresholds strictly increasing (1 to 500
-- visits), names 1 to 40 characters, perks up to 120.
create function public.loyalty_set_growth_rules(
  p_business_id uuid,
  p_tiers jsonb,
  p_window_days integer,
  p_referral_points integer,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tiers jsonb := '[]'::jsonb;
  v_tier jsonb;
  v_previous integer := 0;
  v_threshold integer;
  v_name text;
  v_perk text;
  v_current integer;
begin
  perform private.loyalty_rules_manager(p_business_id);
  if p_tiers is null or pg_catalog.jsonb_typeof(p_tiers) <> 'array'
     or pg_catalog.jsonb_array_length(p_tiers) > 5 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'tiers';
  end if;
  for v_tier in select value from pg_catalog.jsonb_array_elements(p_tiers) loop
    begin
      v_threshold := (v_tier ->> 'threshold')::integer;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'tiers';
    end;
    v_name := pg_catalog.btrim(v_tier ->> 'name');
    v_perk := nullif(pg_catalog.btrim(v_tier ->> 'perk'), '');
    if v_threshold is null or v_threshold not between 1 and 500 or v_threshold <= v_previous
       or v_name is null or pg_catalog.char_length(v_name) not between 1 and 40
       or pg_catalog.char_length(v_perk) > 120 then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'tiers';
    end if;
    v_previous := v_threshold;
    v_tiers := v_tiers || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', 't' || v_threshold::text, 'name', v_name, 'threshold', v_threshold, 'perk', v_perk
    ));
  end loop;
  if p_window_days is null or p_window_days not between 30 and 730 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'windowDays';
  end if;
  if p_referral_points is not null and p_referral_points not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'referralPoints';
  end if;

  insert into private.loyalty_tier_rules (business_id, version)
  values (p_business_id, 0)
  on conflict do nothing;
  select r.version into v_current from private.loyalty_tier_rules r
  where r.business_id = p_business_id for update;
  if v_current <> coalesce(p_expected_version, -1) then
    raise exception using errcode = 'P0001', message = 'version_conflict';
  end if;

  update private.loyalty_tier_rules r
  set tiers = v_tiers, window_days = p_window_days, referral_points = p_referral_points,
      version = r.version + 1, updated_at = pg_catalog.now()
  where r.business_id = p_business_id;
  return private.loyalty_rules_dto(p_business_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Tier progress
-- ---------------------------------------------------------------------------

-- Completed visits whose start is in (asOf - window, asOf]. `windowEnd`:
-- when the oldest of them leaves the window (the count may drop then);
-- null without any.
create function private.loyalty_tier_progress(p_business_id uuid, p_client_id uuid, p_as_of timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with rules as (
    select coalesce(r.tiers, '[]'::jsonb) as tiers, coalesce(r.window_days, 365) as window_days,
      coalesce(r.version, 0) as version
    from (select 1) one
    left join private.loyalty_tier_rules r on r.business_id = p_business_id
  ),
  visits as (
    select pg_catalog.count(*)::integer as n, pg_catalog.min(a.starts_at) as oldest
    from public.appointments a, rules
    where a.business_id = p_business_id and a.client_id = p_client_id
      and a.status = 'completed'
      and a.starts_at <= p_as_of
      and a.starts_at > p_as_of - pg_catalog.make_interval(days => rules.window_days)
  )
  select pg_catalog.jsonb_build_object(
    'tiers', rules.tiers,
    'tierId', (
      select t ->> 'id' from pg_catalog.jsonb_array_elements(rules.tiers) t
      where (t ->> 'threshold')::integer <= visits.n
      order by (t ->> 'threshold')::integer desc
      limit 1
    ),
    'currentValue', visits.n,
    'nextThreshold', (
      select (t ->> 'threshold')::integer from pg_catalog.jsonb_array_elements(rules.tiers) t
      where (t ->> 'threshold')::integer > visits.n
      order by (t ->> 'threshold')::integer
      limit 1
    ),
    'windowDays', rules.window_days,
    'windowEnd', visits.oldest + pg_catalog.make_interval(days => rules.window_days),
    'ruleVersion', rules.version
  )
  from rules, visits;
$$;

revoke all on function private.loyalty_tier_progress(uuid, uuid, timestamptz) from public;

-- The professional's view of one customer.
create function public.loyalty_client_tier_progress(p_business_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found';
  end if;
  return private.loyalty_tier_progress(p_business_id, p_client_id, pg_catalog.now());
end;
$$;

-- Her own view, from her Client Hub session.
create function public.client_hub_tier_progress(p_session_token text, p_business_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
begin
  return private.loyalty_tier_progress(p_business_id, v_client, pg_catalog.now());
end;
$$;

-- ---------------------------------------------------------------------------
-- Referral links (her Client Hub)
-- ---------------------------------------------------------------------------

create function private.referral_link_dto(p_link private.referral_links)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p_link.id is null then null else pg_catalog.jsonb_build_object(
    'code', p_link.code,
    'slug', (select b.slug::text from public.businesses b where b.id = p_link.business_id),
    'expiresAt', p_link.expires_at,
    'state', case
      when p_link.revoked_at is not null then 'revoked'
      when p_link.expires_at <= pg_catalog.now() then 'expired'
      else 'active'
    end
  ) end;
$$;

revoke all on function private.referral_link_dto(private.referral_links) from public;

-- Whether the business offers referral now, and her current link (active
-- or expired; `state: unavailable` when the offer stopped), or null.
create function public.client_hub_referral_link(p_session_token text, p_business_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
  v_link private.referral_links;
  v_offered boolean;
  v_dto jsonb;
begin
  v_offered := exists (
    select 1 from private.loyalty_tier_rules r
    where r.business_id = p_business_id and r.referral_points is not null
  ) and exists (
    select 1 from public.loyalty_programs p where p.business_id = p_business_id and p.active
  );
  select * into v_link from private.referral_links l
  where l.client_id = v_client and l.revoked_at is null;
  v_dto := private.referral_link_dto(v_link);
  if v_dto is not null and not v_offered then
    v_dto := v_dto || '{"state": "unavailable"}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('offered', v_offered, 'link', v_dto);
end;
$$;

-- A new link valid 90 days; the previous one stops working. Replayed by
-- requestId. referral_unavailable when the business offers no referral.
-- `p_code`: 16 random bytes, base64url, made by the server.
create function public.client_hub_create_referral_link(
  p_session_token text,
  p_business_id uuid,
  p_request_id uuid,
  p_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
  v_link private.referral_links;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  perform private.loyalty_lock_client(p_business_id, v_client);

  select * into v_link from private.referral_links l
  where l.business_id = p_business_id and l.request_id = p_request_id;
  if found then
    if v_link.client_id <> v_client then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return private.referral_link_dto(v_link);
  end if;

  if not exists (
    select 1 from private.loyalty_tier_rules r
    where r.business_id = p_business_id and r.referral_points is not null
  ) or not exists (
    select 1 from public.loyalty_programs p where p.business_id = p_business_id and p.active
  ) then
    raise exception using errcode = 'P0001', message = 'referral_unavailable';
  end if;

  update private.referral_links l set revoked_at = pg_catalog.now()
  where l.client_id = v_client and l.revoked_at is null;
  insert into private.referral_links (business_id, client_id, code, request_id, expires_at)
  values (p_business_id, v_client, p_code, p_request_id, pg_catalog.now() + interval '90 days')
  returning * into v_link;
  return private.referral_link_dto(v_link);
end;
$$;

-- ---------------------------------------------------------------------------
-- Claim (the public booking route, the service only)
-- ---------------------------------------------------------------------------

-- The booking `p_appointment_id` was made through the link of `p_code`.
-- Answers 'claimed', 'already_claimed' (this booking, again: a retry) or
-- why not: 'unavailable' (unknown, revoked or expired link, another
-- business, no referral), 'ineligible' (self-referral, or not a new
-- customer: an earlier appointment exists), 'already_referred' (she was
-- referred before). Never fails the booking.
create function public.referral_claim(p_code text, p_appointment_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link private.referral_links;
  v_appointment public.appointments;
  v_rules private.loyalty_tier_rules;
begin
  select * into v_appointment from public.appointments a where a.id = p_appointment_id;
  if v_appointment.id is null then
    return 'unavailable';
  end if;
  if exists (select 1 from private.referrals r where r.source_appointment_id = p_appointment_id) then
    return 'already_claimed';
  end if;
  select * into v_link from private.referral_links l
  where l.code = p_code and l.business_id = v_appointment.business_id
    and l.revoked_at is null and l.expires_at > pg_catalog.now();
  select * into v_rules from private.loyalty_tier_rules r where r.business_id = v_appointment.business_id;
  if v_link.id is null or v_rules.referral_points is null then
    return 'unavailable';
  end if;
  if v_link.client_id = v_appointment.client_id then
    return 'ineligible';
  end if;
  -- Serialised per referred customer (her row), as every loyalty write.
  perform private.loyalty_lock_client(v_appointment.business_id, v_appointment.client_id);
  -- An earlier booking of hers: two made at the same instant are ordered by
  -- id, so exactly one of them is her first.
  if exists (
    select 1 from public.appointments a
    where a.business_id = v_appointment.business_id and a.client_id = v_appointment.client_id
      and (a.created_at, a.id) < (v_appointment.created_at, v_appointment.id)
  ) then
    return 'ineligible';
  end if;
  if exists (
    select 1 from private.referrals r
    where r.business_id = v_appointment.business_id and r.referred_client_id = v_appointment.client_id
  ) then
    return 'already_referred';
  end if;

  insert into private.referrals (
    business_id, link_id, referrer_client_id, referred_client_id, source_appointment_id,
    reward_points, rule_version
  ) values (
    v_appointment.business_id, v_link.id, v_link.client_id, v_appointment.client_id,
    v_appointment.id, v_rules.referral_points, v_rules.version
  );
  return 'claimed';
end;
$$;

-- ---------------------------------------------------------------------------
-- Reward on completion, reversal on reopening
-- ---------------------------------------------------------------------------

-- Reverses the standing credit of this generation, once.
create function private.referral_reverse(p_referral private.referrals, p_source text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reward public.loyalty_events;
begin
  select * into v_reward from public.loyalty_events e
  where e.business_id = p_referral.business_id
    and e.idempotency_key = 'referral:' || p_referral.id::text || ':reward:' || p_referral.generation::text;
  if v_reward.id is not null and not exists (
    select 1 from public.loyalty_events r where r.reverses_event_id = v_reward.id
  ) then
    insert into public.loyalty_events (
      business_id, client_id, type, points_delta, reason, idempotency_key,
      reverses_event_id, details
    ) values (
      p_referral.business_id, v_reward.client_id, 'correction', -v_reward.points_delta,
      'Parrainage annulé',
      'referral:' || p_referral.id::text || ':reverse:' || p_referral.generation::text,
      v_reward.id,
      pg_catalog.jsonb_build_object(
        'source', p_source, 'referralId', p_referral.id, 'generation', p_referral.generation
      )
    );
  end if;
end;
$$;

revoke all on function private.referral_reverse(private.referrals, text) from public;

-- Runs inside the appointment's UPDATE (its row lock held). The credit goes
-- to the referrer, keyed by referral × generation: one per completion.
create function private.referral_on_appointment_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_referral private.referrals;
begin
  select * into v_referral from private.referrals r where r.source_appointment_id = new.id for update;
  if v_referral.id is null or v_referral.state = 'rejected' then
    return null;
  end if;

  -- The booking given to another customer is no longer the referred first
  -- visit (it could become the referrer's own, or a known customer's):
  -- the attribution is rejected for good, a standing credit reversed.
  if new.client_id <> v_referral.referred_client_id then
    if v_referral.state = 'rewarded' then
      perform private.referral_reverse(v_referral, 'referral_client_changed');
    end if;
    update private.referrals r set state = 'rejected', reject_reason = 'client_changed',
      updated_at = pg_catalog.now() where r.id = v_referral.id;
    return null;
  end if;

  if old.status <> 'completed' and new.status = 'completed'
     and v_referral.state in ('claimed', 'reversed') then
    -- A link replaced by her newer one after the claim keeps its referral.
    if not exists (
      select 1 from public.loyalty_programs p where p.business_id = new.business_id and p.active
    ) then
      update private.referrals r set state = 'rejected', reject_reason = 'program_inactive',
        updated_at = pg_catalog.now() where r.id = v_referral.id;
      return null;
    end if;
    insert into public.loyalty_events (
      business_id, client_id, type, points_delta, reason, idempotency_key, details
    ) values (
      new.business_id, v_referral.referrer_client_id, 'referral_reward', v_referral.reward_points,
      'Parrainage : première visite réalisée',
      'referral:' || v_referral.id::text || ':reward:' || (v_referral.generation + 1)::text,
      pg_catalog.jsonb_build_object(
        'source', 'referral', 'referralId', v_referral.id,
        'generation', v_referral.generation + 1, 'ruleVersion', v_referral.rule_version
      )
    );
    update private.referrals r
    set state = 'rewarded', generation = r.generation + 1, updated_at = pg_catalog.now()
    where r.id = v_referral.id;
  elsif old.status = 'completed' and new.status <> 'completed' and v_referral.state = 'rewarded' then
    perform private.referral_reverse(v_referral, 'referral_reopened');
    update private.referrals r set state = 'reversed', updated_at = pg_catalog.now()
    where r.id = v_referral.id;
  end if;
  return null;
end;
$$;

revoke all on function private.referral_on_appointment_update() from public;

create trigger appointments_referral
  after update of status, client_id on public.appointments
  for each row execute function private.referral_on_appointment_update();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.loyalty_get_growth_rules(uuid) from public, anon;
revoke all on function public.loyalty_set_growth_rules(uuid, jsonb, integer, integer, integer) from public, anon;
revoke all on function public.loyalty_client_tier_progress(uuid, uuid) from public, anon;
grant execute on function public.loyalty_get_growth_rules(uuid) to authenticated;
grant execute on function public.loyalty_set_growth_rules(uuid, jsonb, integer, integer, integer) to authenticated;
grant execute on function public.loyalty_client_tier_progress(uuid, uuid) to authenticated;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.client_hub_tier_progress(text, uuid)',
    'public.client_hub_referral_link(text, uuid)',
    'public.client_hub_create_referral_link(text, uuid, uuid, text)',
    'public.referral_claim(text, uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
