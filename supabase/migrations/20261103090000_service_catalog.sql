-- The catalogue: categories, services and their options, as business data.
--
-- Additive. Existing services keep their ids, columns and behaviour; a
-- service without category nor options is booked exactly as before, and
-- every appointment already booked keeps its snapshots untouched.
--
--   * public.service_categories: her categories (none imposed, none
--     required), in her order, visible or hidden on her public pages.
--   * public.services.category_id: optional; deleting a category keeps its
--     services, without a category.
--   * public.service_options / public.service_option_choices: groups of
--     answers asked when booking (one answer per group in V1), each answer
--     with a price and a duration added to the service's. A group is
--     required (an answer must be given) or optional (no answer: nothing
--     added). Nothing is specific to a trade.
--   * public.appointments.options_snapshot: the answers chosen, with their
--     labels and amounts at booking time. price_cents_snapshot and
--     duration_minutes_snapshot are now the totals (service plus answers).
--     A later change of the catalogue never rewrites an appointment.
--
-- One rule for price and duration, private.quote_options, used by every
-- path that books or edits: public slots, public booking, the agenda's
-- creation and edition. The browser never decides a price or a duration.
--
-- Concurrency: every write to the options or to a category's visibility
-- takes the business schedule lock (private.lock_business_schedule), as
-- bookings do: a booking either sees the catalogue before a change, or the
-- change waits for it to commit. Options are written only through
-- public.set_service_options (no DML grant).

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

create table public.service_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (
    char_length(name) between 1 and 60 and name = btrim(name)
  ),
  visible boolean not null default true,
  display_order integer not null default 0,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id)
);

create index service_categories_business_order_idx
  on public.service_categories (business_id, display_order, name);

create function private.set_category_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  elsif (new.business_id, new.name, new.visible)
    is distinct from (old.business_id, old.name, old.visible) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

revoke all on function private.set_category_version() from public;

create trigger service_categories_version
  before insert or update on public.service_categories
  for each row execute function private.set_category_version();

create trigger set_service_categories_updated_at
  before update on public.service_categories
  for each row execute function public.set_updated_at();

alter table public.service_categories enable row level security;

create policy service_categories_select_member
  on public.service_categories for select to authenticated
  using (public.is_business_member(business_id));

-- Written through the functions below only (they take the schedule lock).
revoke all on public.service_categories from public, anon, authenticated;
grant select on public.service_categories to authenticated;

-- ---------------------------------------------------------------------------
-- Services: optional category, options revision
-- ---------------------------------------------------------------------------

alter table public.services
  add column category_id uuid,
  -- Bumped by set_service_options: a change of the options is a change of
  -- the service (its version), for the editors' compare and swap.
  add column options_revision integer not null default 0,
  add constraint services_category_fkey
    foreign key (category_id, business_id)
    references public.service_categories (id, business_id)
    on delete set null (category_id);

create index services_category_idx
  on public.services (category_id)
  where category_id is not null;

create or replace function private.set_service_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  elsif (
    new.business_id, new.name, new.description, new.duration_minutes,
    new.price_cents, new.active, new.category_id, new.options_revision
  ) is distinct from (
    old.business_id, old.name, old.description, old.duration_minutes,
    old.price_cents, old.active, old.category_id, old.options_revision
  ) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Options and their answers
-- ---------------------------------------------------------------------------

create table public.service_options (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  service_id uuid not null,
  question text not null check (
    char_length(question) between 1 and 120 and question = btrim(question)
  ),
  -- Required: an answer must be given. Optional: no answer adds nothing.
  required boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (service_id, business_id)
    references public.services (id, business_id) on delete cascade
);

create index service_options_service_idx
  on public.service_options (service_id, display_order);

create table public.service_option_choices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  option_id uuid not null,
  label text not null check (
    char_length(label) between 1 and 60 and label = btrim(label)
  ),
  price_delta_cents integer not null default 0
    check (price_delta_cents between 0 and 9999999),
  duration_delta_minutes integer not null default 0
    check (duration_delta_minutes between 0 and 240),
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (option_id, business_id)
    references public.service_options (id, business_id) on delete cascade
);

create index service_option_choices_option_idx
  on public.service_option_choices (option_id, display_order);

alter table public.service_options enable row level security;
alter table public.service_option_choices enable row level security;

create policy service_options_select_member
  on public.service_options for select to authenticated
  using (public.is_business_member(business_id));

create policy service_option_choices_select_member
  on public.service_option_choices for select to authenticated
  using (public.is_business_member(business_id));

revoke all on public.service_options from public, anon, authenticated;
revoke all on public.service_option_choices from public, anon, authenticated;
grant select on public.service_options to authenticated;
grant select on public.service_option_choices to authenticated;

-- The longest a service can last with its options (each group's longest
-- answer): never more than 720 minutes, the limit of an appointment.
create function private.service_longest_minutes(
  p_service_id uuid,
  p_base_minutes integer
)
returns integer
language sql
stable
set search_path = ''
as $$
  select p_base_minutes + coalesce(sum(longest), 0)::integer
  from (
    select max(c.duration_delta_minutes) as longest
    from public.service_options o
    join public.service_option_choices c on c.option_id = o.id
    where o.service_id = p_service_id
    group by o.id
  ) groups;
$$;

revoke all on function private.service_longest_minutes(uuid, integer) from public;

-- The highest price the service can be booked at (each group's dearest
-- answer), in bigint: it must fit an appointment's price (integer).
create function private.service_highest_price(
  p_service_id uuid,
  p_base_cents bigint
)
returns bigint
language sql
stable
set search_path = ''
as $$
  select p_base_cents + coalesce(sum(dearest), 0)::bigint
  from (
    select max(c.price_delta_cents)::bigint as dearest
    from public.service_options o
    join public.service_option_choices c on c.option_id = o.id
    where o.service_id = p_service_id
    group by o.id
  ) groups;
$$;

revoke all on function private.service_highest_price(uuid, bigint) from public;

-- SECURITY DEFINER: a member updates her services directly (RLS); the
-- check reads her options with the owner's rights.
create function private.check_service_longest()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.service_longest_minutes(new.id, new.duration_minutes) > 720 then
    raise exception using
      errcode = '22023',
      message = 'duration_too_long',
      hint = 'durationMinutes';
  end if;
  -- A price that, with her dearest answers, an appointment could not store
  -- (integer): a configuration that could never be booked.
  if private.service_highest_price(new.id, new.price_cents) > 2147483647 then
    raise exception using
      errcode = '22023',
      message = 'price_too_high',
      hint = 'priceCents';
  end if;
  return new;
end;
$$;

revoke all on function private.check_service_longest() from public;

create trigger services_check_longest
  before update of duration_minutes, price_cents on public.services
  for each row execute function private.check_service_longest();

-- ---------------------------------------------------------------------------
-- Appointments: the answers chosen, as they were
-- ---------------------------------------------------------------------------

-- [{ optionId, question, choiceId, label, priceDeltaCents,
--    durationDeltaMinutes }], in the order of the groups. Empty for every
-- appointment booked before options, and for a service without any.
alter table public.appointments
  add column options_snapshot jsonb not null default '[]'::jsonb,
  add constraint appointments_options_snapshot_array
    check (jsonb_typeof(options_snapshot) = 'array');

-- ---------------------------------------------------------------------------
-- The one rule: what the chosen answers add
-- ---------------------------------------------------------------------------

