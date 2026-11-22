-- Point 147 (Higani backlog): a careful detection of duplicate client
-- records. Nothing is ever merged automatically: two records that look
-- alike are shown side by side for the professional to check, and she can
-- say they are two different people (remembered, and undoable).
--
-- Bookings already find a client by her address (one record per address
-- and business). What remains: the same phone (normalised: « +33 6 12… »
-- and « 06 12… » are one number), or the same full name (case, accents,
-- hyphens and spaces aside; a first name alone is not enough). Erased
-- records are never proposed.
--
-- Like every CRM function, these run as the caller: RLS stays the
-- authority (crm-read-model.test.ts), on the records and on her choices.

create table public.client_duplicate_dismissals (
  business_id uuid not null,
  client_a uuid not null,
  client_b uuid not null,
  dismissed_by uuid default auth.uid(),
  dismissed_at timestamptz not null default pg_catalog.now(),
  primary key (business_id, client_a, client_b),
  check (client_a < client_b),
  foreign key (client_a, business_id)
    references public.clients (id, business_id) on delete cascade,
  foreign key (client_b, business_id)
    references public.clients (id, business_id) on delete cascade
);

alter table public.client_duplicate_dismissals enable row level security;

create policy client_duplicate_dismissals_select_member
  on public.client_duplicate_dismissals for select to authenticated
  using (public.is_business_member(business_id));
create policy client_duplicate_dismissals_insert_member
  on public.client_duplicate_dismissals for insert to authenticated
  with check (public.is_business_member(business_id));
create policy client_duplicate_dismissals_delete_member
  on public.client_duplicate_dismissals for delete to authenticated
  using (public.is_business_member(business_id));

revoke all on table public.client_duplicate_dismissals from public, anon, authenticated;
grant select, insert, delete on table public.client_duplicate_dismissals to authenticated;

