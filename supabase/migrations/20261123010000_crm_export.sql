-- Points 146 and 182 (Higani backlog): she takes her client file out, to
-- keep it or to move to another software. The screen was proposed by the UI
-- (PR #74, docs/CRM_EXPORT_PROPOSAL.md); this is its server.
--
-- One choice differs from the proposal, for her clients' sake: no file is
-- ever stored. An export is a short-lived permission (24 hours) with its
-- scope and its row count; the CSV is built at each download, from her own
-- session and under RLS. Nothing personal waits on a disk, and a revoked or
-- expired export gives nothing at all.
--
-- The owner only (not an admin, not a practitioner), checked again at every
-- download; each download is counted and dated, never its content. Erased
-- records (point 205) are never exported. Like every CRM function, these
-- run as the caller (crm-read-model.test.ts).

create table public.crm_export_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  request_id uuid not null,
  scope text not null check (scope in ('contacts', 'contacts_and_visits')),
  -- 'expired' is not stored: a ready export past expires_at is expired.
  status text not null default 'ready'
    check (status in ('requested', 'ready', 'revoked', 'failed')),
  requested_by uuid default auth.uid() references public.profiles (id) on delete set null,
  requested_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz,
  row_count integer check (row_count >= 0),
  revoked_at timestamptz,
  download_count integer not null default 0 check (download_count >= 0),
  last_downloaded_at timestamptz,
  unique (business_id, request_id),
  check ((status = 'ready') = (expires_at is not null))
);

create index crm_export_jobs_business_idx
  on public.crm_export_jobs (business_id, requested_at desc);

alter table public.crm_export_jobs enable row level security;

create policy crm_export_jobs_select_owner
  on public.crm_export_jobs for select to authenticated
  using (public.has_business_role(business_id, array['owner']::public.business_member_role[]));
create policy crm_export_jobs_insert_owner
  on public.crm_export_jobs for insert to authenticated
  with check (public.has_business_role(business_id, array['owner']::public.business_member_role[]));
create policy crm_export_jobs_update_owner
  on public.crm_export_jobs for update to authenticated
  using (public.has_business_role(business_id, array['owner']::public.business_member_role[]))
  with check (public.has_business_role(business_id, array['owner']::public.business_member_role[]));

revoke all on table public.crm_export_jobs from public, anon, authenticated;
grant select, insert, update on table public.crm_export_jobs to authenticated;