-- What the answers `p_choice_ids` add to the service `p_service_id` of
-- `p_business_id`, and their snapshot. Refuses, without writing anything:
--   invalid_options            more than 50 ids, a duplicate, or two
--                              answers to the same group;
--   option_choice_unavailable  an answer that is not (or no longer) one of
--                              this service's;
--   options_required           a required group without an answer.
-- null means none (a client that knows nothing of options).
create function private.quote_options(
  p_business_id uuid,
  p_service_id uuid,
  p_choice_ids uuid[]
)
returns table (
  price_delta_cents integer,
  duration_delta_minutes integer,
  options jsonb
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ids uuid[] := coalesce(p_choice_ids, '{}'::uuid[]);
  v_found integer;
begin
  if pg_catalog.cardinality(v_ids) > 50
    or exists (select 1 from pg_catalog.unnest(v_ids) as u(id) where u.id is null)
    or pg_catalog.cardinality(v_ids) <> (
      select count(distinct u.id) from pg_catalog.unnest(v_ids) as u(id)
    ) then
    raise exception using errcode = '22023', message = 'invalid_options', hint = 'optionChoiceIds';
  end if;

  select count(*) into v_found
  from public.service_option_choices c
  join public.service_options o on o.id = c.option_id
  where c.id = any (v_ids)
    and o.service_id = p_service_id
    and o.business_id = p_business_id;

  if v_found <> pg_catalog.cardinality(v_ids) then
    raise exception using errcode = 'P0001', message = 'option_choice_unavailable', hint = 'optionChoiceIds';
  end if;

  if exists (
    select 1
    from public.service_option_choices c
    where c.id = any (v_ids)
    group by c.option_id
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'invalid_options', hint = 'optionChoiceIds';
  end if;

  if exists (
    select 1
    from public.service_options o
    where o.service_id = p_service_id
      and o.business_id = p_business_id
      and o.required
      and not exists (
        select 1
        from public.service_option_choices c
        where c.option_id = o.id and c.id = any (v_ids)
      )
  ) then
    raise exception using errcode = '22023', message = 'options_required', hint = 'optionChoiceIds';
  end if;

  return query
  select
    coalesce(sum(c.price_delta_cents), 0)::integer,
    coalesce(sum(c.duration_delta_minutes), 0)::integer,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'optionId', o.id,
          'question', o.question,
          'choiceId', c.id,
          'label', c.label,
          'priceDeltaCents', c.price_delta_cents,
          'durationDeltaMinutes', c.duration_delta_minutes
        )
        order by o.display_order, o.id
      ),
      '[]'::jsonb
    )
  from public.service_option_choices c
  join public.service_options o on o.id = c.option_id
  where c.id = any (v_ids);
end;
$$;

revoke all on function private.quote_options(uuid, uuid, uuid[]) from public;

-- The answers of a snapshot, sorted: to tell whether an edit changes them.
create function private.snapshot_choice_ids(p_options jsonb)
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.array_agg((item ->> 'choiceId')::uuid order by (item ->> 'choiceId')::uuid),
    '{}'::uuid[]
  )
  from pg_catalog.jsonb_array_elements(p_options) as item;
$$;

revoke all on function private.snapshot_choice_ids(jsonb) from public;

create function private.sorted_ids(p_ids uuid[])
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(u.id order by u.id), '{}'::uuid[])
  from pg_catalog.unnest(coalesce(p_ids, '{}'::uuid[])) as u(id);
$$;

revoke all on function private.sorted_ids(uuid[]) from public;

-- ---------------------------------------------------------------------------
-- Writing the catalogue (members of the business)
-- ---------------------------------------------------------------------------

create table private.catalog_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  request_id uuid not null,
  kind text not null,
  fingerprint text not null,
  target_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, request_id)
);

revoke all on private.catalog_requests from public, anon, authenticated;

create function private.assert_catalog_access(p_business_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

revoke all on function private.assert_catalog_access(uuid) from public;

create function private.clean_category_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text := pg_catalog.btrim(p_name);
begin
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 60 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'name';
  end if;
  return v_name;
end;
$$;

revoke all on function private.clean_category_name(text) from public;

-- Creates a category at the end of her list, once per request: a retry
-- answers the category it created ('replayed'), or 'deleted' if it has
-- been deleted since.
create function public.create_service_category(
  p_business_id uuid,
  p_request_id uuid,
  p_name text,
  p_visible boolean default true
)
returns table (status text, category_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name text;
  v_fingerprint text;
  v_existing record;
  v_category_id uuid;
begin
  perform private.assert_catalog_access(p_business_id);
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_visible is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'visible';
  end if;
  v_name := private.clean_category_name(p_name);

  perform private.lock_business_schedule(p_business_id);

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('name', v_name, 'visible', p_visible)::text,
      'UTF8'
    )),
    'hex'
  );

  select r.kind, r.fingerprint, r.target_id into v_existing
  from private.catalog_requests r
  where r.business_id = p_business_id and r.request_id = p_request_id;

  if found then
    if v_existing.kind <> 'create_category' or v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    if not exists (
      select 1 from public.service_categories c
      where c.id = v_existing.target_id and c.business_id = p_business_id
    ) then
      return query select 'deleted'::text, null::uuid;
      return;
    end if;
    return query select 'replayed'::text, v_existing.target_id;
    return;
  end if;

  insert into public.service_categories (business_id, name, visible, display_order)
  values (
    p_business_id,
    v_name,
    p_visible,
    (
      select coalesce(max(c.display_order) + 1, 0)
      from public.service_categories c
      where c.business_id = p_business_id
    )
  )
  returning id into v_category_id;

  insert into private.catalog_requests (business_id, request_id, kind, fingerprint, target_id)
  values (p_business_id, p_request_id, 'create_category', v_fingerprint, v_category_id);

  return query select 'created'::text, v_category_id;
end;
$$;

