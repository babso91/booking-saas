-- Point 41 (Higani backlog): duplicating a service. The copy takes the
-- description, price, length, category, questions with their answers, the
-- people who perform it and its loyalty points; she then changes only what
-- differs. It starts hidden, so a half-edited copy never shows on her page,
-- and sits right after the original (same position, its name sorts after).
-- Nothing booked is copied: appointments, waiting lists and rewards stay
-- with the original.
--
-- Idempotent by request id, like create_service (same request table): a
-- retry answers the same copy, another command under the same id is an
-- idempotency_conflict.

create function public.duplicate_service(
  p_business_id uuid,
  p_request_id uuid,
  p_service_id uuid,
  p_name text default null
)
returns table (status text, service_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_existing record;
  v_source public.services;
  v_name text := nullif(pg_catalog.btrim(p_name), '');
  v_copy uuid;
  v_option record;
  v_new_option uuid;
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_service_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'serviceId';
  end if;
  if v_name is not null and pg_catalog.char_length(v_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'name';
  end if;

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'duplicate_of', p_service_id,
        'name', v_name
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

  -- The original as it is now, unchanged until the copy is done.
  select s.* into v_source
  from public.services s
  where s.id = p_service_id and s.business_id = p_business_id
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'service_not_found', hint = 'serviceId';
  end if;

  insert into public.services (
    business_id, name, description, duration_minutes, price_cents, active,
    display_order, category_id
  )
  values (
    p_business_id,
    coalesce(
      v_name,
      pg_catalog.left(v_source.name, 120 - pg_catalog.char_length(' (copie)')) || ' (copie)'
    ),
    v_source.description,
    v_source.duration_minutes,
    v_source.price_cents,
    false,
    v_source.display_order,
    v_source.category_id
  )
  returning id into v_copy;

  for v_option in
    select o.id, o.question, o.required, o.display_order
    from public.service_options o
    where o.service_id = p_service_id and o.business_id = p_business_id
    order by o.display_order, o.id
  loop
    insert into public.service_options (business_id, service_id, question, required, display_order)
    values (p_business_id, v_copy, v_option.question, v_option.required, v_option.display_order)
    returning id into v_new_option;

    insert into public.service_option_choices (
      business_id, option_id, label, price_delta_cents, duration_delta_minutes, display_order
    )
    select p_business_id, v_new_option, c.label, c.price_delta_cents,
      c.duration_delta_minutes, c.display_order
    from public.service_option_choices c
    where c.option_id = v_option.id and c.business_id = p_business_id
    order by c.display_order, c.id;
  end loop;

  -- The sole member of a team of one may already have it (trigger).
  insert into public.staff_services (staff_id, business_id, service_id)
  select ss.staff_id, p_business_id, v_copy
  from public.staff_services ss
  where ss.service_id = p_service_id and ss.business_id = p_business_id
  on conflict do nothing;

  insert into public.loyalty_service_rules (business_id, service_id, points)
  select p_business_id, v_copy, r.points
  from public.loyalty_service_rules r
  where r.service_id = p_service_id and r.business_id = p_business_id;

  update private.service_creation_requests r
  set service_id = v_copy
  where r.business_id = p_business_id
    and r.request_id = p_request_id;

  return query select 'created'::text, v_copy;
end;
$$;

revoke all on function public.duplicate_service(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.duplicate_service(uuid, uuid, uuid, text) to authenticated;
