-- Point 205 with the client reviews (point 8, 20261122180000): her review of
-- this business is part of what it holds about her. The export includes it;
-- the erasure deletes it (stars and comment: the average changes).
--
-- A review belongs to a client space account (an address), not to a client
-- record: hers are the accounts at the address of her record or at an
-- address one of her appointments here was booked with. Other businesses'
-- reviews are never touched.
--
-- Both functions keep their contract and their checks: the former bodies
-- move to private and the public ones wrap them.

alter function public.privacy_export_client(uuid, uuid) set schema private;
alter function private.privacy_export_client(uuid, uuid) rename to privacy_export_client_base;
revoke all on function private.privacy_export_client_base(uuid, uuid) from public, anon, authenticated;

alter function public.privacy_erase_client(uuid, uuid, integer) set schema private;
alter function private.privacy_erase_client(uuid, uuid, integer) rename to privacy_erase_client_base;
revoke all on function private.privacy_erase_client_base(uuid, uuid, integer) from public, anon, authenticated;

-- Her addresses at this business, canonical: her record's and those her
-- appointments here were booked with.
create function private.privacy_client_addresses(p_business_id uuid, p_client_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct address), '{}')
  from (
    select private.canonical_email(c.email::text) as address
    from public.clients c
    where c.id = p_client_id and c.business_id = p_business_id
    union all
    select private.canonical_email(a.client_email_snapshot::text)
    from public.appointments a
    where a.client_id = p_client_id and a.business_id = p_business_id
  ) known
  where address is not null;
$$;

revoke all on function private.privacy_client_addresses(uuid, uuid) from public, anon, authenticated;

create function public.privacy_export_client(p_business_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_export jsonb;
begin
  -- Its checks first (forbidden, client_not_found).
  v_export := private.privacy_export_client_base(p_business_id, p_client_id);
  return v_export || pg_catalog.jsonb_build_object(
    'reviews', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'stars', r.stars,
        'comment', r.comment,
        'postedAt', r.posted_at
      ) order by r.posted_at)
      from private.business_reviews r
      join private.client_hub_accounts acc on acc.id = r.account_id
      where r.business_id = p_business_id
        and acc.email::text = any (private.privacy_client_addresses(p_business_id, p_client_id))
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.privacy_export_client(uuid, uuid) from public, anon, authenticated;
grant execute on function public.privacy_export_client(uuid, uuid) to authenticated;

create function public.privacy_erase_client(
  p_business_id uuid,
  p_client_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_addresses text[];
  v_result jsonb;
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  -- Her record locked first, as the erasure does, then her addresses read
  -- before the erasure clears them.
  perform 1 from public.clients c
  where c.id = p_client_id and c.business_id = p_business_id
  for update;
  v_addresses := private.privacy_client_addresses(p_business_id, p_client_id);

  v_result := private.privacy_erase_client_base(p_business_id, p_client_id, p_expected_version);

  if (v_result ->> 'erased')::boolean then
    delete from private.business_reviews r
    using private.client_hub_accounts acc
    where r.business_id = p_business_id
      and r.account_id = acc.id
      and acc.email::text = any (v_addresses);
  end if;
  return v_result;
end;
$$;

revoke all on function public.privacy_erase_client(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.privacy_erase_client(uuid, uuid, integer) to authenticated;
