-- Her usual weekly opening hours, for the "Infos pratiques" of her public
-- mini-site (Higani point 5). Read-only, by slug, with the same visibility
-- as get_public_business: whoever can read her public profile can read her
-- usual hours (her public availability already shows when she works).
--
-- Usual hours only (business_hours). Exceptions by date (business_date_hours:
-- days off, special hours) are not here: the page labels these hours as
-- usual and leaves the day-by-day truth to the slots, so it never states
-- "open today" against them. Several ranges a day (a lunch break) come as
-- several rows. No internal identifier leaves the function.
create function public.get_public_business_hours(p_slug text)
returns table (
  weekday smallint,
  starts_at time,
  ends_at time
)
language sql
stable
security definer
set search_path = ''
as $$
  select h.weekday, h.starts_at, h.ends_at
  from public.business_hours h
  where h.business_id = private.business_id_by_slug(p_slug)
  order by h.weekday, h.starts_at;
$$;
revoke all on function public.get_public_business_hours(text) from public;
grant execute on function public.get_public_business_hours(text) to anon, authenticated, service_role;