revoke all on function public.create_service_category(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.create_service_category(uuid, uuid, text, boolean) to authenticated;

-- Renames and/or shows or hides a category (null: unchanged), if it is
-- still at `p_expected_version`. A retry that finds the category already
-- with these values answers it as it is, whatever its version; otherwise
-- stale_category. Hiding a category makes its services unbookable online.
create function public.update_service_category(
  p_business_id uuid,
  p_category_id uuid,
  p_expected_version integer,
  p_name text default null,
  p_visible boolean default null
)
returns table (id uuid, name text, visible boolean, display_order integer, version integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name text;
  v_current public.service_categories%rowtype;
begin
  perform private.assert_catalog_access(p_business_id);
  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;
  if p_name is not null then
    v_name := private.clean_category_name(p_name);
  end if;

  perform private.lock_business_schedule(p_business_id);

  select c.* into v_current
  from public.service_categories c
  where c.id = p_category_id and c.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'category_not_found', hint = 'categoryId';
  end if;

  if v_current.version <> p_expected_version then
    if (v_name is null or v_name = v_current.name)
      and (p_visible is null or p_visible = v_current.visible) then
      return query select v_current.id, v_current.name, v_current.visible,
        v_current.display_order, v_current.version;
      return;
    end if;
    raise exception using errcode = 'P0001', message = 'stale_category', hint = 'expectedVersion';
  end if;

  return query
  update public.service_categories c
  set name = coalesce(v_name, c.name),
      visible = coalesce(p_visible, c.visible)
  where c.id = p_category_id
  returning c.id, c.name, c.visible, c.display_order, c.version;
end;
$$;

revoke all on function public.update_service_category(uuid, uuid, integer, text, boolean) from public, anon;
grant execute on function public.update_service_category(uuid, uuid, integer, text, boolean) to authenticated;

-- Her categories in this order: exactly all of them, once each.
create function public.reorder_service_categories(
  p_business_id uuid,
  p_category_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_catalog_access(p_business_id);
  perform private.lock_business_schedule(p_business_id);

  if p_category_ids is null
    or pg_catalog.cardinality(p_category_ids) <> (
      select count(distinct u.id) from pg_catalog.unnest(p_category_ids) as u(id)
    )
    or pg_catalog.cardinality(p_category_ids) <> (
      select count(*) from public.service_categories c where c.business_id = p_business_id
    )
    or exists (
      select 1
      from pg_catalog.unnest(p_category_ids) as u(id)
      where not exists (
        select 1 from public.service_categories c
        where c.id = u.id and c.business_id = p_business_id
      )
    ) then
    raise exception using errcode = '22023', message = 'invalid_category_order';
  end if;

  update public.service_categories c
  set display_order = o.position - 1
  from pg_catalog.unnest(p_category_ids) with ordinality as o(id, position)
  where c.id = o.id and c.business_id = p_business_id;
end;
$$;

revoke all on function public.reorder_service_categories(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_service_categories(uuid, uuid[]) to authenticated;

-- Deletes a category. Its services stay, without a category (their
-- version changes): nothing she booked or priced is lost. To remove them
-- too, she deletes or deactivates each one (a booked service is kept).
create function public.delete_service_category(
  p_business_id uuid,
  p_category_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_catalog_access(p_business_id);
  perform private.lock_business_schedule(p_business_id);

  delete from public.service_categories c
  where c.id = p_category_id and c.business_id = p_business_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'category_not_found', hint = 'categoryId';
  end if;
end;
$$;

revoke all on function public.delete_service_category(uuid, uuid) from public, anon;
grant execute on function public.delete_service_category(uuid, uuid) to authenticated;

-- The options of a service, as a whole, if the service is still at
-- `p_expected_version`:
--   [{ "id": uuid | null, "question": text, "required": boolean,
--      "choices": [{ "id": uuid | null, "label": text,
--                    "priceDeltaCents": int, "durationDeltaMinutes": int }] }]
-- In this order. An id keeps the group (or answer) it names, null creates
-- one. Up to 20 groups of 1 to 20 answers. The service's version changes.
--
-- Nothing is deleted by omission. Every existing group must be given (by
-- id) or listed in `p_deleted_option_ids`; every existing answer of a group
-- kept, given or listed in `p_deleted_choice_ids`. An editor that read the
-- options partially (a truncated read) is refused (options_incomplete)
-- instead of deleting what it did not see. A deleted group takes its
-- answers with it; an id already deleted is ignored (a retry).
--
-- Ids are compared as uuids. A retry that finds the options already as
-- given (ignoring the ids it created) answers the current version;
-- otherwise stale_service. The service's dearest booking must fit an
-- appointment (price_too_high) and its longest 720 min (duration_too_long).
create function public.set_service_options(
  p_business_id uuid,
  p_service_id uuid,
  p_expected_version integer,
  p_options jsonb,
  p_deleted_option_ids uuid[] default '{}',
  p_deleted_choice_ids uuid[] default '{}'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service public.services%rowtype;
  v_group jsonb;
  v_choice jsonb;
  v_group_index integer := 0;
  v_choice_index integer;
  v_option_id uuid;
  v_choice_id uuid;
  v_question text;
  v_label text;
  v_price integer;
  v_minutes integer;
  v_longest integer := 0;
  v_group_longest integer;
  v_dearest bigint := 0;
  v_group_dearest bigint;
  v_given_options uuid[] := '{}';
  v_given_choices uuid[] := '{}';
  v_deleted_options uuid[] := coalesce(p_deleted_option_ids, '{}');
  v_deleted_choices uuid[] := coalesce(p_deleted_choice_ids, '{}');
  v_version integer;
begin
  perform private.assert_catalog_access(p_business_id);
  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;
  if p_options is null
    or pg_catalog.jsonb_typeof(p_options) <> 'array'
    or pg_catalog.jsonb_array_length(p_options) > 20
    or pg_catalog.cardinality(v_deleted_options) > 100
    or pg_catalog.cardinality(v_deleted_choices) > 1000
    or array_position(v_deleted_options, null) is not null
    or array_position(v_deleted_choices, null) is not null
    -- The same id twice in a deletion list (uuids: whatever its spelling).
    or pg_catalog.cardinality(v_deleted_options) <> (
       select count(distinct u.id) from pg_catalog.unnest(v_deleted_options) as u(id))
    or pg_catalog.cardinality(v_deleted_choices) <> (
       select count(distinct u.id) from pg_catalog.unnest(v_deleted_choices) as u(id)) then
    raise exception using errcode = '22023', message = 'invalid_options', hint = 'options';
  end if;

  perform private.lock_business_schedule(p_business_id);

  select s.* into v_service
  from public.services s
  where s.id = p_service_id and s.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'service_not_found', hint = 'serviceId';
  end if;

  -- From another version: answered as done only if everything the
  -- request asked for is there (a retry of a request already applied).
  -- Same content is not enough: a group deleted then recreated as it was,
  -- or kept by an id that is gone, is not what was asked.
  if v_service.version <> p_expected_version then
    if private.options_request_applied(
      p_service_id, p_options, v_deleted_options, v_deleted_choices
    ) then
      return v_service.version;
    end if;
    raise exception using errcode = 'P0001', message = 'stale_service', hint = 'expectedVersion';
  end if;

  -- Validate everything before writing anything.
  for v_group in select value from pg_catalog.jsonb_array_elements(p_options) loop
    if pg_catalog.jsonb_typeof(v_group) <> 'object'
      or pg_catalog.jsonb_typeof(v_group -> 'question') <> 'string'
      or pg_catalog.jsonb_typeof(v_group -> 'required') <> 'boolean'
      or pg_catalog.jsonb_typeof(v_group -> 'choices') <> 'array'
      or pg_catalog.jsonb_array_length(v_group -> 'choices') not between 1 and 20
      or (v_group ? 'id' and pg_catalog.jsonb_typeof(v_group -> 'id') not in ('string', 'null')) then
      raise exception using errcode = '22023', message = 'invalid_options', hint = 'options';
    end if;
    v_question := pg_catalog.btrim(v_group ->> 'question');
    if pg_catalog.char_length(v_question) not between 1 and 120 then
      raise exception using errcode = '22023', message = 'invalid_options', hint = 'options';
    end if;
    begin
      v_option_id := nullif(v_group ->> 'id', '')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_options', hint = 'options';
    end;
    if v_option_id is not null then
      if not exists (
        select 1 from public.service_options o
        where o.id = v_option_id and o.service_id = p_service_id
      ) then
        raise exception using errcode = 'P0001', message = 'option_not_found', hint = 'options';
      end if;
      v_given_options := v_given_options || v_option_id;
    end if;
    v_group_longest := 0;
    v_group_dearest := 0;
    for v_choice in select value from pg_catalog.jsonb_array_elements(v_group -> 'choices') loop
      if pg_catalog.jsonb_typeof(v_choice) <> 'object'
        or pg_catalog.jsonb_typeof(v_choice -> 'label') <> 'string'
        or pg_catalog.jsonb_typeof(v_choice -> 'priceDeltaCents') <> 'number'
        or pg_catalog.jsonb_typeof(v_choice -> 'durationDeltaMinutes') <> 'number'
        or (v_choice ? 'id' and pg_catalog.jsonb_typeof(v_choice -> 'id') not in ('string', 'null')) then
        raise exception using errcode = '22023', message = 'invalid_options', hint = 'options';
      end if;
      v_label := pg_catalog.btrim(v_choice ->> 'label');
      if pg_catalog.char_length(v_label) not between 1 and 60
        or (v_choice ->> 'priceDeltaCents') !~ '^[0-9]{1,7}$'
        or (v_choice ->> 'durationDeltaMinutes') !~ '^[0-9]{1,3}$'
        or (v_choice ->> 'durationDeltaMinutes')::integer > 240 then
        raise exception using errcode = '22023', message = 'invalid_options', hint = 'options';
      end if;
      begin
        v_choice_id := nullif(v_choice ->> 'id', '')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '22023', message = 'invalid_options', hint = 'options';
      end;
      if v_choice_id is not null then
        if v_option_id is null or not exists (
          select 1 from public.service_option_choices c
          where c.id = v_choice_id and c.option_id = v_option_id
        ) then
          raise exception using errcode = 'P0001', message = 'option_not_found', hint = 'options';
        end if;
        v_given_choices := v_given_choices || v_choice_id;
      end if;
      v_group_longest := greatest(v_group_longest, (v_choice ->> 'durationDeltaMinutes')::integer);
      v_group_dearest := greatest(v_group_dearest, (v_choice ->> 'priceDeltaCents')::bigint);
    end loop;
    v_longest := v_longest + v_group_longest;
    v_dearest := v_dearest + v_group_dearest;
  end loop;

  -- An id given twice, as uuids (whatever its spelling), or both given and
  -- deleted.
  if pg_catalog.cardinality(v_given_options) <> (
       select count(distinct u.id) from pg_catalog.unnest(v_given_options) as u(id))
    or pg_catalog.cardinality(v_given_choices) <> (
       select count(distinct u.id) from pg_catalog.unnest(v_given_choices) as u(id))
    or v_given_options && v_deleted_options
    or v_given_choices && v_deleted_choices then
    raise exception using errcode = '22023', message = 'invalid_options', hint = 'options';
  end if;

  -- Deleted ids: this service's, or already gone (a retry); never another's.
  if exists (
    select 1 from public.service_options o
    where o.id = any (v_deleted_options) and o.service_id <> p_service_id
  ) or exists (
    select 1
    from public.service_option_choices c
    join public.service_options o on o.id = c.option_id
    where c.id = any (v_deleted_choices) and o.service_id <> p_service_id
  ) then
    raise exception using errcode = 'P0001', message = 'option_not_found', hint = 'options';
  end if;

  -- Nothing by omission: every existing group given or deleted, every
  -- existing answer of a kept group given or deleted.
  if exists (
    select 1 from public.service_options o
    where o.service_id = p_service_id
      and not (o.id = any (v_given_options) or o.id = any (v_deleted_options))
  ) or exists (
    select 1
    from public.service_option_choices c
    where c.option_id = any (v_given_options)
      and not (c.id = any (v_given_choices) or c.id = any (v_deleted_choices))
  ) then
    raise exception using errcode = 'P0001', message = 'options_incomplete', hint = 'options';
  end if;

  if v_service.duration_minutes + v_longest > 720 then
    raise exception using errcode = '22023', message = 'duration_too_long', hint = 'options';
  end if;
  if v_service.price_cents::bigint + v_dearest > 2147483647 then
    raise exception using errcode = '22023', message = 'price_too_high', hint = 'options';
  end if;

  -- Deletions asked for (answers of deleted groups go with them).
  delete from public.service_options o
  where o.service_id = p_service_id and o.id = any (v_deleted_options);
  delete from public.service_option_choices c
  where c.id = any (v_deleted_choices)
    and c.option_id in (
      select o.id from public.service_options o where o.service_id = p_service_id
    );

  for v_group in select value from pg_catalog.jsonb_array_elements(p_options) loop
    v_option_id := nullif(v_group ->> 'id', '')::uuid;
    v_question := pg_catalog.btrim(v_group ->> 'question');
    if v_option_id is null then
      insert into public.service_options (business_id, service_id, question, required, display_order)
      values (p_business_id, p_service_id, v_question, (v_group ->> 'required')::boolean, v_group_index)
      returning id into v_option_id;
    else
      update public.service_options o
      set question = v_question,
          required = (v_group ->> 'required')::boolean,
          display_order = v_group_index
      where o.id = v_option_id;
    end if;

    v_choice_index := 0;
    for v_choice in select value from pg_catalog.jsonb_array_elements(v_group -> 'choices') loop
      v_choice_id := nullif(v_choice ->> 'id', '')::uuid;
      v_label := pg_catalog.btrim(v_choice ->> 'label');
      v_price := (v_choice ->> 'priceDeltaCents')::integer;
      v_minutes := (v_choice ->> 'durationDeltaMinutes')::integer;
      if v_choice_id is null then
        insert into public.service_option_choices (
          business_id, option_id, label, price_delta_cents, duration_delta_minutes, display_order
        )
        values (p_business_id, v_option_id, v_label, v_price, v_minutes, v_choice_index);
      else
        update public.service_option_choices c
        set label = v_label,
            price_delta_cents = v_price,
            duration_delta_minutes = v_minutes,
            display_order = v_choice_index
        where c.id = v_choice_id;
      end if;
      v_choice_index := v_choice_index + 1;
    end loop;

    v_group_index := v_group_index + 1;
  end loop;

  update public.services s
  set options_revision = s.options_revision + 1
  where s.id = p_service_id
  returning s.version into v_version;

  return v_version;
end;
$$;

-- Whether the options of `p_service_id` are exactly what this request
-- asked for, its effects included:
--   * the same content, in the same order (ids aside);
--   * every id it named to keep is there, at the place it gave it;
--   * every id it asked to delete is gone from this service.
-- A new group or answer (no id) matches whatever id it was given.
create function private.options_request_applied(
  p_service_id uuid,
  p_options jsonb,
  p_deleted_option_ids uuid[],
  p_deleted_choice_ids uuid[]
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_current jsonb := private.service_options_document(p_service_id, true);
  v_group record;
  v_choice record;
  v_id uuid;
begin
  if private.service_options_document(p_service_id, false)
    is distinct from private.normalized_options(p_options, false) then
    return false;
  end if;

  for v_group in
    select value, ordinality from pg_catalog.jsonb_array_elements(p_options) with ordinality
  loop
    v_id := nullif(v_group.value ->> 'id', '')::uuid;
    if v_id is not null
      and v_id is distinct from (v_current -> (v_group.ordinality::integer - 1) ->> 'id')::uuid then
      return false;
    end if;
    for v_choice in
      select value, ordinality
      from pg_catalog.jsonb_array_elements(v_group.value -> 'choices') with ordinality
    loop
      v_id := nullif(v_choice.value ->> 'id', '')::uuid;
      if v_id is not null and v_id is distinct from (
        v_current -> (v_group.ordinality::integer - 1) -> 'choices'
          -> (v_choice.ordinality::integer - 1) ->> 'id'
      )::uuid then
        return false;
      end if;
    end loop;
  end loop;

  return not exists (
    select 1 from public.service_options o
    where o.service_id = p_service_id and o.id = any (p_deleted_option_ids)
  ) and not exists (
    select 1
    from public.service_option_choices c
    join public.service_options o on o.id = c.option_id
    where o.service_id = p_service_id and c.id = any (p_deleted_choice_ids)
  );
exception
  -- A malformed request (an id that is not a uuid…) was not applied.
  when invalid_text_representation then
    return false;
end;
$$;

revoke all on function private.options_request_applied(uuid, jsonb, uuid[], uuid[]) from public;

-- Her options as a canonical document (for comparing a retry), with or
-- without their ids.
create function private.service_options_document(p_service_id uuid, p_with_ids boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', case when p_with_ids then o.id end,
        'question', o.question,
        'required', o.required,
        'choices', (
          select coalesce(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', case when p_with_ids then c.id end,
                'label', c.label,
                'priceDeltaCents', c.price_delta_cents,
                'durationDeltaMinutes', c.duration_delta_minutes
              )
              order by c.display_order, c.id
            ),
            '[]'::jsonb
          )
          from public.service_option_choices c
          where c.option_id = o.id
        )
      )
      order by o.display_order, o.id
    ),
    '[]'::jsonb
  )
  from public.service_options o
  where o.service_id = p_service_id;
$$;

revoke all on function private.service_options_document(uuid, boolean) from public;

-- A document as given, in the same canonical form (malformed: null).
create function private.normalized_options(p_options jsonb, p_with_ids boolean)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  return (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', case when p_with_ids then nullif(g.value ->> 'id', '')::uuid end,
          'question', pg_catalog.btrim(g.value ->> 'question'),
          'required', (g.value ->> 'required')::boolean,
          'choices', (
            select coalesce(
              pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', case when p_with_ids then nullif(c.value ->> 'id', '')::uuid end,
                  'label', pg_catalog.btrim(c.value ->> 'label'),
                  'priceDeltaCents', (c.value ->> 'priceDeltaCents')::integer,
                  'durationDeltaMinutes', (c.value ->> 'durationDeltaMinutes')::integer
                )
                order by c.ordinality
              ),
              '[]'::jsonb
            )
            from pg_catalog.jsonb_array_elements(g.value -> 'choices') with ordinality as c(value, ordinality)
          )
        )
        order by g.ordinality
      ),
      '[]'::jsonb
    )
    from pg_catalog.jsonb_array_elements(p_options) with ordinality as g(value, ordinality)
  );
