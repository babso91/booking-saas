-- Professional onboarding: one transactional, idempotent RPC that turns a
-- Supabase Auth user into the owner of a ready-to-configure business.
--
-- Identity always comes from auth.uid(); no function takes a user id.
-- Final guarantees are database constraints:
--   * businesses.slug unique (existing), format, length and reserved words;
--   * business_onboardings.user_id primary key: onboarding happens at most
--     once per user, without restricting how many businesses the data model
--     allows a user to belong to.
-- A per-user advisory lock turns a double submission into a clean
-- `already_onboarded` instead of a constraint error, but correctness never
-- depends on it (nor on the isolation level).

create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------------
-- Schema additions required by the onboarding contract
-- ---------------------------------------------------------------------------

alter table public.businesses
  add column phone text
    check (phone is null or phone ~ '^\+?[0-9 ().-]{6,30}$');

-- Public slugs: 3 to 63 characters, never a route or reserved word.
alter table public.businesses
  add constraint businesses_slug_length
    check (char_length(slug::text) between 3 and 63),
  add constraint businesses_slug_not_reserved
    check (slug::text <> all (array[
      'account', 'admin', 'api', 'app', 'auth', 'b', 'dashboard', 'help',
      'login', 'logout', 'onboarding', 'register', 'settings', 'signin',
      'signup', 'support', 'www'
    ]));

-- Idempotence record of the onboarding RPC: one row per user, ever.
create table public.business_onboardings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  business_id uuid not null unique references public.businesses (id) on delete cascade,
  completed_at timestamptz not null default now()
);

alter table public.business_onboardings enable row level security;

-- Readable by its user; written only by complete_onboarding (SECURITY DEFINER).
revoke all on public.business_onboardings from anon, authenticated;
grant select on public.business_onboardings to authenticated;

create policy business_onboardings_select_own
  on public.business_onboardings for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Slug normalisation (the only implementation; the UI asks the server)
-- ---------------------------------------------------------------------------

-- Deterministic: unaccent → lower case → any run of characters outside
-- [a-z0-9] becomes one hyphen → trimmed hyphens → at most 63 characters.
-- "  Studio Mila Lashes ! " → "studio-mila-lashes"; "Écrin d'Éva" → "ecrin-d-eva".
create function private.normalize_slug(p_value text)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.btrim(
    pg_catalog.left(
      pg_catalog.btrim(
        pg_catalog.regexp_replace(
          pg_catalog.lower(
            extensions.unaccent(
              'extensions.unaccent'::regdictionary,
              coalesce(p_value, '')
            )
          ),
          '[^a-z0-9]+',
          '-',
          'g'
        ),
        '-'
      ),
      63
    ),
    '-'
  );
$$;