-- Her session, owner of this business: permission_denied otherwise.
create function public.crm_export_assert_owner(p_business_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null or not public.has_business_role(
    p_business_id, array['owner']::public.business_member_role[]
  ) then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
end;
$$;

-- An export as the screen reads it (ExportJobDto). Two arguments, so that
-- it is never offered as a computed column of the table.
create function public.crm_export_job_json(p_job public.crm_export_jobs, p_now timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'jobId', p_job.id,
    'scope', p_job.scope,
    'status', case
      when p_job.status = 'ready' and p_job.expires_at <= p_now then 'expired'
      else p_job.status
    end,
    'requestedAt', p_job.requested_at,
    'expiresAt', p_job.expires_at,
    'rowCount', p_job.row_count
  );
$$;

-- The rows of a scope: one per record, or one per visit (a record without
-- any visit still has its row). Erased records never.
create function public.crm_export_count(p_business_id uuid, p_scope text)
returns integer
language sql
stable
set search_path = ''
as $$
  select case p_scope
    when 'contacts' then (
      select pg_catalog.count(*)::integer from public.clients c
      where c.business_id = p_business_id and c.erased_at is null
    )
    else (
      select coalesce(pg_catalog.sum(greatest(v.visits, 1)), 0)::integer
      from (
        select (
          select pg_catalog.count(*) from public.appointments a
          where a.business_id = p_business_id and a.client_id = c.id
        ) as visits
        from public.clients c
        where c.business_id = p_business_id and c.erased_at is null
      ) v
    )
  end;
$$;

-- Her exports, the most recent first (20 at most).
create function public.crm_export_list(p_business_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  perform public.crm_export_assert_owner(p_business_id);
  return coalesce((
    select pg_catalog.jsonb_agg(x.job order by x.requested_at desc, x.id)
    from (
      select public.crm_export_job_json(e, pg_catalog.now()) as job,
        e.requested_at, e.id
      from public.crm_export_jobs e
      where e.business_id = p_business_id
      order by e.requested_at desc, e.id
      limit 20
    ) x
  ), '[]'::jsonb);
end;
$$;

-- A new export, ready at once for 24 hours. The same request_id answers the
-- same export (a lost response, a double click); another scope under it is
-- idempotency_conflict.
create function public.crm_export_request(
  p_business_id uuid,
  p_request_id uuid,
  p_scope text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_job public.crm_export_jobs;
begin
  perform public.crm_export_assert_owner(p_business_id);
  if p_request_id is null or p_scope is null
    or p_scope not in ('contacts', 'contacts_and_visits') then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  select * into v_job from public.crm_export_jobs e
  where e.business_id = p_business_id and e.request_id = p_request_id;
  if found then
    if v_job.scope <> p_scope then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return public.crm_export_job_json(v_job, pg_catalog.now());
  end if;

  if exists (
    select 1 from public.crm_export_jobs e
    where e.business_id = p_business_id and e.status = 'requested'
  ) then
    raise exception using errcode = 'P0001', message = 'export_in_progress';
  end if;

  insert into public.crm_export_jobs (
    business_id, request_id, scope, status, expires_at, row_count
  )
  values (
    p_business_id, p_request_id, p_scope, 'ready',
    pg_catalog.now() + interval '24 hours',
    public.crm_export_count(p_business_id, p_scope)
  )
  on conflict (business_id, request_id) do nothing
  returning * into v_job;

  if v_job.id is null then
    -- The same request, sent twice at the same moment: the first one won.
    select * into v_job from public.crm_export_jobs e
    where e.business_id = p_business_id and e.request_id = p_request_id;
    if v_job.scope <> p_scope then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
  end if;
  return public.crm_export_job_json(v_job, pg_catalog.now());
end;
$$;

-- Withdrawn at once: nothing can be downloaded from it any more. Idempotent.
create function public.crm_export_revoke(p_business_id uuid, p_job_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_job public.crm_export_jobs;
begin
  perform public.crm_export_assert_owner(p_business_id);
  update public.crm_export_jobs e
  set status = 'revoked',
      expires_at = null,
      revoked_at = coalesce(e.revoked_at, pg_catalog.now())
  where e.business_id = p_business_id and e.id = p_job_id
    and e.status in ('ready', 'requested', 'revoked')
  returning * into v_job;
  if not found then
    select * into v_job from public.crm_export_jobs e
    where e.business_id = p_business_id and e.id = p_job_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'export_not_found';
    end if;
  end if;
  return public.crm_export_job_json(v_job, pg_catalog.now());
end;
$$;

-- One download: her role and the export checked again, the download counted
-- and dated (never its content), and the rows read now, under RLS. Times are
-- wall clocks of the business, as she reads her agenda. Sorted by last
-- name (her first name when she has none), then first name.
create function public.crm_export_rows(p_business_id uuid, p_job_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_job public.crm_export_jobs;
  v_timezone text;
  v_currency text;
  v_rows jsonb;
begin
  perform public.crm_export_assert_owner(p_business_id);

  select * into v_job from public.crm_export_jobs e
  where e.business_id = p_business_id and e.id = p_job_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'export_not_found';
  end if;
  if v_job.status <> 'ready' or v_job.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'export_expired';
  end if;

  update public.crm_export_jobs e
  set download_count = e.download_count + 1,
      last_downloaded_at = pg_catalog.now()
  where e.id = v_job.id;

  select b.timezone, st.currency into v_timezone, v_currency
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  where b.id = p_business_id;

  if v_job.scope = 'contacts' then
    select coalesce(pg_catalog.jsonb_agg(r.item order by r.last_name, r.first_name, r.id), '[]'::jsonb)
    into v_rows
    from (
      select c.id, pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(c.last_name), ''), c.first_name)) as last_name,
        pg_catalog.lower(c.first_name) as first_name,
        pg_catalog.jsonb_build_object(
          'firstName', c.first_name,
          'lastName', c.last_name,
          'email', c.email,
          'phone', c.phone,
          'createdOn', pg_catalog.to_char(c.created_at at time zone v_timezone, 'YYYY-MM-DD'),
          'pastVisits', (
            select pg_catalog.count(*) from public.appointments a
            where a.business_id = p_business_id and a.client_id = c.id
              and a.status in ('confirmed', 'completed') and a.starts_at < pg_catalog.now()
          ),
          'lastVisitAt', (
            select pg_catalog.to_char(pg_catalog.max(a.starts_at) at time zone v_timezone, 'YYYY-MM-DD HH24:MI')
            from public.appointments a
            where a.business_id = p_business_id and a.client_id = c.id
              and a.status in ('confirmed', 'completed') and a.starts_at < pg_catalog.now()
          ),
          'nextVisitAt', (
            select pg_catalog.to_char(pg_catalog.min(a.starts_at) at time zone v_timezone, 'YYYY-MM-DD HH24:MI')
            from public.appointments a
            where a.business_id = p_business_id and a.client_id = c.id
              and a.status = 'confirmed' and a.starts_at >= pg_catalog.now()
          )
        ) as item
      from public.clients c
      where c.business_id = p_business_id and c.erased_at is null
    ) r;
  else
    select coalesce(pg_catalog.jsonb_agg(r.item order by r.last_name, r.first_name, r.client_id, r.starts_at nulls first), '[]'::jsonb)
    into v_rows
    from (
      select c.id as client_id, a.starts_at,
        pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(c.last_name), ''), c.first_name)) as last_name,
        pg_catalog.lower(c.first_name) as first_name,
        pg_catalog.jsonb_build_object(
          'firstName', c.first_name,
          'lastName', c.last_name,
          'email', c.email,
          'phone', c.phone,
          'visitAt', pg_catalog.to_char(a.starts_at at time zone v_timezone, 'YYYY-MM-DD HH24:MI'),
          'service', a.service_name_snapshot,
          'durationMinutes', a.duration_minutes_snapshot,
          'priceCents', a.price_cents_snapshot,
          'status', case
            when a.id is null then null
            when a.status = 'confirmed' and a.starts_at >= pg_catalog.now() then 'upcoming'
            when a.status = 'confirmed' then 'past'
            else a.status::text
          end
        ) as item
      from public.clients c
      left join public.appointments a
        on a.business_id = p_business_id and a.client_id = c.id
      where c.business_id = p_business_id and c.erased_at is null
    ) r;
  end if;

  return pg_catalog.jsonb_build_object(
    'scope', v_job.scope,
    'currency', v_currency,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.crm_export_assert_owner(uuid) from public, anon;
grant execute on function public.crm_export_assert_owner(uuid) to authenticated;
revoke all on function public.crm_export_job_json(public.crm_export_jobs, timestamptz) from public, anon;
grant execute on function public.crm_export_job_json(public.crm_export_jobs, timestamptz) to authenticated;
revoke all on function public.crm_export_count(uuid, text) from public, anon;
grant execute on function public.crm_export_count(uuid, text) to authenticated;
revoke all on function public.crm_export_list(uuid) from public, anon;
grant execute on function public.crm_export_list(uuid) to authenticated;
revoke all on function public.crm_export_request(uuid, uuid, text) from public, anon;
grant execute on function public.crm_export_request(uuid, uuid, text) to authenticated;
revoke all on function public.crm_export_revoke(uuid, uuid) from public, anon;
grant execute on function public.crm_export_revoke(uuid, uuid) to authenticated;
revoke all on function public.crm_export_rows(uuid, uuid) from public, anon;
grant execute on function public.crm_export_rows(uuid, uuid) to authenticated;