exception
  when others then
    return null;
end;
$$;

revoke all on function private.normalized_options(jsonb, boolean) from public;

revoke all on function public.set_service_options(uuid, uuid, integer, jsonb, uuid[], uuid[]) from public, anon;
grant execute on function public.set_service_options(uuid, uuid, integer, jsonb, uuid[], uuid[]) to authenticated;

-- Her catalogue, whole, as one document read in one snapshot: categories,
-- services (active or not) and their options. One row whatever its size:
-- a read capped by the API (PostgREST max_rows) can never truncate it, so
-- an editor never believes a partial list is complete. `p_service_id`:
-- that service only (no categories).
--   { "categories": [{ id, name, visible, displayOrder, version }],
--     "services": [{ id, name, description, durationMinutes, priceCents,
--                    active, displayOrder, categoryId, version,
--                    options: [{ id, question, required,
--                                choices: [{ id, label, priceDeltaCents,
--                                            durationDeltaMinutes }] }] }] }
create function public.get_catalog(p_business_id uuid, p_service_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_catalog_access(p_business_id);
  if p_service_id is not null and not exists (
    select 1 from public.services s
    where s.id = p_service_id and s.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'service_not_found', hint = 'serviceId';
  end if;

  return pg_catalog.jsonb_build_object(
    'categories', case when p_service_id is not null then '[]'::jsonb else (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', c.id,
            'name', c.name,
            'visible', c.visible,
            'displayOrder', c.display_order,
            'version', c.version
          )
          order by c.display_order, c.name, c.id
        ),
        '[]'::jsonb
      )
      from public.service_categories c
      where c.business_id = p_business_id
    ) end,
    'services', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'description', s.description,
            'durationMinutes', s.duration_minutes,
            'priceCents', s.price_cents,
            'active', s.active,
            'displayOrder', s.display_order,
            'categoryId', s.category_id,
            'version', s.version,
            'options', private.public_service_options(s.id)
          )
          order by s.display_order, s.name, s.id
        ),
        '[]'::jsonb
      )
      from public.services s
      where s.business_id = p_business_id
        and (p_service_id is null or s.id = p_service_id)
    )
  );
