-- Her SaaS plan, its changes and its billing, simulated
-- (docs/PLATFORM_BILLING_CONTRACT.md; M7-R01 to R03).
--
-- No payment provider is connected: nothing is ever charged, and no right
-- is granted without a verified payment event (platform_ingest_event,
-- the service only, from an authenticated webhook). The plan's authority
-- stays public.sites.plan (the Studio's lens, set_site_plan): an applied
-- change writes it there, nowhere else.
--
-- Prices: immutable versions per plan and cadence. A quote is immutable,
-- short-lived and kept by the server; a confirmation refers to it, never to
-- an amount sent by the screen. One unresolved change per business.
-- Billing events: one effect per event id, a stale version per object is
-- ignored, and an event that names nothing known is kept for
-- reconciliation, never applied blindly.

create table private.platform_price_versions (
  id text primary key check (id ~ '^[a-z0-9_]{3,40}$'),
  plan text not null check (plan in ('core', 'signature')),
  cadence text not null check (cadence in ('monthly', 'yearly')),
  -- The base price (including `included_bookable_staff` bookable
  -- professionals when a per-professional component is set).
  amount_minor integer not null check (amount_minor >= 0),
  -- An optional per-professional component: each bookable professional
  -- beyond the included ones adds `extra_staff_amount_minor`. Both null:
  -- the price does not depend on the team (none is set today: the
  -- commercial model is not decided). Accounts that are not bookable
  -- never count.
  included_bookable_staff integer check (included_bookable_staff >= 0),
  extra_staff_amount_minor integer check (extra_staff_amount_minor >= 0),
  -- Provisional prices are shown as such; nothing is charged anyway.
  commercial_status text not null default 'provisional'
    check (commercial_status in ('provisional', 'validated')),
  currency text not null default 'EUR',
  display_tax_mode text not null default 'ttc' check (display_tax_mode in ('ttc', 'ht')),
  active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  check ((included_bookable_staff is null) = (extra_staff_amount_minor is null))
);

-- One active version per plan and cadence.
create unique index platform_price_versions_active_idx
  on private.platform_price_versions (plan, cadence) where active;

insert into private.platform_price_versions (id, plan, cadence, amount_minor) values
  ('core_m_v1', 'core', 'monthly', 2900),
  ('core_y_v1', 'core', 'yearly', 29000),
  ('sig_m_v1', 'signature', 'monthly', 4900),
  ('sig_y_v1', 'signature', 'yearly', 49000);

-- A price version never changes: a new one replaces it.
create function private.platform_price_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or new.amount_minor <> old.amount_minor or new.plan <> old.plan
     or new.included_bookable_staff is distinct from old.included_bookable_staff
     or new.extra_staff_amount_minor is distinct from old.extra_staff_amount_minor
     or new.cadence <> old.cadence or new.currency <> old.currency
     or new.display_tax_mode <> old.display_tax_mode then
    raise exception using errcode = '55000', message = 'price_version_immutable';
  end if;
  return new;
end;
$$;

create trigger platform_price_versions_immutable
  before update or delete on private.platform_price_versions
  for each row execute function private.platform_price_immutable();

-- The bookable professionals a business is billed for. One today: the
-- team (staff_members, a separate lot) replaces this function when it is
-- merged, counting bookable profiles only (an administrative account that
-- is not bookable never counts).
create function private.platform_bookable_staff_count(p_business_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select 1;
$$;

-- The recurring amount of a price version for a business: the base, plus
-- each bookable professional beyond the included ones when the version has
-- a per-professional component.
create function private.platform_price_amount(p_version_id text, p_business_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select p.amount_minor + case
    when p.extra_staff_amount_minor is null then 0
    else greatest(0, private.platform_bookable_staff_count(p_business_id) - p.included_bookable_staff)
         * p.extra_staff_amount_minor
  end
  from private.platform_price_versions p
  where p.id = p_version_id;
$$;

create table private.platform_subscriptions (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  plan text not null check (plan in ('core', 'signature')),
  cadence text not null check (cadence in ('monthly', 'yearly')),
  -- null: the legacy state captured from the beta (nothing paid).
  price_version_id text references private.platform_price_versions (id),
  source text not null check (source in ('legacy', 'billing')),
  state text not null check (state in ('trialing', 'active', 'past_due', 'ended')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  grace_until timestamptz,
  cancel_at timestamptz,
  cancel_requested_at timestamptz,
  -- Per object, the last applied billing event's version.
  source_version integer not null default 0,
  revision integer not null default 1,
  created_at timestamptz not null default pg_catalog.now()
);

create table private.platform_quotes (
  id text primary key check (id ~ '^q_[A-Za-z0-9_-]{16}$'),
  business_id uuid not null references public.businesses (id) on delete cascade,
  current_plan text not null,
  current_cadence text not null,
  target_price_version_id text not null references private.platform_price_versions (id),
  due_now_minor integer not null,
  next_charge_at timestamptz not null,
  next_charge_minor integer not null,
  recurring_minor integer not null,
  effective_mode text not null check (effective_mode in ('after_verified_payment', 'end_of_period')),
  effective_at timestamptz,
  -- The paid period starts again at the payment (first payment, a change of
  -- cadence); otherwise the current period goes on.
  restarts_period boolean not null,
  -- The period the proration was computed on (null when it restarts).
  period_end timestamptz,
  subscription_revision integer not null,
  expires_at timestamptz not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now()
);

create table private.platform_change_commands (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  quote_id text not null references private.platform_quotes (id),
  operation_id uuid not null,
  status text not null check (status in (
    'requested', 'requires_action', 'scheduled', 'applied', 'failed', 'cancelled'
  )),
  target_plan text not null,
  target_cadence text not null,
  target_price_version_id text not null,
  due_now_minor integer not null,
  currency text not null default 'EUR',
  effective_at timestamptz,
  restarts_period boolean not null default false,
  period_end timestamptz,
  -- A payment that never comes: the request lapses then.
  expires_at timestamptz,
  source_version integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (business_id, operation_id)
);

-- One unresolved change per business.
create unique index platform_change_commands_open_idx
  on private.platform_change_commands (business_id)
  where status in ('requested', 'requires_action', 'scheduled');

create table private.platform_invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_id text not null unique,
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null check (status in ('preparing', 'issued', 'unavailable')),
  amount_minor integer,
  currency text not null default 'EUR',
  simulated boolean not null default true,
  created_at timestamptz not null default pg_catalog.now()
);

create index platform_invoices_business_idx on private.platform_invoices (business_id, period_start desc);

-- The billing inbox: one row per received event id.
create table private.platform_billing_events (
  event_id text primary key check (pg_catalog.char_length(event_id) between 1 and 200),
  kind text not null,
  payload jsonb not null,
  received_at timestamptz not null default pg_catalog.now(),
  outcome text not null check (outcome in ('applied', 'ignored_stale', 'staged', 'rejected'))
);

create table private.platform_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  operation_id uuid not null,
  kind text not null,
  fingerprint text not null,
  response jsonb not null,
  created_by uuid,
  primary key (business_id, operation_id)
);

revoke all on table private.platform_price_versions from public, anon, authenticated;
revoke all on table private.platform_subscriptions from public, anon, authenticated;
revoke all on table private.platform_quotes from public, anon, authenticated;
revoke all on table private.platform_change_commands from public, anon, authenticated;
revoke all on table private.platform_invoices from public, anon, authenticated;
revoke all on table private.platform_billing_events from public, anon, authenticated;
revoke all on table private.platform_requests from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function private.platform_period(p_cadence text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case p_cadence when 'yearly' then interval '1 year' else interval '1 month' end;
$$;

-- Her subscription, captured from the current state on first use: the
-- site's plan (Core without a site), active, nothing paid (legacy).
create function private.platform_subscription(p_business_id uuid, p_lock boolean)
returns private.platform_subscriptions
language plpgsql
set search_path = ''
as $$
declare
  v_subscription private.platform_subscriptions;
begin
  insert into private.platform_subscriptions (
    business_id, plan, cadence, source, state, current_period_start, current_period_end
  )
  select p_business_id, coalesce(s.plan, 'core'), 'monthly', 'legacy', 'active',
    pg_catalog.now(), pg_catalog.now() + interval '1 month'
  from public.businesses b
  left join public.sites s on s.business_id = b.id
  where b.id = p_business_id
  on conflict (business_id) do nothing;
  if p_lock then
    select * into v_subscription from private.platform_subscriptions s
    where s.business_id = p_business_id for update;
  else
    select * into v_subscription from private.platform_subscriptions s
    where s.business_id = p_business_id;
  end if;
  return v_subscription;
end;
$$;

-- The plan her rights follow: the site's (the Studio's authority).
create function private.platform_effective_plan(p_business_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select s.plan from public.sites s where s.business_id = p_business_id), 'core');
$$;

create function private.platform_owner(p_business_id uuid)
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
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not public.has_business_role(p_business_id, array['owner']::public.business_member_role[]) then
    raise exception using errcode = 'P0001', message = 'permission_denied';
  end if;
end;
$$;

create function private.platform_command_dto(p private.platform_change_commands)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p.id is null then null else pg_catalog.jsonb_build_object(
    'commandId', p.id,
    'status', p.status,
    'target', pg_catalog.jsonb_build_object('plan', p.target_plan, 'cadence', p.target_cadence),
    'effectiveAt', p.effective_at
  ) end;
$$;

create function private.platform_summary(p_business_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'plan', private.platform_effective_plan(p_business_id),
    'cadence', s.cadence,
    'state', s.state,
    'revision', s.revision,
    'renewsAt', case when s.state in ('active', 'trialing') and s.cancel_at is null
                     then s.current_period_end end,
    'graceUntil', case when s.state = 'past_due' then s.grace_until end,
    'cancellation', case when s.cancel_at is null then null else pg_catalog.jsonb_build_object(
      'effectiveAt', s.cancel_at, 'requestedAt', s.cancel_requested_at) end,
    'upcomingAppointments', (
      select pg_catalog.count(*) from public.appointments a
      where a.business_id = p_business_id and a.status = 'confirmed' and a.starts_at > pg_catalog.now()
    ),
    'pending', (
      select private.platform_command_dto(c) from private.platform_change_commands c
      where c.business_id = p_business_id
        and c.status in ('requested', 'requires_action', 'scheduled')
    ),
    'simulated', true
  )
  from private.platform_subscriptions s
  where s.business_id = p_business_id;
$$;

-- Owner's replay record: the same operation and content answer the same.
create function private.platform_replay(
  p_business_id uuid, p_operation_id uuid, p_kind text, p_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_request private.platform_requests;
begin
  if p_operation_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'operationId';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform:' || p_business_id::text || ':' || p_operation_id::text, 0)
  );
  select * into v_request from private.platform_requests r
  where r.business_id = p_business_id and r.operation_id = p_operation_id;
  if found then
    if v_request.kind <> p_kind or v_request.fingerprint <> pg_catalog.md5(p_payload::text)
       or v_request.created_by is distinct from (select auth.uid()) then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return v_request.response;
  end if;
  return null;
end;
$$;

create function private.platform_record(
  p_business_id uuid, p_operation_id uuid, p_kind text, p_payload jsonb, p_response jsonb
)
returns jsonb
language sql
set search_path = ''
as $$
  insert into private.platform_requests (business_id, operation_id, kind, fingerprint, response, created_by)
  values (p_business_id, p_operation_id, p_kind, pg_catalog.md5(p_payload::text), p_response, (select auth.uid()))
  returning response;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.platform_price_immutable()',
    'private.platform_bookable_staff_count(uuid)',
    'private.platform_price_amount(text, uuid)',
    'private.platform_period(text)',
    'private.platform_subscription(uuid, boolean)',
    'private.platform_effective_plan(uuid)',
    'private.platform_owner(uuid)',
    'private.platform_command_dto(private.platform_change_commands)',
    'private.platform_summary(uuid)',
    'private.platform_replay(uuid, uuid, text, jsonb)',
    'private.platform_record(uuid, uuid, text, jsonb, jsonb)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Offers and her plan (any member reads; owner acts)
-- ---------------------------------------------------------------------------

create function public.platform_list_offers()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'offers', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'planCode', p.plan, 'priceVersionId', p.id, 'cadence', case p.cadence when 'yearly' then 'year' else 'month' end,
      'amountMinor', p.amount_minor, 'currency', p.currency, 'displayTaxMode', p.display_tax_mode,
      'perBookableStaff', case when p.extra_staff_amount_minor is null then null
        else pg_catalog.jsonb_build_object(
          'included', p.included_bookable_staff, 'extraAmountMinor', p.extra_staff_amount_minor) end,
      'provisional', p.commercial_status = 'provisional'
    ) order by p.plan, p.cadence), '[]'::jsonb),
    'catalogRevision', pg_catalog.md5(coalesce(pg_catalog.string_agg(p.id, ',' order by p.id), ''))
  )
  from private.platform_price_versions p
  where p.active;
