-- Foundational schema only. Business workflows and public RPCs are added in
-- later vertical migrations so each behavior can be reviewed and tested.

create extension if not exists btree_gist with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.business_member_role as enum ('owner', 'admin');
create type public.appointment_status as enum (
  'confirmed',
  'completed',
  'cancelled',
  'no_show'
);
create type public.availability_exception_kind as enum (
  'closed',
  'blocked',
  'open_override'
);
create type public.loyalty_accrual_mode as enum ('appointment', 'spend');
create type public.loyalty_event_type as enum (
  'appointment_completed',
  'manual_adjustment',
  'reward_redeemed',
  'correction'
);
create type public.reward_type as enum (
  'percentage_discount',
  'fixed_discount',
  'free_service'
);
create type public.email_event_type as enum (
  'booking_confirmation',
  'appointment_reminder',
  'appointment_changed',
  'appointment_cancelled',
  'points_earned',
  'reward_unlocked',
  'reactivation'
);
create type public.email_event_status as enum (
  'pending',
  'processing',
  'sent',
  'failed',
  'cancelled'
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  first_name text,
  last_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug extensions.citext not null unique
    check (slug::text ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text check (description is null or char_length(description) <= 1000),
  contact_email extensions.citext not null,
  location text,
  logo_path text,
  timezone text not null default 'Europe/Paris',
  cancellation_policy text,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.business_member_role not null default 'owner',
  created_at timestamptz not null default now(),
  unique (business_id, user_id)
);

create index business_members_user_id_idx
  on public.business_members (user_id, business_id);

create table public.business_settings (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  currency text not null default 'EUR'
    check (currency ~ '^[A-Z]{3}$'),
  slot_interval_minutes integer not null default 15
    check (slot_interval_minutes between 5 and 120),
  buffer_minutes integer not null default 0
    check (buffer_minutes between 0 and 240),
  minimum_booking_notice_minutes integer not null default 120
    check (minimum_booking_notice_minutes between 0 and 10080),
  maximum_booking_advance_days integer not null default 90
    check (maximum_booking_advance_days between 1 and 365),
  reactivation_after_days integer not null default 60
    check (reactivation_after_days in (30, 45, 60, 90)),
  automatic_reactivation_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  duration_minutes integer not null check (duration_minutes between 5 and 720),
  price_cents integer not null check (price_cents >= 0),
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id)
);

create index services_business_active_order_idx
  on public.services (business_id, active, display_order, name);

create table public.business_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  starts_at time not null,
  ends_at time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at),
  unique (business_id, weekday, starts_at)
);

create index business_hours_lookup_idx
  on public.business_hours (business_id, weekday, starts_at);

create table public.availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind public.availability_exception_kind not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at)
);

create index availability_exceptions_lookup_idx
  on public.availability_exceptions (business_id, starts_at, ends_at);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  first_name text not null check (char_length(first_name) between 1 and 120),
  last_name text,
  email extensions.citext not null,
  phone text,
  internal_notes text,
  loyalty_token_hash text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, email),
  unique (id, business_id)
);

create index clients_business_name_idx
  on public.clients (business_id, last_name, first_name);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_id uuid not null,
  service_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  booking_window tstzrange generated always as (
    tstzrange(starts_at, ends_at, '[)')
  ) stored,
  status public.appointment_status not null default 'confirmed',
  service_name_snapshot text not null,
  duration_minutes_snapshot integer not null
    check (duration_minutes_snapshot between 5 and 720),
  price_cents_snapshot integer not null check (price_cents_snapshot >= 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  internal_notes text,
  cancellation_reason text,
  completed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at),
  unique (id, business_id),
  foreign key (client_id, business_id)
    references public.clients (id, business_id),
  foreign key (service_id, business_id)
    references public.services (id, business_id),
  constraint appointments_no_overlapping_confirmed exclude using gist (
    business_id with =,
    booking_window with &&
  ) where (status = 'confirmed')
);

create index appointments_business_starts_at_idx
  on public.appointments (business_id, starts_at);
create index appointments_client_starts_at_idx
  on public.appointments (business_id, client_id, starts_at desc);
create index appointments_upcoming_idx
  on public.appointments (business_id, starts_at)
  where status = 'confirmed';

create table public.loyalty_programs (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  active boolean not null default true,
  accrual_mode public.loyalty_accrual_mode not null default 'appointment',
  points_per_completed_appointment integer not null default 1
    check (points_per_completed_appointment > 0),
  points_per_euro numeric(10, 4) check (points_per_euro is null or points_per_euro > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (accrual_mode = 'appointment' and points_per_euro is null)
    or (accrual_mode = 'spend' and points_per_euro is not null)
  )
);

create table public.loyalty_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_id uuid not null,
  appointment_id uuid,
  type public.loyalty_event_type not null,
  points_delta integer not null check (points_delta <> 0),
  reason text not null check (char_length(reason) between 1 and 500),
  idempotency_key text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, idempotency_key),
  unique (id, business_id),
  foreign key (client_id, business_id)
    references public.clients (id, business_id),
  foreign key (appointment_id, business_id)
    references public.appointments (id, business_id)
);

create unique index loyalty_events_completed_appointment_once_idx
  on public.loyalty_events (business_id, appointment_id)
  where type = 'appointment_completed';
create index loyalty_events_client_ledger_idx
  on public.loyalty_events (business_id, client_id, created_at, id);