end;
$$;

revoke all on function public.get_catalog(uuid, uuid) from public, anon;
grant execute on function public.get_catalog(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What the public sees and books
-- ---------------------------------------------------------------------------

-- Bookable online: active, and in no category or a visible one.
create function private.service_publicly_bookable(p_business_id uuid, p_service_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.services s
    left join public.service_categories c on c.id = s.category_id
    where s.id = p_service_id
      and s.business_id = p_business_id
      and s.active
      and (s.category_id is null or c.visible)
  );
$$;

revoke all on function private.service_publicly_bookable(uuid, uuid) from public;

-- Unchanged shape; a service of a hidden category is no longer listed.
create or replace function public.get_public_services(p_slug text)
returns table (
  id uuid,
  name text,
  description text,
  duration_minutes integer,
  price_cents integer,
  currency text,
  display_order integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.name,
    s.description,
    s.duration_minutes,
    s.price_cents,
    st.currency,
    s.display_order
  from public.services s
  join public.business_settings st on st.business_id = s.business_id
  left join public.service_categories c on c.id = s.category_id
  where s.business_id = private.business_id_by_slug(p_slug)
    and s.active
    and (s.category_id is null or c.visible)
  order by s.display_order, s.name, s.id;
$$;

-- The public catalogue, as the mini-site shows it: visible categories in
-- her order with their bookable services (a category without any is left
-- out), then the services without a category, as a group without a
-- heading. Each service with its options and answers, in her order.
--   { "currency": "EUR",
--     "groups": [{ "category": { "id", "name" } | null,
--                  "services": [{ "id", "name", "description",
--                    "durationMinutes", "priceCents",
--                    "options": [{ "id", "question", "required",
--                      "choices": [{ "id", "label", "priceDeltaCents",
--                                    "durationDeltaMinutes" }] }] }] }] }
-- null when there is no such business.
create function public.get_public_catalog(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
  v_currency text;
begin
  if v_business_id is null then
    return null;
  end if;

  select st.currency into v_currency
  from public.business_settings st
  where st.business_id = v_business_id;

  return pg_catalog.jsonb_build_object(
    'currency', v_currency,
    'groups', coalesce((
      select pg_catalog.jsonb_agg(g.doc order by g.uncategorized, g.category_order, g.category_name, g.category_id)
      from (
        select
          c.id as category_id,
          c.display_order as category_order,
          c.name as category_name,
          c.id is null as uncategorized,
          pg_catalog.jsonb_build_object(
            'category', case when c.id is null then null
              else pg_catalog.jsonb_build_object('id', c.id, 'name', c.name) end,
            'services', pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', s.id,
                'name', s.name,
                'description', s.description,
                'durationMinutes', s.duration_minutes,
                'priceCents', s.price_cents,
                'options', private.public_service_options(s.id)
              )
              order by s.display_order, s.name, s.id
            )
          ) as doc
        from public.services s
        left join public.service_categories c on c.id = s.category_id
        where s.business_id = v_business_id
          and s.active
          and (s.category_id is null or c.visible)
        group by c.id, c.display_order, c.name
      ) g
    ), '[]'::jsonb)
  );
end;
$$;

create function private.public_service_options(p_service_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', o.id,
        'question', o.question,
        'required', o.required,
        'choices', (
          select coalesce(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', c.id,
                'label', c.label,
                'priceDeltaCents', c.price_delta_cents,
                'durationDeltaMinutes', c.duration_delta_minutes
              )
              order by c.display_order, c.id
            ),
            '[]'::jsonb
          )
          from public.service_option_choices c
          where c.option_id = o.id
        )
      )
      order by o.display_order, o.id
    ),
    '[]'::jsonb
  )
  from public.service_options o
  where o.service_id = p_service_id;
