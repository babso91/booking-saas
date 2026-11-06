-- Moving one category, applied to the order as it is now (Codex's audit of
-- #39). reorder_service_categories replaces the whole order with the one a
-- tab sent: two tabs moving different categories from the same reading
-- erased each other's move, silently (the last one wins). A move is one
-- step up or down from where the category is when the move is applied,
-- under the business's schedule lock: two moves are applied one after the
-- other, each on the result of the one before, and both are kept.
-- Additive: reorder_service_categories is unchanged.

create function public.move_service_category(
  p_business_id uuid,
  p_category_id uuid,
  p_offset integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid[];
  v_from integer;
  v_to integer;
begin
  perform private.assert_catalog_access(p_business_id);
  perform private.lock_business_schedule(p_business_id);

  if p_offset is null or p_offset not in (-1, 1) then
    raise exception using errcode = '22023', message = 'invalid_category_order';
  end if;

  -- Her order now, as get_catalog shows it.
  select coalesce(
    pg_catalog.array_agg(c.id order by c.display_order, c.name, c.id),
    '{}'::uuid[]
  )
  into v_order
  from public.service_categories c
  where c.business_id = p_business_id;

  v_from := pg_catalog.array_position(v_order, p_category_id);
  if v_from is null then
    raise exception using errcode = 'P0002', message = 'category_not_found', hint = 'categoryId';
  end if;

  v_to := v_from + p_offset;
  -- Already first (or last): nothing to move.
  if v_to < 1 or v_to > pg_catalog.cardinality(v_order) then
    return;
  end if;

  v_order[v_from] := v_order[v_to];
  v_order[v_to] := p_category_id;

  update public.service_categories c
  set display_order = o.position - 1
  from pg_catalog.unnest(v_order) with ordinality as o(id, position)
  where c.id = o.id
    and c.business_id = p_business_id
    and c.display_order is distinct from (o.position - 1)::integer;
end;
$$;

revoke all on function public.move_service_category(uuid, uuid, integer) from public, anon;
grant execute on function public.move_service_category(uuid, uuid, integer) to authenticated;