create function private.is_reserved_slug(p_slug text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_slug = any (array[
    'account', 'admin', 'api', 'app', 'auth', 'b', 'dashboard', 'help',
    'login', 'logout', 'onboarding', 'register', 'settings', 'signin',
    'signup', 'support', 'www'
  ]);
$$;

revoke all on function private.normalize_slug(text) from public;
revoke all on function private.is_reserved_slug(text) from public;

-- ---------------------------------------------------------------------------
-- Slug availability (UX only; never replaces the unique constraint)
-- ---------------------------------------------------------------------------

create function public.check_slug_availability(p_slug text)
returns table (slug text, available boolean, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_slug text := private.normalize_slug(p_slug);
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;

  if pg_catalog.char_length(v_slug) < 3 then
    return query select v_slug, false, 'invalid'::text;
  elsif private.is_reserved_slug(v_slug) then
    return query select v_slug, false, 'reserved'::text;
  elsif exists (
    select 1 from public.businesses b
    where b.slug operator(extensions.=) v_slug::extensions.citext
  ) then
    return query select v_slug, false, 'taken'::text;
  else
    return query select v_slug, true, 'available'::text;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------

-- Creates, in one transaction and for auth.uid() only:
--   profile (upsert of first/last name) → business → business_settings (via
--   the existing trigger, then updated with the booking rules) → owner
--   membership → default loyalty program → onboarding record.
-- Any error rolls everything back. Errors are stable messages:
--   unauthenticated, already_onboarded, slug_taken, slug_reserved,
--   invalid_input (HINT = field name), invalid_timezone.
create function public.complete_onboarding(
  p_first_name text,
  p_last_name text,
  p_business_name text,
  p_slug text,
  p_timezone text default 'Europe/Paris',
  p_description text default null,
  p_contact_email text default null,
  p_phone text default null,
  p_location text default null,
  p_cancellation_policy text default null,
  p_minimum_booking_notice_minutes integer default 120,
  p_maximum_booking_advance_days integer default 90,
  p_buffer_minutes integer default 0
)
returns table (business_id uuid, slug text, business_name text, timezone text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_first_name text := pg_catalog.btrim(p_first_name);
  v_last_name text := pg_catalog.btrim(p_last_name);
  v_business_name text := pg_catalog.btrim(p_business_name);
  v_slug text := private.normalize_slug(p_slug);
  v_timezone text := coalesce(nullif(pg_catalog.btrim(p_timezone), ''), 'Europe/Paris');
  v_description text := nullif(pg_catalog.btrim(p_description), '');
  v_email text := pg_catalog.lower(nullif(pg_catalog.btrim(p_contact_email), ''));
  v_phone text := nullif(pg_catalog.btrim(p_phone), '');
  v_location text := nullif(pg_catalog.btrim(p_location), '');
  v_policy text := nullif(pg_catalog.btrim(p_cancellation_policy), '');
  v_business_id uuid;
  v_constraint text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;

  -- Serialises submissions of the same user: a double click or a retry
  -- waits for the first call, then sees its membership (READ COMMITTED) and
  -- gets `already_onboarded`. The business_onboardings primary key stays the
  -- final guard.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('onboarding:' || v_user_id::text, 0)
  );

  -- Already onboarded, or already member of a business created otherwise.
  if exists (
    select 1 from public.business_onboardings o where o.user_id = v_user_id
  ) or exists (
    select 1 from public.business_members m where m.user_id = v_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'already_onboarded';
  end if;

  -- Input validation (mirrors the Zod contract; the database re-checks).
  if v_first_name is null or pg_catalog.char_length(v_first_name) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'firstName';
  end if;
  if v_last_name is null or pg_catalog.char_length(v_last_name) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'lastName';
  end if;
  if v_business_name is null or pg_catalog.char_length(v_business_name) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'businessName';
  end if;
  if pg_catalog.char_length(v_slug) < 3 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'slug';
  end if;
  if private.is_reserved_slug(v_slug) then
    raise exception using errcode = 'P0001', message = 'slug_reserved', hint = 'slug';
  end if;
  if v_description is not null and pg_catalog.char_length(v_description) > 1000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'description';
  end if;
  if v_location is not null and pg_catalog.char_length(v_location) > 200 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'location';
  end if;
  if v_policy is not null and pg_catalog.char_length(v_policy) > 2000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'cancellationPolicy';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'phone';
  end if;
  if p_minimum_booking_notice_minutes is null
    or p_minimum_booking_notice_minutes not between 0 and 10080 then
    raise exception using errcode = '22023', message = 'invalid_input',
      hint = 'minimumBookingNoticeMinutes';
  end if;
  if p_maximum_booking_advance_days is null
    or p_maximum_booking_advance_days not between 1 and 365 then
    raise exception using errcode = '22023', message = 'invalid_input',
      hint = 'maximumBookingAdvanceDays';
  end if;
  if p_buffer_minutes is null or p_buffer_minutes not between 0 and 240 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'bufferMinutes';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = v_timezone
  ) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'timezone';
  end if;

  -- The professional email defaults to the account email.
  if v_email is null then
    select pg_catalog.lower(u.email) into v_email
    from auth.users u where u.id = v_user_id;
  end if;
  if v_email is null
    or pg_catalog.char_length(v_email) > 254
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'contactEmail';
  end if;

  begin
    insert into public.profiles (id, first_name, last_name)
    values (v_user_id, v_first_name, v_last_name)
    on conflict (id) do update
      set first_name = excluded.first_name,
          last_name = excluded.last_name;

    insert into public.businesses (
      name, slug, description, contact_email, phone, location, timezone,
      cancellation_policy, created_by
    )
    values (
      v_business_name, v_slug, v_description, v_email, v_phone, v_location,
      v_timezone, v_policy, v_user_id
    )
    returning id into v_business_id;

    -- business_settings is created by trigger with the platform defaults.
    update public.business_settings
    set minimum_booking_notice_minutes = p_minimum_booking_notice_minutes,
        maximum_booking_advance_days = p_maximum_booking_advance_days,
        buffer_minutes = p_buffer_minutes
    where business_settings.business_id = v_business_id;

    insert into public.business_members (business_id, user_id, role)
    values (v_business_id, v_user_id, 'owner');

    -- Default program: 1 point per completed appointment.
    insert into public.loyalty_programs (business_id)
    values (v_business_id);

    -- Idempotence record, last: its primary key is the final guarantee.
    insert into public.business_onboardings (user_id, business_id)
    values (v_user_id, v_business_id);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'businesses_slug_key' then
        raise exception using errcode = 'P0001', message = 'slug_taken', hint = 'slug';
      elsif v_constraint = 'business_onboardings_pkey' then
        raise exception using errcode = 'P0001', message = 'already_onboarded';
      end if;
      raise;
  end;

  return query
  select v_business_id, v_slug, v_business_name, v_timezone;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: signed-in users only
-- ---------------------------------------------------------------------------

revoke all on function public.check_slug_availability(text) from public, anon;
revoke all on function public.complete_onboarding(
  text, text, text, text, text, text, text, text, text, text, integer, integer, integer
) from public, anon;

grant execute on function public.check_slug_availability(text) to authenticated;
grant execute on function public.complete_onboarding(
  text, text, text, text, text, text, text, text, text, text, integer, integer, integer
) to authenticated;