$$;

revoke all on function private.public_service_options(uuid) from public;
revoke all on function public.get_public_catalog(text) from public;
grant execute on function public.get_public_catalog(text) to anon, authenticated, service_role;

-- The price and duration the server will book for these answers (the
-- browser shows them, it never decides them).
create function public.quote_public_service(
  p_slug text,
  p_service_id uuid,
  p_option_choice_ids uuid[] default null
)
returns table (
  service_name text,
  duration_minutes integer,
  price_cents integer,
  currency text,
  options jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
  v_service public.services%rowtype;
  v_quote record;
begin
  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;
  if not private.service_publicly_bookable(v_business_id, p_service_id) then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  select s.* into v_service from public.services s where s.id = p_service_id;
  select * into v_quote from private.quote_options(v_business_id, p_service_id, p_option_choice_ids);

  if v_service.duration_minutes + v_quote.duration_delta_minutes > 720 then
    raise exception using errcode = '22023', message = 'duration_too_long', hint = 'optionChoiceIds';
  end if;

  return query
  select
    v_service.name,
    v_service.duration_minutes + v_quote.duration_delta_minutes,
    v_service.price_cents + v_quote.price_delta_cents,
    st.currency,
    v_quote.options
  from public.business_settings st
  where st.business_id = v_business_id;
end;
$$;

revoke all on function public.quote_public_service(text, uuid, uuid[]) from public;
grant execute on function public.quote_public_service(text, uuid, uuid[]) to anon, authenticated, service_role;

-- Slots for the service with these answers: their total duration.
drop function public.get_available_slots(text, uuid, date);
drop function private.available_slots(uuid, uuid, date, timestamptz);

create function private.available_slots(
  p_business_id uuid,
  p_service_id uuid,
  p_date date,
  p_now timestamptz,
  p_option_choice_ids uuid[] default null
)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_timezone text;
  v_duration integer;
  v_step integer;
  v_buffer integer;
  v_notice integer;
  v_max_days integer;
  v_quote record;
begin
  select
    b.timezone,
    s.duration_minutes,
    st.slot_interval_minutes,
    st.buffer_minutes,
    st.minimum_booking_notice_minutes,
    st.maximum_booking_advance_days
  into v_timezone, v_duration, v_step, v_buffer, v_notice, v_max_days
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  join public.services s on s.business_id = b.id
  left join public.service_categories c on c.id = s.category_id
  where b.id = p_business_id
    and s.id = p_service_id
    and s.active
    and (s.category_id is null or c.visible);

  if not found then
    return;
  end if;

  select * into v_quote from private.quote_options(p_business_id, p_service_id, p_option_choice_ids);
  v_duration := v_duration + v_quote.duration_delta_minutes;
  if v_duration > 720 then
    raise exception using errcode = '22023', message = 'duration_too_long', hint = 'optionChoiceIds';
  end if;

  return query
  select slot.starts_at, slot.ends_at
  from private.compute_available_slots(
    p_business_id, p_date, p_now, v_timezone,
    v_duration, v_step, v_buffer, v_notice, v_max_days
  ) slot;
end;
$$;

revoke all on function private.available_slots(uuid, uuid, date, timestamptz, uuid[]) from public;

create function public.get_available_slots(
  p_slug text,
  p_service_id uuid,
  p_date date,
  p_option_choice_ids uuid[] default null
)
returns table (
  starts_at timestamptz,
  ends_at timestamptz,
  local_starts_at text,
  local_ends_at text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
  v_timezone text;
begin
  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  if not private.service_publicly_bookable(v_business_id, p_service_id) then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  select b.timezone into v_timezone
  from public.businesses b
  where b.id = v_business_id;

  return query
  select
    slot.starts_at,
    slot.ends_at,
    private.wall_clock(slot.starts_at, v_timezone),
    private.wall_clock(slot.ends_at, v_timezone)
  from private.available_slots(
    v_business_id, p_service_id, p_date, pg_catalog.now(), p_option_choice_ids
  ) slot;
end;
$$;

revoke all on function public.get_available_slots(text, uuid, date, uuid[]) from public;
grant execute on function public.get_available_slots(text, uuid, date, uuid[]) to anon, authenticated, service_role;

-- Slots and the quote they are for, from one read: one STABLE function,
-- so every statement sees the same snapshot. A change of the service
-- between two separate reads (slots for 30 min, a quote for 75) cannot
-- happen. The same rule (private.quote_options) and the same slot
-- computation as the booking, which re-validates both under the schedule
-- lock anyway.
--   { "quote": { serviceName, durationMinutes, priceCents, currency, options },
--     "slots": [{ startsAt, endsAt, localStartsAt, localEndsAt }] }
create function public.get_public_availability(
  p_slug text,
  p_service_id uuid,
  p_date date,
  p_option_choice_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
  v_offer record;
  v_quote record;
  v_duration integer;
begin
  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;
  if not private.service_publicly_bookable(v_business_id, p_service_id) then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  select
    b.timezone, s.name, s.duration_minutes, s.price_cents,
    st.currency, st.slot_interval_minutes, st.buffer_minutes,
    st.minimum_booking_notice_minutes, st.maximum_booking_advance_days
  into v_offer
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  join public.services s on s.business_id = b.id
  where b.id = v_business_id and s.id = p_service_id;

  select * into v_quote from private.quote_options(v_business_id, p_service_id, p_option_choice_ids);
  v_duration := v_offer.duration_minutes + v_quote.duration_delta_minutes;
  if v_duration > 720 then
    raise exception using errcode = '22023', message = 'duration_too_long', hint = 'optionChoiceIds';
  end if;

  return pg_catalog.jsonb_build_object(
    'quote', pg_catalog.jsonb_build_object(
      'serviceName', v_offer.name,
      'durationMinutes', v_duration,
      'priceCents', v_offer.price_cents::bigint + v_quote.price_delta_cents,
      'currency', v_offer.currency,
      'options', v_quote.options
    ),
    'slots', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'startsAt', slot.starts_at,
          'endsAt', slot.ends_at,
          'localStartsAt', private.wall_clock(slot.starts_at, v_offer.timezone),
          'localEndsAt', private.wall_clock(slot.ends_at, v_offer.timezone)
        )
        order by slot.starts_at
      )
      from private.compute_available_slots(
        v_business_id, p_date, pg_catalog.now(), v_offer.timezone, v_duration,
        v_offer.slot_interval_minutes, v_offer.buffer_minutes,
        v_offer.minimum_booking_notice_minutes, v_offer.maximum_booking_advance_days
      ) slot
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_public_availability(text, uuid, date, uuid[]) from public;
grant execute on function public.get_public_availability(text, uuid, date, uuid[]) to anon, authenticated, service_role;

-- Public booking: the answers, the server's price and duration, and what
-- she was shown (optional guard). Same lock, idempotency and checks as
-- before; a request without answers books exactly as before.
drop function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, inet, text, text);
drop function private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text, uuid, inet);