create table public.rewards (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  points_required integer not null check (points_required > 0),
  reward_type public.reward_type not null,
  reward_value integer,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  check (
    (reward_type = 'free_service' and reward_value is null)
    or (reward_type <> 'free_service' and reward_value is not null and reward_value > 0)
  )
);

create index rewards_business_active_points_idx
  on public.rewards (business_id, active, points_required);

create table public.reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  reward_id uuid not null,
  client_id uuid not null,
  appointment_id uuid,
  loyalty_event_id uuid not null,
  points_spent integer not null check (points_spent > 0),
  redeemed_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  unique (loyalty_event_id, business_id),
  foreign key (reward_id, business_id)
    references public.rewards (id, business_id),
  foreign key (client_id, business_id)
    references public.clients (id, business_id),
  foreign key (appointment_id, business_id)
    references public.appointments (id, business_id),
  foreign key (loyalty_event_id, business_id)
    references public.loyalty_events (id, business_id)
);

create index reward_redemptions_client_idx
  on public.reward_redemptions (business_id, client_id, redeemed_at desc);

create table public.email_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_id uuid,
  appointment_id uuid,
  type public.email_event_type not null,
  recipient_email extensions.citext not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status public.email_event_status not null default 'pending',
  scheduled_for timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, dedupe_key),
  foreign key (client_id, business_id)
    references public.clients (id, business_id),
  foreign key (appointment_id, business_id)
    references public.appointments (id, business_id)
);

create index email_events_worker_idx
  on public.email_events (status, scheduled_for)
  where status in ('pending', 'failed');

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles',
    'businesses',
    'business_settings',
    'services',
    'business_hours',
    'availability_exceptions',
    'clients',
    'appointments',
    'loyalty_programs',
    'rewards',
    'email_events'
  ]
  loop
    execute format(
      'create trigger set_%1$s_updated_at before update on public.%1$I '
      'for each row execute function public.set_updated_at()',
      table_name
    );
  end loop;
end;
$$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, first_name, last_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_business_member(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members
    where business_id = target_business_id
      and user_id = (select auth.uid())
  );
$$;

create function public.has_business_role(
  target_business_id uuid,
  accepted_roles public.business_member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members
    where business_id = target_business_id
      and user_id = (select auth.uid())
      and role = any (accepted_roles)
  );
$$;

revoke all on function public.set_updated_at() from public;
revoke all on function public.handle_new_user() from public;
revoke all on function public.is_business_member(uuid) from public;
revoke all on function public.has_business_role(uuid, public.business_member_role[]) from public;
grant execute on function public.is_business_member(uuid) to authenticated;
grant execute on function public.has_business_role(uuid, public.business_member_role[]) to authenticated;

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.business_settings enable row level security;
alter table public.services enable row level security;
alter table public.business_hours enable row level security;
alter table public.availability_exceptions enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;
alter table public.loyalty_programs enable row level security;
alter table public.loyalty_events enable row level security;
alter table public.rewards enable row level security;
alter table public.reward_redemptions enable row level security;
alter table public.email_events enable row level security;

create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "profiles_insert_own"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "businesses_select_member"
  on public.businesses for select to authenticated
  using (public.is_business_member(id));
create policy "businesses_update_owner"
  on public.businesses for update to authenticated
  using (public.has_business_role(id, array['owner']::public.business_member_role[]))
  with check (public.has_business_role(id, array['owner']::public.business_member_role[]));
create policy "business_members_select_member"
  on public.business_members for select to authenticated
  using (public.is_business_member(business_id));

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'business_settings',
    'services',
    'business_hours',
    'availability_exceptions',
    'clients',
    'loyalty_programs',
    'rewards'
  ]
  loop
    execute format(
      'create policy %1$I on public.%2$I for select to authenticated '
      'using (public.is_business_member(business_id))',
      table_name || '_select_member',
      table_name
    );
    execute format(
      'create policy %1$I on public.%2$I for insert to authenticated '
      'with check (public.is_business_member(business_id))',
      table_name || '_insert_member',
      table_name
    );
    execute format(
      'create policy %1$I on public.%2$I for update to authenticated '
      'using (public.is_business_member(business_id)) '
      'with check (public.is_business_member(business_id))',
      table_name || '_update_member',
      table_name
    );
    execute format(
      'create policy %1$I on public.%2$I for delete to authenticated '
      'using (public.is_business_member(business_id))',
      table_name || '_delete_member',
      table_name
    );
  end loop;
end;
$$;

-- Appointment transitions, loyalty entries, redemptions and email outbox
-- mutations are intentionally denied to authenticated clients. Later
-- migrations expose narrow transaction functions for those workflows.
create policy "appointments_select_member"
  on public.appointments for select to authenticated
  using (public.is_business_member(business_id));
create policy "loyalty_events_select_member"
  on public.loyalty_events for select to authenticated
  using (public.is_business_member(business_id));
create policy "reward_redemptions_select_member"
  on public.reward_redemptions for select to authenticated
  using (public.is_business_member(business_id));
create policy "email_events_select_member"
  on public.email_events for select to authenticated
  using (public.is_business_member(business_id));

comment on table public.loyalty_events is
  'Immutable source of truth for loyalty balances; corrections are compensating events.';
comment on table public.email_events is
  'Transactional email outbox. dedupe_key identifies one logical delivery.';
comment on constraint appointments_no_overlapping_confirmed
  on public.appointments is
  'Prevents overlapping confirmed appointments within one business.';