$$;

create function public.platform_billing_summary(p_business_id uuid)
returns jsonb
language plpgsql
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
  perform private.platform_subscription(p_business_id, false);
  return private.platform_summary(p_business_id);
end;
$$;

-- An immutable quote, valid 15 minutes. Rules:
--   * nothing paid yet (legacy, or an ended subscription), or another
--     cadence: the target's whole price, a new period from the verified
--     payment;
--   * the same cadence, a higher price: now, prorated over the rest of the
--     current paid period (1 at least), effective at the verified payment;
--   * the same cadence, a lower or equal price (a downgrade): at the end of
--     the period, nothing due now; it takes effect at a renewal paid at the
--     new price.
-- billing_state_changed on a stale revision, a change already open or a
-- period already over; promo_unavailable for any code (none yet).
create function public.platform_quote_change(
  p_business_id uuid,
  p_target_plan text,
  p_target_cadence text,
  p_expected_revision integer,
  p_promo_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscription private.platform_subscriptions;
  v_target private.platform_price_versions;
  v_target_amount integer;
  v_current_amount integer := 0;
  v_due integer := 0;
  v_mode text;
  v_restarts boolean := false;
  v_effective_at timestamptz;
  v_next_at timestamptz;
  v_period_end timestamptz;
  v_id text := 'q_' || pg_catalog.translate(
    pg_catalog.encode(extensions.gen_random_bytes(12), 'base64'), '+/', '-_');
  v_remaining numeric;
begin
  perform private.platform_owner(p_business_id);
  if nullif(pg_catalog.btrim(p_promo_code), '') is not null then
    raise exception using errcode = 'P0001', message = 'promo_unavailable';
  end if;
  select * into v_target from private.platform_price_versions p
  where p.plan = p_target_plan and p.cadence = p_target_cadence and p.active;
  if v_target.id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'target';
  end if;
  v_subscription := private.platform_subscription(p_business_id, true);
  v_target_amount := private.platform_price_amount(v_target.id, p_business_id);
  if v_subscription.revision is distinct from p_expected_revision then
    raise exception using errcode = 'P0001', message = 'billing_state_changed';
  end if;
  if exists (
    select 1 from private.platform_change_commands c
    where c.business_id = p_business_id and c.status in ('requested', 'requires_action', 'scheduled')
  ) or (private.platform_effective_plan(p_business_id) = p_target_plan
        and v_subscription.cadence = p_target_cadence
        and v_subscription.source = 'billing' and v_subscription.state <> 'ended') then
    raise exception using errcode = 'P0001', message = 'billing_state_changed';
  end if;

  if v_subscription.price_version_id is not null then
    v_current_amount := private.platform_price_amount(v_subscription.price_version_id, p_business_id);
  end if;

  if v_subscription.source = 'legacy' or v_subscription.state = 'ended'
     or v_target.cadence <> v_subscription.cadence then
    v_mode := 'after_verified_payment';
    v_restarts := true;
    v_due := v_target_amount;
    v_next_at := pg_catalog.now() + private.platform_period(v_target.cadence);
  elsif v_subscription.state <> 'active' or v_subscription.current_period_end <= pg_catalog.now() then
    -- A period not paid or already over: renew first.
    raise exception using errcode = 'P0001', message = 'billing_state_changed';
  elsif v_target_amount > v_current_amount then
    v_mode := 'after_verified_payment';
    v_remaining := extract(epoch from v_subscription.current_period_end - pg_catalog.now())
      / extract(epoch from v_subscription.current_period_end - v_subscription.current_period_start);
    v_due := greatest(1, pg_catalog.round((v_target_amount - v_current_amount) * v_remaining)::integer);
    v_next_at := v_subscription.current_period_end;
    v_period_end := v_subscription.current_period_end;
  else
    v_mode := 'end_of_period';
    v_effective_at := v_subscription.current_period_end;
    v_next_at := v_subscription.current_period_end;
    v_period_end := v_subscription.current_period_end;
  end if;

  insert into private.platform_quotes (
    id, business_id, current_plan, current_cadence, target_price_version_id,
    due_now_minor, next_charge_at, next_charge_minor, recurring_minor, effective_mode,
    effective_at, restarts_period, period_end, subscription_revision, expires_at, created_by
  ) values (
    v_id, p_business_id, private.platform_effective_plan(p_business_id), v_subscription.cadence,
    v_target.id, v_due, v_next_at, v_target_amount, v_target_amount, v_mode,
    v_effective_at, v_restarts, v_period_end, v_subscription.revision,
    pg_catalog.now() + interval '15 minutes', (select auth.uid())
  );

  return pg_catalog.jsonb_build_object(
    'quoteId', v_id,
    'currency', v_target.currency,
    'current', pg_catalog.jsonb_build_object(
      'plan', private.platform_effective_plan(p_business_id), 'cadence', v_subscription.cadence),
    'target', pg_catalog.jsonb_build_object(
      'plan', v_target.plan, 'cadence', v_target.cadence, 'priceVersionId', v_target.id),
    'dueNowMinor', v_due,
    'nextCharge', pg_catalog.jsonb_build_object('at', v_next_at, 'amountMinor', v_target_amount),
    'recurring', pg_catalog.jsonb_build_object('amountMinor', v_target_amount, 'cadence', v_target.cadence),
    'effective', case v_mode
      when 'end_of_period' then pg_catalog.jsonb_build_object('mode', 'end_of_period', 'at', v_effective_at)
      else pg_catalog.jsonb_build_object('mode', 'after_verified_payment') end,
    'expiresAt', pg_catalog.now() + interval '15 minutes',
    'revision', v_subscription.revision,
    'simulated', true
  );
end;
$$;

-- Confirms a quote of hers: an immediate change waits for its verified
-- payment (`requested`; no right before); a change at the end of the
-- period is `scheduled`. quote_expired, billing_state_changed; replayed by
-- operationId.
create function public.platform_confirm_change(
  p_business_id uuid,
  p_quote_id text,
  p_expected_revision integer,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'quoteId', p_quote_id, 'expectedRevision', p_expected_revision);
  v_replay jsonb;
  v_subscription private.platform_subscriptions;
  v_quote private.platform_quotes;
  v_target private.platform_price_versions;
  v_command private.platform_change_commands;
begin
  perform private.platform_owner(p_business_id);
  v_replay := private.platform_replay(p_business_id, p_operation_id, 'confirm', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;

  v_subscription := private.platform_subscription(p_business_id, true);
  select * into v_quote from private.platform_quotes q
  where q.id = p_quote_id and q.business_id = p_business_id;
  if v_quote.id is null or v_quote.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'quote_expired';
  end if;
  if v_subscription.revision is distinct from p_expected_revision
     or v_quote.subscription_revision <> v_subscription.revision
     or exists (
       select 1 from private.platform_change_commands c
       where c.business_id = p_business_id and c.status in ('requested', 'requires_action', 'scheduled')
     ) then
    raise exception using errcode = 'P0001', message = 'billing_state_changed';
  end if;
  select * into v_target from private.platform_price_versions p where p.id = v_quote.target_price_version_id;

  insert into private.platform_change_commands (
    business_id, quote_id, operation_id, status, target_plan, target_cadence,
    target_price_version_id, due_now_minor, currency, effective_at, restarts_period,
    period_end, expires_at, created_by
  ) values (
    p_business_id, v_quote.id, p_operation_id,
    case v_quote.effective_mode when 'end_of_period' then 'scheduled' else 'requested' end,
    v_target.plan, v_target.cadence, v_target.id, v_quote.due_now_minor, v_target.currency,
    v_quote.effective_at, v_quote.restarts_period, v_quote.period_end,
    case v_quote.effective_mode when 'end_of_period' then null
         else pg_catalog.now() + interval '1 hour' end,
    (select auth.uid())
  )
  returning * into v_command;
  update private.platform_subscriptions s set revision = s.revision + 1
  where s.business_id = p_business_id;

  return private.platform_record(
    p_business_id, p_operation_id, 'confirm', v_payload, private.platform_command_dto(v_command)
  );
end;
$$;

-- Cancels her open change: a scheduled one, or one still waiting for its
-- payment (a payment arriving after is staged for reconciliation, never
-- applied).
create function public.platform_cancel_scheduled(
  p_business_id uuid,
  p_command_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object('commandId', p_command_id);
  v_replay jsonb;
begin
  perform private.platform_owner(p_business_id);
  v_replay := private.platform_replay(p_business_id, p_operation_id, 'cancel_scheduled', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform private.platform_subscription(p_business_id, true);
  update private.platform_change_commands c
  set status = 'cancelled', updated_at = pg_catalog.now()
  where c.id = p_command_id and c.business_id = p_business_id
    and c.status in ('requested', 'requires_action', 'scheduled');
  if not found then
    raise exception using errcode = 'P0001', message = 'billing_state_changed';
  end if;
  update private.platform_subscriptions s set revision = s.revision + 1
  where s.business_id = p_business_id;
  return private.platform_record(p_business_id, p_operation_id, 'cancel_scheduled', v_payload, 'null'::jsonb);
end;
$$;

-- At the end of the period: she keeps her plan until then.
create function public.platform_request_cancellation(
  p_business_id uuid,
  p_expected_revision integer,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object('expectedRevision', p_expected_revision);
  v_replay jsonb;
  v_subscription private.platform_subscriptions;
begin
  perform private.platform_owner(p_business_id);
  v_replay := private.platform_replay(p_business_id, p_operation_id, 'cancel', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  v_subscription := private.platform_subscription(p_business_id, true);
  if v_subscription.revision is distinct from p_expected_revision or v_subscription.cancel_at is not null
     or v_subscription.state = 'ended' then
    raise exception using errcode = 'P0001', message = 'billing_state_changed';
  end if;
  update private.platform_subscriptions s
  set cancel_at = s.current_period_end, cancel_requested_at = pg_catalog.now(), revision = s.revision + 1
  where s.business_id = p_business_id;
  return private.platform_record(
    p_business_id, p_operation_id, 'cancel', v_payload,
    pg_catalog.jsonb_build_object(
      'summary', private.platform_summary(p_business_id),
      'receiptId', p_operation_id
    )
  );
end;
$$;

create function public.platform_undo_cancellation(
  p_business_id uuid,
  p_expected_revision integer,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object('expectedRevision', p_expected_revision);
  v_replay jsonb;
  v_subscription private.platform_subscriptions;
begin
  perform private.platform_owner(p_business_id);
  v_replay := private.platform_replay(p_business_id, p_operation_id, 'undo_cancel', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  v_subscription := private.platform_subscription(p_business_id, true);
  if v_subscription.revision is distinct from p_expected_revision or v_subscription.cancel_at is null
     or v_subscription.cancel_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'billing_state_changed';
  end if;
  update private.platform_subscriptions s
  set cancel_at = null, cancel_requested_at = null, revision = s.revision + 1
  where s.business_id = p_business_id;
  return private.platform_record(
    p_business_id, p_operation_id, 'undo_cancel', v_payload, private.platform_summary(p_business_id)
  );
end;
$$;

create function public.platform_list_invoices(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.platform_owner(p_business_id);
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'invoiceId', i.id, 'periodStart', i.period_start, 'periodEnd', i.period_end,
      'status', i.status, 'amountMinor', i.amount_minor, 'currency', i.currency,
      'simulated', i.simulated
    ) order by i.period_start desc, i.id)
    from private.platform_invoices i where i.business_id = p_business_id
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Billing events (the service only, after the webhook's authentication)
-- ---------------------------------------------------------------------------

-- Applies a verified change: the plan goes to the site (the authority).
-- A first payment or a new cadence starts a new paid period now; otherwise
-- the current one goes on (an upgrade within it, a downgrade at its
-- renewal, which already moved the period).
create function private.platform_apply(p_command private.platform_change_commands, p_event_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.set_site_plan(p_command.business_id, p_command.target_plan);
  update private.platform_subscriptions s
  set plan = p_command.target_plan,
      cadence = p_command.target_cadence,
      price_version_id = p_command.target_price_version_id,
      source = 'billing',
      state = 'active',
      grace_until = null,
      cancel_at = null,
      cancel_requested_at = null,
      current_period_start = case when p_command.restarts_period
                                  then pg_catalog.now() else s.current_period_start end,
      current_period_end = case when p_command.restarts_period
                                then pg_catalog.now() + private.platform_period(p_command.target_cadence)
                                else s.current_period_end end,
      revision = s.revision + 1
  where s.business_id = p_command.business_id;
  update private.platform_change_commands c
  set status = 'applied', updated_at = pg_catalog.now()
  where c.id = p_command.id;
end;
$$;

revoke all on function private.platform_apply(private.platform_change_commands, text) from public;

-- One billing event, recorded once (by eventId). Kinds:
--   payment_succeeded {commandId, amountMinor, currency?}: the payment of
--     an open immediate change, verified: applied (rights move), invoice
--     issued. Applied only if the amount (and currency) are the quote's and,
--     for a prorated upgrade, the period is still the one it was computed
--     on; a payment for a change no longer open (cancelled, lapsed,
--     failed) or that does not match is staged for reconciliation, never
--     applied.
--   payment_failed {commandId}: the change fails; rights unchanged.
--   renewal_succeeded {businessId, amountMinor, currency?}: a new period of
--     a paying subscription, at its price, or at the new price of the
--     downgrade scheduled for this renewal (then applied); anything else is
--     rejected. A subscription that pays nothing (legacy, ended) is staged.
--   renewal_failed {businessId, graceDays}: past_due, rights kept until
--     the grace ends.
-- `sourceVersion` orders the events of one object (command or
-- subscription): an older one is ignored. Answers the outcome.
create function public.platform_ingest_event(p_event jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id text := p_event ->> 'eventId';
  v_kind text := p_event ->> 'kind';
  v_currency text := coalesce(p_event ->> 'currency', 'EUR');
  v_version integer;
  v_command private.platform_change_commands;
  v_subscription private.platform_subscriptions;
  v_business uuid;
  v_outcome text;
  v_amount integer;
  v_price integer;
begin
  if v_event_id is null or v_kind is null
     or v_kind not in ('payment_succeeded', 'payment_failed', 'renewal_succeeded', 'renewal_failed') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'event';
  end if;
  begin
    v_version := coalesce((p_event ->> 'sourceVersion')::integer, 0);
    v_amount := (p_event ->> 'amountMinor')::integer;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'event';
  end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing_event:' || v_event_id, 0));
  if exists (select 1 from private.platform_billing_events e where e.event_id = v_event_id) then
    return (select e.outcome from private.platform_billing_events e where e.event_id = v_event_id);
  end if;

  if v_kind in ('payment_succeeded', 'payment_failed') then
    begin
      select * into v_command from private.platform_change_commands c
      where c.id = (p_event ->> 'commandId')::uuid;
    exception when invalid_text_representation then
      v_command := null;
    end;
    if v_command.id is not null then
      -- Lock order: the subscription, then the command (as the owner's
      -- actions).
      select * into v_subscription from private.platform_subscriptions s
      where s.business_id = v_command.business_id for update;
      select * into v_command from private.platform_change_commands c
      where c.id = v_command.id for update;
    end if;
    if v_command.id is null then
      v_outcome := 'staged';
    elsif v_version <= v_command.source_version then
      v_outcome := 'ignored_stale';
    elsif v_command.status not in ('requested', 'requires_action') then
      -- Money for a change no longer open: reconcile, never apply.
      v_outcome := case when v_kind = 'payment_succeeded' then 'staged' else 'ignored_stale' end;
    elsif v_kind = 'payment_failed' then
      update private.platform_change_commands c
      set status = 'failed', source_version = v_version, updated_at = pg_catalog.now()
      where c.id = v_command.id;
      update private.platform_subscriptions s set revision = s.revision + 1
      where s.business_id = v_command.business_id;
      v_outcome := 'applied';
    elsif v_amount is distinct from v_command.due_now_minor or v_currency <> v_command.currency
          or (not v_command.restarts_period
              and v_subscription.current_period_end is distinct from v_command.period_end) then
      -- Not the payment of this quote, or its period moved: nothing granted.
      v_outcome := 'staged';
    else
      update private.platform_change_commands c set source_version = v_version where c.id = v_command.id;
      perform private.platform_apply(v_command, v_event_id);
      select * into v_subscription from private.platform_subscriptions s
      where s.business_id = v_command.business_id;
      insert into private.platform_invoices (
        business_id, event_id, period_start, period_end, status, amount_minor, currency
      ) values (
        v_command.business_id, v_event_id, pg_catalog.now(), v_subscription.current_period_end,
        'issued', v_amount, v_currency
      );
      v_outcome := 'applied';
    end if;
  else
    begin
      v_business := (p_event ->> 'businessId')::uuid;
    exception when invalid_text_representation then
      v_business := null;
    end;
    select * into v_subscription from private.platform_subscriptions s
    where s.business_id = v_business for update;
    if v_subscription.business_id is null or v_subscription.source <> 'billing'
       or v_subscription.state = 'ended' then
      v_outcome := 'staged';
    elsif v_version <= v_subscription.source_version then
      v_outcome := 'ignored_stale';
    elsif v_kind = 'renewal_failed' then
      update private.platform_subscriptions s
      set state = 'past_due', source_version = v_version,
          grace_until = s.current_period_end
            + pg_catalog.make_interval(days => least(greatest(coalesce((p_event ->> 'graceDays')::integer, 7), 0), 30)),
          revision = s.revision + 1
      where s.business_id = v_business;
      v_outcome := 'applied';
    else
      -- The downgrade scheduled for this renewal, if any: the renewal is
      -- paid at its price.
      select * into v_command from private.platform_change_commands c
      where c.business_id = v_business and c.status = 'scheduled'
        and c.effective_at <= v_subscription.current_period_end
      for update;
      v_price := private.platform_price_amount(
        coalesce(v_command.target_price_version_id, v_subscription.price_version_id), v_business);
      if v_amount is distinct from v_price or v_currency <> 'EUR' then
        v_outcome := 'rejected';
      else
        update private.platform_subscriptions s
        set state = 'active', grace_until = null, source_version = v_version,
            current_period_start = s.current_period_end,
            current_period_end = s.current_period_end + private.platform_period(s.cadence),
            revision = s.revision + 1
        where s.business_id = v_business;
        if v_command.id is not null then
          perform private.platform_apply(v_command, v_event_id);
        end if;
        insert into private.platform_invoices (
          business_id, event_id, period_start, period_end, status, amount_minor, currency
        )
        select v_business, v_event_id, s.current_period_start, s.current_period_end, 'issued',
          v_amount, v_currency
        from private.platform_subscriptions s where s.business_id = v_business;
        v_outcome := 'applied';
      end if;
    end if;
  end if;

  insert into private.platform_billing_events (event_id, kind, payload, outcome)
  values (v_event_id, v_kind, p_event, v_outcome);
  return v_outcome;
end;
$$;

-- The clock's work (the service only, from a cron): requests whose payment
-- never came lapse; cancellations and grace periods that ended end the
-- subscription (her plan returns to Core, her data stays, and she starts
-- again from a first payment).
create function public.platform_run_due()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lapsed integer;
  v_ended integer;
begin
  with lapsed as (
    update private.platform_change_commands c
    set status = 'failed', updated_at = pg_catalog.now()
    where c.status in ('requested', 'requires_action') and c.expires_at <= pg_catalog.now()
    returning c.id
  )
  select pg_catalog.count(*) into v_lapsed from lapsed;

  with ended as (
    update private.platform_subscriptions s
    set state = 'ended', plan = 'core', price_version_id = null, source = 'legacy',
        cancel_at = null, grace_until = null, revision = s.revision + 1
    where s.state <> 'ended' and (
      (s.cancel_at is not null and s.cancel_at <= pg_catalog.now())
      or (s.state = 'past_due' and s.grace_until <= pg_catalog.now())
    )
    returning s.business_id
  )
  select pg_catalog.count(*) into v_ended from ended;
  perform public.set_site_plan(s.business_id, 'core')
  from private.platform_subscriptions s
  join public.sites si on si.business_id = s.business_id
  where s.state = 'ended' and si.plan <> 'core';

  update private.platform_change_commands c
  set status = 'cancelled', updated_at = pg_catalog.now()
  where c.status = 'scheduled' and exists (
    select 1 from private.platform_subscriptions s
    where s.business_id = c.business_id and s.state = 'ended'
  );

  return pg_catalog.jsonb_build_object('lapsed', v_lapsed, 'ended', v_ended);
end;
$$;

revoke all on function public.platform_list_offers() from public;
grant execute on function public.platform_list_offers() to anon, authenticated, service_role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.platform_billing_summary(uuid)',
    'public.platform_quote_change(uuid, text, text, integer, text)',
    'public.platform_confirm_change(uuid, text, integer, uuid)',
    'public.platform_cancel_scheduled(uuid, uuid, uuid)',
    'public.platform_request_cancellation(uuid, integer, uuid)',
    'public.platform_undo_cancellation(uuid, integer, uuid)',
    'public.platform_list_invoices(uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.platform_ingest_event(jsonb)',
    'public.platform_run_due()'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
