-- One consistent read for a visible week or month. Return only the starts
-- already available from the public per-day endpoint.
create function public.get_public_availability_calendar(
  p_slug text,
  p_service_id uuid,
  p_from date,
  p_to date,
  p_option_choice_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to - p_from not between 0 and 30 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'date';
  end if;

  return (
    select jsonb_agg(jsonb_build_object(
      'date', p_from + d.offset_days,
      'slots', coalesce((
        select jsonb_agg(jsonb_build_object(
          'startsAt', slot.value->>'startsAt',
          'localStartsAt', slot.value->>'localStartsAt'
        ) order by slot.ordinal)
        from jsonb_array_elements(public.get_public_availability(
          p_slug, p_service_id, p_from + d.offset_days, p_option_choice_ids
        )->'slots') with ordinality as slot(value, ordinal)
      ), '[]'::jsonb)
    ) order by d.offset_days)
    from generate_series(0, p_to - p_from) as d(offset_days)
  );
end;
$$;

revoke all on function public.get_public_availability_calendar(text, uuid, date, date, uuid[]) from public;
grant execute on function public.get_public_availability_calendar(text, uuid, date, date, uuid[]) to anon, authenticated, service_role;