-- A phone number as digits, French prefixes folded: null when too short to
-- compare. Pure: reads nothing.
create function public.crm_phone_key(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.length(d.digits) < 8 then null
    when d.digits like '0033%' then '0' || pg_catalog.substr(d.digits, 5)
    when d.digits like '330%' and pg_catalog.length(d.digits) = 12 then '0' || pg_catalog.substr(d.digits, 4)
    when d.digits like '33%' and pg_catalog.length(d.digits) = 11 then '0' || pg_catalog.substr(d.digits, 3)
    else d.digits
  end
  from (
    select pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits
  ) d;
$$;

-- A full name, folded: null without a last name. Pure: reads nothing.
create function public.crm_name_key(p_first_name text, p_last_name text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when nullif(pg_catalog.btrim(coalesce(p_last_name, '')), '') is null then null
    else pg_catalog.btrim(pg_catalog.regexp_replace(
      pg_catalog.lower(extensions.unaccent(
        'extensions.unaccent'::regdictionary,
        p_first_name || ' ' || p_last_name
      )),
      '[^a-z0-9]+', ' ', 'g'
    ))
  end;
$$;

-- The pairs to check, strongest first (phone and name, then phone, then
-- name; the most recent first), 50 at most, each record with what tells it
-- apart.
create function public.crm_duplicate_candidates(p_business_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  with keyed as (
    select c.id, c.created_at,
      public.crm_phone_key(c.phone) as phone_key,
      public.crm_name_key(c.first_name, c.last_name) as name_key
    from public.clients c
    where c.business_id = p_business_id and c.erased_at is null
  ),
  matches as (
    select a.id as a_id, b.id as b_id, 'phone'::text as reason,
      greatest(a.created_at, b.created_at) as latest
    from keyed a join keyed b on b.phone_key = a.phone_key and a.id < b.id
    union all
    select a.id, b.id, 'name', greatest(a.created_at, b.created_at)
    from keyed a join keyed b on b.name_key = a.name_key and a.id < b.id
  ),
  pairs as (
    select m.a_id, m.b_id,
      pg_catalog.array_agg(m.reason order by m.reason desc) as reasons,
      pg_catalog.max(m.latest) as latest
    from matches m
    where not exists (
      select 1 from public.client_duplicate_dismissals d
      where d.business_id = p_business_id
        and d.client_a = m.a_id and d.client_b = m.b_id
    )
    group by m.a_id, m.b_id
  ),
  ranked as (
    select p.*, pg_catalog.count(*) over () as total
    from pairs p
    order by pg_catalog.cardinality(p.reasons) desc, p.reasons desc, p.latest desc, p.a_id, p.b_id
    limit 50
  ),
  summaries as (
    select c.id, pg_catalog.jsonb_build_object(
      'id', c.id,
      'firstName', c.first_name,
      'lastName', c.last_name,
      'email', c.email,
      'phone', c.phone,
      'createdAt', c.created_at,
      'pastVisits', pg_catalog.count(a.id) filter (
        where a.status in ('confirmed', 'completed') and a.starts_at < pg_catalog.now()
      ),
      'upcoming', pg_catalog.count(a.id) filter (
        where a.status = 'confirmed' and a.starts_at >= pg_catalog.now()
      ),
      'lastVisitAt', pg_catalog.max(a.starts_at) filter (
        where a.status in ('confirmed', 'completed') and a.starts_at < pg_catalog.now()
      )
    ) as summary
    from public.clients c
    left join public.appointments a
      on a.client_id = c.id and a.business_id = p_business_id
    where c.business_id = p_business_id
      and c.id in (select r.a_id from ranked r union select r.b_id from ranked r)
    group by c.id
  )
  select pg_catalog.jsonb_build_object(
    'pairs', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'reasons', pg_catalog.to_jsonb(r.reasons),
      'clients', pg_catalog.jsonb_build_array(sa.summary, sb.summary)
    ) order by pg_catalog.cardinality(r.reasons) desc, r.reasons desc, r.latest desc, r.a_id, r.b_id), '[]'::jsonb),
    'total', coalesce(pg_catalog.max(r.total), 0)
  )
  into v_result
  from ranked r
  join summaries sa on sa.id = r.a_id
  join summaries sb on sb.id = r.b_id;

  return v_result;
end;
$$;

-- « Ce n'est pas la même personne », or its undo. Idempotent.
create function public.crm_set_duplicate_dismissed(
  p_business_id uuid,
  p_client_id uuid,
  p_other_id uuid,
  p_dismissed boolean
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_a uuid := least(p_client_id, p_other_id);
  v_b uuid := greatest(p_client_id, p_other_id);
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_client_id is null or p_other_id is null or p_dismissed is null
    or p_client_id = p_other_id then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  if (
    select pg_catalog.count(*) from public.clients c
    where c.business_id = p_business_id and c.id in (p_client_id, p_other_id)
  ) <> 2 then
    raise exception using errcode = 'P0002', message = 'client_not_found';
  end if;

  if p_dismissed then
    insert into public.client_duplicate_dismissals (business_id, client_a, client_b)
    values (p_business_id, v_a, v_b)
    on conflict do nothing;
  else
    delete from public.client_duplicate_dismissals d
    where d.business_id = p_business_id and d.client_a = v_a and d.client_b = v_b;
  end if;
  return pg_catalog.jsonb_build_object('dismissed', p_dismissed);
end;
$$;

revoke all on function public.crm_phone_key(text) from public, anon;
grant execute on function public.crm_phone_key(text) to authenticated;
revoke all on function public.crm_name_key(text, text) from public, anon;
grant execute on function public.crm_name_key(text, text) to authenticated;
revoke all on function public.crm_duplicate_candidates(uuid) from public, anon;
grant execute on function public.crm_duplicate_candidates(uuid) to authenticated;
revoke all on function public.crm_set_duplicate_dismissed(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.crm_set_duplicate_dismissed(uuid, uuid, uuid, boolean) to authenticated;