create function private.create_public_booking_at(p_now timestamp with time zone, p_slug text, p_service_id uuid, p_starts_at timestamp with time zone, p_first_name text, p_email text, p_last_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid, p_client_ip inet DEFAULT NULL::inet, p_option_choice_ids uuid[] DEFAULT NULL::uuid[], p_expected_price_cents integer DEFAULT NULL::integer, p_expected_duration_minutes integer DEFAULT NULL::integer)
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

revoke all on function private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text, uuid, inet, uuid[], integer, integer) from public;

create function public.create_public_booking(p_slug text, p_service_id uuid, p_starts_at timestamp with time zone, p_first_name text, p_email text, p_request_id uuid, p_client_ip inet, p_last_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_option_choice_ids uuid[] DEFAULT NULL::uuid[], p_expected_price_cents integer DEFAULT NULL::integer, p_expected_duration_minutes integer DEFAULT NULL::integer)
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
    p_expected_duration_minutes
  );
end;
$function$;

revoke all on function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, inet, text, text, uuid[], integer, integer) from public, anon, authenticated;
grant execute on function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, inet, text, text, uuid[], integer, integer) to service_role;

-- The agenda: the same rule for her own bookings and edits.
drop function public.agenda_create_appointment(uuid, uuid, timestamptz, uuid, text, text, text, text, text, uuid);

