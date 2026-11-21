-- The public projection contains no account, appointment or contact identifiers.
create table private.business_reviews (
  business_id uuid not null references public.businesses(id) on delete cascade,
  account_id uuid not null references private.client_hub_accounts(id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  comment text not null default '' check (char_length(comment) <= 500),
  posted_at timestamptz not null default now(),
  primary key (business_id, account_id)
);
revoke all on private.business_reviews from public, anon, authenticated;
create index business_reviews_newest on private.business_reviews (business_id, posted_at desc, account_id);

create function public.get_public_business_reviews(p_slug text, p_offset integer default 0)
returns jsonb language sql stable security definer set search_path = '' as $$
  with target as (select private.business_id_by_slug(p_slug) as id),
  totals as (
    select count(*) as count, round(avg(r.stars), 1) as average
    from private.business_reviews r, target t where r.business_id = t.id
  ), reviews as (
    select r.stars, r.comment, r.posted_at, r.account_id
    from private.business_reviews r, target t where r.business_id = t.id
    order by r.posted_at desc, r.account_id limit 12 offset greatest(p_offset, 0)
  )
  select jsonb_build_object('count', totals.count, 'average', totals.average,
    'reviews', coalesce((select jsonb_agg(jsonb_build_object(
      'stars', stars, 'comment', comment, 'date', (posted_at at time zone 'UTC')::date
    ) order by posted_at desc, account_id) from reviews), '[]'::jsonb))
  from totals, target where target.id is not null;
$$;
revoke all on function public.get_public_business_reviews(text, integer) from public;
grant execute on function public.get_public_business_reviews(text, integer) to anon, authenticated, service_role;

-- A read returns only the verified visitor's own review and eligibility.
-- Posting rechecks the same appointment after the booking / access write locks.
create function public.client_hub_business_review(
  p_session_token text, p_slug text, p_stars integer default null, p_comment text default ''
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, now());
  v_business uuid := private.business_id_by_slug(p_slug);
  v_client uuid;
  v_visit uuid;
  v_review private.business_reviews;
begin
  if v_business is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;
  v_client := private.client_hub_client(v_account, v_business);
  select a.id into v_visit from public.appointments a
  where a.business_id = v_business and a.ends_at <= now()
    and a.status in ('confirmed', 'completed')
    and (a.client_id = v_client or (
      private.canonical_email(a.client_email_snapshot) = v_account.email::text
      and private.client_hub_emailed_appointment(v_account, v_business, a.id) is not null))
  order by a.ends_at desc, a.id limit 1;
  if v_visit is null then return jsonb_build_object('eligible', false); end if;

  if p_stars is not null then
    if p_stars not between 1 and 5 or char_length(coalesce(p_comment, '')) > 500 then
      raise exception using errcode = '22023', message = 'invalid_input';
    end if;
    perform private.hub_lock_for_write(p_session_token, v_business, v_visit, now());
    if not exists (select 1 from public.appointments a where a.id = v_visit
      and a.ends_at <= now() and a.status in ('confirmed', 'completed')) then
      return jsonb_build_object('eligible', false);
    end if;
    insert into private.business_reviews (business_id, account_id, stars, comment)
    values (v_business, v_account.id, p_stars, btrim(coalesce(p_comment, '')))
    on conflict (business_id, account_id) do update
      set stars = excluded.stars, comment = excluded.comment;
  end if;
  select * into v_review from private.business_reviews r
    where r.business_id = v_business and r.account_id = v_account.id;
  return jsonb_build_object('eligible', true, 'stars', v_review.stars, 'comment', v_review.comment);
end;
$$;
revoke all on function public.client_hub_business_review(text, text, integer, text) from public, anon, authenticated;
grant execute on function public.client_hub_business_review(text, text, integer, text) to service_role;