create function public.agenda_create_appointment(p_business_id uuid, p_service_id uuid, p_starts_at timestamp with time zone, p_client_id uuid DEFAULT NULL::uuid, p_client_first_name text DEFAULT NULL::text, p_client_last_name text DEFAULT NULL::text, p_client_email text DEFAULT NULL::text, p_client_phone text DEFAULT NULL::text, p_internal_notes text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid, p_option_choice_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(appointment_id uuid, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_first_name text := private.optional_text(p_client_first_name, 120, 'firstName');
  v_last_name text := private.optional_text(p_client_last_name, 120, 'lastName');
  v_email text := private.canonical_email(private.optional_text(p_client_email, 254, 'email'));
  v_phone text := private.optional_text(p_client_phone, 30, 'phone');
  v_notes text := private.optional_text(p_internal_notes, 2000, 'internalNotes');
  v_service public.services%rowtype;
  v_settings public.business_settings%rowtype;
  v_client_id uuid;
  v_appointment_id uuid;
  v_fingerprint text;
  v_existing_fingerprint text;
  v_choice_ids uuid[] := private.sorted_ids(p_option_choice_ids);
  v_quote record;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_starts_at is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'startsAt';
  end if;
  if p_client_id is null and v_first_name is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'firstName';
  end if;
  if p_client_id is not null and coalesce(v_first_name, v_last_name, v_email, v_phone) is not null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;
  if v_email is not null
    and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'email';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'phone';
  end if;

  -- 1. Schedule lock first (lock order convention), then fresh snapshots.
  perform private.lock_business_schedule(p_business_id);

  -- 2. Idempotency. The key is bound to the canonical command: normalised
  --    inputs (NFC, trimmed, email lower-cased), start as UTC epoch (independent of the session time zone),
  --    jsonb key order. Under the schedule lock, a concurrent use of the same
  --    key has either committed (and is compared here) or not started.
  if p_request_id is not null then
    v_fingerprint := pg_catalog.encode(
      extensions.digest(
        (pg_catalog.jsonb_build_object(
          'service_id', p_service_id,
          'starts_at_epoch', extract(epoch from p_starts_at),
          'client_id', p_client_id,
          'client_first_name', v_first_name,
          'client_last_name', v_last_name,
          'client_email', v_email,
          'client_phone', v_phone,
          'internal_notes', v_notes
        )
        || case when pg_catalog.cardinality(v_choice_ids) > 0
             then pg_catalog.jsonb_build_object('option_choice_ids', pg_catalog.to_jsonb(v_choice_ids))
             else '{}'::jsonb end
        )::text,
        'sha256'
      ),
      'hex'
    );

    select a.id, a.creation_request_fingerprint
    into v_appointment_id, v_existing_fingerprint
    from public.appointments a
    where a.business_id = p_business_id
      and a.creation_request_id = p_request_id;

    if found then
      if v_existing_fingerprint <> v_fingerprint then
        raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
      end if;

      return query select v_appointment_id, false;
      return;
    end if;
  end if;

  -- 3. Values used for the whole transaction, locked against changes.
  select s.* into v_service
  from public.services s
  where s.id = p_service_id
    and s.business_id = p_business_id
    and s.active
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'service_unavailable', hint = 'serviceId';
  end if;

  select st.* into v_settings
  from public.business_settings st
  where st.business_id = p_business_id
  for share;

  -- The same rule as public booking (private.quote_options). Online
  -- visibility does not apply: she books any of her active services.
  select * into v_quote
  from private.quote_options(p_business_id, v_service.id, v_choice_ids);
  if v_service.duration_minutes + v_quote.duration_delta_minutes > 720 then
    raise exception using errcode = '22023', message = 'duration_too_long', hint = 'optionChoiceIds';
  end if;

  -- 4. Client, strictly within this business.
  if p_client_id is not null then
    select c.id into v_client_id
    from public.clients c
    where c.id = p_client_id
      and c.business_id = p_business_id;

    if not found then
      raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
    end if;
  else
    -- Same resolution as public booking: an email is the customer's
    -- identity in this business; without one, a new customer record.
    v_client_id := private.resolve_client(
      p_business_id, v_first_name, v_last_name, v_email, v_phone
    );
  end if;

  -- 5. Insert. The exclusion constraint and the block trigger decide.
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
      internal_notes,
      created_by,
      creation_request_id,
      creation_request_fingerprint,
      client_first_name_snapshot,
      client_last_name_snapshot,
      client_email_snapshot,
      client_phone_snapshot,
      options_snapshot
    )
    values (
      p_business_id,
      v_client_id,
      v_service.id,
      p_starts_at,
      p_starts_at + pg_catalog.make_interval(
        mins => v_service.duration_minutes + v_quote.duration_delta_minutes
      ),
      'confirmed',
      v_service.name,
      v_service.duration_minutes + v_quote.duration_delta_minutes,
      v_service.price_cents + v_quote.price_delta_cents,
      v_settings.currency,
      v_settings.buffer_minutes,
      v_notes,
      (select auth.uid()),
      p_request_id,
      v_fingerprint,
      -- New customer: the submitted contact. Existing one (p_client_id):
      -- null, the snapshot trigger copies that record.
      v_first_name,
      v_last_name,
      v_email,
      v_phone,
      v_quote.options
    )
    returning id into v_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'schedule_conflict';
  end;

  return query select v_appointment_id, true;
end;
$function$;

revoke all on function public.agenda_create_appointment(uuid, uuid, timestamptz, uuid, text, text, text, text, text, uuid, uuid[]) from public, anon;
grant execute on function public.agenda_create_appointment(uuid, uuid, timestamptz, uuid, text, text, text, text, text, uuid, uuid[]) to authenticated, service_role;

drop function public.agenda_update_appointment(uuid, uuid, integer, uuid, uuid, text, timestamptz);

create function public.agenda_update_appointment(p_business_id uuid, p_appointment_id uuid, p_expected_version integer, p_service_id uuid, p_client_id uuid, p_internal_notes text DEFAULT NULL::text, p_starts_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_option_choice_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_notes text := private.optional_text(p_internal_notes, 2000, 'internalNotes');
  v_current public.appointments%rowtype;
  v_service public.services%rowtype;
  v_settings public.business_settings%rowtype;
  v_duration integer;
  v_price integer;
  v_name text;
  v_buffer integer;
  v_currency text;
  v_starts_at timestamptz;
  v_options jsonb;
  v_quote record;
  -- The answers do not change when none are given for the same service,
  -- or when the same ones are given again.
  v_same_answers boolean;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;
  if p_service_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'serviceId';
  end if;
  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;

  perform private.lock_business_schedule(p_business_id);

  select a.* into v_current
  from public.appointments a
  where a.id = p_appointment_id
    and a.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'appointment_not_found';
  end if;

  if v_current.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_appointment';
  end if;

  v_starts_at := coalesce(p_starts_at, v_current.starts_at);
  v_same_answers := p_option_choice_ids is null
    or private.sorted_ids(p_option_choice_ids)
       = private.snapshot_choice_ids(v_current.options_snapshot);

  if v_current.status <> 'confirmed' and (
    v_current.starts_at <> v_starts_at
    or v_current.service_id <> p_service_id
    or v_current.client_id <> p_client_id
    or not v_same_answers
  ) then
    raise exception using errcode = 'P0001', message = 'appointment_not_editable';
  end if;

  if p_client_id <> v_current.client_id and not exists (
    select 1
    from public.clients c
    where c.id = p_client_id
      and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  -- Same service, same answers: the appointment keeps what was agreed
  -- (moving it never re-prices it). Another service or other answers are
  -- priced now, by the same rule as a new booking.
  if p_service_id = v_current.service_id and v_same_answers then
    v_duration := v_current.duration_minutes_snapshot;
    v_price := v_current.price_cents_snapshot;
    v_name := v_current.service_name_snapshot;
    v_buffer := v_current.buffer_minutes_snapshot;
    v_currency := v_current.currency;
    v_options := v_current.options_snapshot;
  else
    select s.* into v_service
    from public.services s
    where s.id = p_service_id
      and s.business_id = p_business_id
      and s.active
    for share;

    if not found then
      raise exception using errcode = 'P0002', message = 'service_unavailable', hint = 'serviceId';
    end if;

    select st.* into v_settings
    from public.business_settings st
    where st.business_id = p_business_id
    for share;

    select * into v_quote
    from private.quote_options(
      p_business_id, v_service.id, coalesce(p_option_choice_ids, '{}'::uuid[])
    );
    if v_service.duration_minutes + v_quote.duration_delta_minutes > 720 then
      raise exception using errcode = '22023', message = 'duration_too_long', hint = 'optionChoiceIds';
    end if;

    v_duration := v_service.duration_minutes + v_quote.duration_delta_minutes;
    v_price := v_service.price_cents + v_quote.price_delta_cents;
    v_name := v_service.name;
    v_options := v_quote.options;
    v_buffer := v_settings.buffer_minutes;
    v_currency := v_settings.currency;
  end if;

  begin
    update public.appointments a
    set
      starts_at = v_starts_at,
      ends_at = v_starts_at + pg_catalog.make_interval(mins => v_duration),
      service_id = p_service_id,
      client_id = p_client_id,
      service_name_snapshot = v_name,
      duration_minutes_snapshot = v_duration,
      price_cents_snapshot = v_price,
      buffer_minutes_snapshot = v_buffer,
      currency = v_currency,
      options_snapshot = v_options,
      internal_notes = v_notes
    where a.id = p_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'schedule_conflict';
  end;

  return p_appointment_id;
end;
$function$;

revoke all on function public.agenda_update_appointment(uuid, uuid, integer, uuid, uuid, text, timestamptz, uuid[]) from public, anon;
grant execute on function public.agenda_update_appointment(uuid, uuid, integer, uuid, uuid, text, timestamptz, uuid[]) to authenticated, service_role;

-- Creating a service directly in a category (optional, as before without).
drop function public.create_service(uuid, uuid, text, integer, integer, text, boolean, integer);

create function public.create_service(p_business_id uuid, p_request_id uuid, p_name text, p_duration_minutes integer, p_price_cents integer, p_description text DEFAULT NULL::text, p_active boolean DEFAULT true, p_display_order integer DEFAULT NULL::integer, p_category_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(status text, service_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_existing record;
  v_service_id uuid;
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_active is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'active';
  end if;

  -- The request is bound to its command, as sent (jsonb key order).
  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (pg_catalog.jsonb_build_object(
        'name', p_name,
        'description', p_description,
        'duration_minutes', p_duration_minutes,
        'price_cents', p_price_cents,
        'active', p_active,
        'display_order', p_display_order
      )
      -- Only with a category: a request without keeps its former fingerprint.
      || case when p_category_id is not null
           then pg_catalog.jsonb_build_object('category_id', p_category_id)
           else '{}'::jsonb end
      )::text,
      'UTF8'
    )),
    'hex'
  );

  insert into private.service_creation_requests (business_id, request_id, fingerprint)
  values (p_business_id, p_request_id, v_fingerprint)
  on conflict (business_id, request_id) do nothing;

  if not found then
    select r.fingerprint, r.service_id into v_existing
    from private.service_creation_requests r
    where r.business_id = p_business_id
      and r.request_id = p_request_id
    for update;

    if v_existing.fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    if v_existing.service_id is null then
      return query select 'deleted'::text, null::uuid;
      return;
    end if;
    return query select 'replayed'::text, v_existing.service_id;
    return;
  end if;

  -- A category of another business does not exist here (composite key).
  if p_category_id is not null and not exists (
    select 1 from public.service_categories c
    where c.id = p_category_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'category_not_found', hint = 'categoryId';
  end if;

  insert into public.services (
    business_id, name, description, duration_minutes, price_cents, active, display_order, category_id
  )
  values (
    p_business_id, p_name, p_description, p_duration_minutes, p_price_cents, p_active,
    coalesce(
      p_display_order,
      (
        select coalesce(max(s.display_order) + 1, 0)
        from public.services s
        where s.business_id = p_business_id
      )
    ),
    p_category_id
  )
  returning id into v_service_id;

  update private.service_creation_requests r
  set service_id = v_service_id
  where r.business_id = p_business_id
    and r.request_id = p_request_id;

  return query select 'created'::text, v_service_id;
end;
$function$;

revoke all on function public.create_service(uuid, uuid, text, integer, integer, text, boolean, integer, uuid) from public, anon;
grant execute on function public.create_service(uuid, uuid, text, integer, integer, text, boolean, integer, uuid) to authenticated, service_role;
