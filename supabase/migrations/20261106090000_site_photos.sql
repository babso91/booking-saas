-- Mini-site photos: real storage, verification, private preview, public
-- serving limited to the published version, and revocation
-- (docs/SITE_PUBLISHING_CONTRACT.md § 8).
--
-- Files live in the PRIVATE bucket site-photos, under
-- <business_id>/<asset_id>/: `original` and the WebP derivatives
-- `w480.webp`, `w828.webp`, `w1200.webp`. No storage policy is granted to
-- the API roles: the browser uploads its original with a signed upload URL
-- the server issued after checking membership; only the service reads.
--
-- A photo's life: pending (uploaded, not verified) → ready (verified,
-- derivatives made) → revoked (final). Revoking never touches a published
-- version (history stays immutable): the photo is no longer served, its
-- files are deleted, and every render (public, preview, a restored old
-- version) shows its place without a photo. A revoked photo never comes
-- back: a new upload is a new asset.

-- ---------------------------------------------------------------------------
-- Bucket (private)
-- ---------------------------------------------------------------------------

do $$
begin
  if pg_catalog.to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'site-photos', 'site-photos', false, 10485760,
      array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Assets: their life
-- ---------------------------------------------------------------------------

alter table public.site_assets
  drop constraint site_assets_status_check,
  add constraint site_assets_status_check
    check (status in ('pending', 'ready', 'revoked')),
  drop constraint site_assets_content_type_check,
  -- The REAL type, found by decoding the file (not the one declared).
  add constraint site_assets_content_type_check
    check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  add column created_by uuid references public.profiles (id) on delete set null,
  add column revoked_at timestamptz,
  add column revoked_reason text check (revoked_reason in ('owner', 'privacy')),
  add constraint site_assets_revocation_complete check (
    (status = 'revoked') = (revoked_at is not null)
    and (revoked_at is null) = (revoked_reason is null)
  ),
  add constraint site_assets_ready_complete check (
    status <> 'ready'
    or (content_type is not null and width is not null and height is not null)
  );

create index site_assets_pending_idx
  on public.site_assets (business_id, created_at)
  where status = 'pending';

-- A configuration may refer to her ready photos, and to her revoked ones
-- (an old version restored: rendered without the photo). Never to a
-- pending one, another business's, or one that does not exist.
create or replace function private.assert_site_assets(p_business_id uuid, p_config jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_refs text[];
  v_ids uuid[];
begin
  select coalesce(pg_catalog.array_agg(ref), '{}')
  into v_refs
  from (
    select pg_catalog.jsonb_path_query(p_config, 'lax $.**.asset') #>> '{}' as ref
    union all
    select pg_catalog.jsonb_object_keys(
      case when pg_catalog.jsonb_typeof(p_config #> '{content,focals}') = 'object'
        then p_config #> '{content,focals}' else '{}'::jsonb end
    )
  ) refs;

  begin
    v_ids := v_refs::uuid[];
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_site_config', hint = 'config';
  end;

  if exists (
    select 1 from pg_catalog.unnest(v_ids) as u(id)
    where u.id is null or not exists (
      select 1 from public.site_assets a
      where a.id = u.id
        and a.business_id = p_business_id
        and a.status in ('ready', 'revoked')
    )
  ) then
    raise exception using errcode = 'P0001', message = 'site_asset_unavailable', hint = 'config';
  end if;
end;
$$;

-- The photos a configuration refers to that cannot be shown (revoked):
-- the renderer draws their places without a photo.
create function private.site_unavailable_assets(p_business_id uuid, p_config jsonb)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct a.id order by a.id), '{}')
  from public.site_assets a
  where a.business_id = p_business_id
    and a.status <> 'ready'
    and a.id::text in (
      select pg_catalog.lower(pg_catalog.jsonb_path_query(p_config, 'lax $.**.asset') #>> '{}')
      union all
      select pg_catalog.lower(pg_catalog.jsonb_object_keys(
        case when pg_catalog.jsonb_typeof(p_config #> '{content,focals}') = 'object'
          then p_config #> '{content,focals}' else '{}'::jsonb end
      ))
    );
$$;

revoke all on function private.site_unavailable_assets(uuid, jsonb) from public;

-- Whether a configuration refers to this photo.
create function private.site_config_refers_to(p_config jsonb, p_asset_id uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.jsonb_path_query(p_config, 'lax $.**.asset') as ref
    where pg_catalog.lower(ref #>> '{}') = p_asset_id::text
  ) or (
    pg_catalog.jsonb_typeof(p_config #> '{content,focals}') = 'object'
    and exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_config #> '{content,focals}') as key
      where pg_catalog.lower(key) = p_asset_id::text
    )
  );
$$;

revoke all on function private.site_config_refers_to(jsonb, uuid) from public;

-- ---------------------------------------------------------------------------
-- Purges: the files to delete, recorded with the decision
-- ---------------------------------------------------------------------------

-- Every decision that makes files useless (a photo made ready: its
-- original; revoked, deleted, discarded, or gone with its business: all its
-- files) records a purge IN THE SAME TRANSACTION. The service deletes the
-- files, then completes the purge; a purge left (failed or interrupted
-- removal) is retried: by the same action called again, or by the cleanup
-- of pending purges. No file outlives its decision unnoticed.
create table public.site_photo_purges (
  -- No foreign key: a purge outlives its photo and its business.
  business_id uuid not null,
  asset_id uuid not null,
  -- original: the uploaded file (EXIF, GPS); all: every file of the photo.
  scope text not null check (scope in ('original', 'all')),
  requested_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  -- Its files were deleted at that moment, but the photo's signed upload
  -- URL could still write its original (Storage accepts it again once the
  -- path is free, for 2 hours): the purge is run again once `not_before`
  -- has passed, and only then forgotten (Codex audit).
  last_done_at timestamptz,
  not_before timestamptz not null default now(),
  primary key (asset_id, scope)
);

create index site_photo_purges_requested_idx
  on public.site_photo_purges (requested_at);

alter table public.site_photo_purges enable row level security;
revoke all on table public.site_photo_purges from public, anon, authenticated;

-- How long after a photo's creation its signed upload URL may still write:
-- Storage's 2 hours, plus a margin for clocks and requests in flight.
create function private.site_photo_upload_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '2 hours 10 minutes' $$;

revoke all on function private.site_photo_upload_window() from public;

-- Records a purge of a photo created at `p_created_at`; it is final only
-- once that photo's upload URL can no longer write. Recorded again (a
-- revocation after the original's purge, say): to be run again now.
create function private.queue_site_photo_purge(
  p_business_id uuid,
  p_asset_id uuid,
  p_scope text,
  p_created_at timestamptz
)
returns void
language sql
set search_path = ''
as $$
  insert into public.site_photo_purges (business_id, asset_id, scope, not_before)
  values (
    p_business_id, p_asset_id, p_scope,
    greatest(pg_catalog.now(), p_created_at + private.site_photo_upload_window())
  )
  on conflict (asset_id, scope) do update
  set last_done_at = null,
      not_before = greatest(public.site_photo_purges.not_before, excluded.not_before);
$$;

revoke all on function private.queue_site_photo_purge(uuid, uuid, text, timestamptz) from public;

-- A photo's row gone, however (deleted, discarded, its business deleted):
-- its files are to be deleted.
create function private.site_asset_deleted()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.queue_site_photo_purge(old.business_id, old.id, 'all', old.created_at);
  return old;
end;
$$;

create trigger site_assets_purge_files
  after delete on public.site_assets
  for each row execute function private.site_asset_deleted();

-- The files of this purge are deleted: done. `all` covers `original`.
-- Forgotten only once the upload URL can no longer write (not_before);
-- until then kept, done, for the cleanup to run it once more after.
create function public.complete_site_photo_purge(p_business_id uuid, p_asset_id uuid, p_scope text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.site_photo_purges p
  where p.asset_id = p_asset_id
    and p.business_id = p_business_id
    and (p.scope = p_scope or p_scope = 'all')
    and p.not_before <= pg_catalog.now();
  update public.site_photo_purges p
  set last_done_at = pg_catalog.now()
  where p.asset_id = p_asset_id
    and p.business_id = p_business_id
    and (p.scope = p_scope or p_scope = 'all');
end;
$$;

-- A removal failed: kept, counted, retried later.
create function public.fail_site_photo_purge(p_business_id uuid, p_asset_id uuid, p_scope text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.site_photo_purges p
  set attempts = p.attempts + 1, last_attempt_at = pg_catalog.now()
  where p.asset_id = p_asset_id and p.business_id = p_business_id and p.scope = p_scope;
$$;

-- The purges requested before `p_before` (left by a failed or interrupted
-- removal), the oldest first.
create function public.pending_site_photo_purges(p_before timestamptz, p_limit integer)
returns table (business_id uuid, asset_id uuid, scope text, attempts integer)
language sql
stable
security definer
set search_path = ''
as $$
  -- Due: never done yet (a failed or interrupted removal) and requested
  -- before `p_before`; or done early, now that the upload URL has expired.
  select p.business_id, p.asset_id, p.scope, p.attempts
  from public.site_photo_purges p
  where (p.last_done_at is null and p.requested_at < p_before)
     or p.not_before <= pg_catalog.now()
  order by p.requested_at, p.asset_id, p.scope
  limit greatest(least(p_limit, 500), 0);
$$;

-- Conversions in progress (Codex counter-audit). The service writes a
-- photo's derivatives with its own key, which no deadline limits: a
-- conversion slowed down (a paused or overloaded process) could write them
-- after the photo was deleted or revoked and its purge done and forgotten,
-- and nothing would ever delete them. So each conversion records here,
-- before reading the original, an obligation that outlives the photo: until
-- `deadline` the converter may write; it checks, before each file, that at
-- least the margin is left (site_photo_conversion_time_left). Once the
-- deadline has passed, the cleanup settles it (expire_site_photo_conversions)
-- in one transaction: the photo gone or revoked, a purge of all its files is
-- recorded again (and run as any other purge, retried until done); the
-- obligation is forgotten only then.
create table public.site_photo_conversions (
  -- No foreign key: it outlives its photo and its business.
  asset_id uuid primary key,
  business_id uuid not null,
  started_at timestamptz not null default pg_catalog.now(),
  deadline timestamptz not null
);

create index site_photo_conversions_deadline_idx
  on public.site_photo_conversions (deadline);

alter table public.site_photo_conversions enable row level security;
revoke all on table public.site_photo_conversions from public, anon, authenticated;

-- How long a conversion may write, and the least time it must have left to
-- write one more file (a file is a few hundred kB: seconds).
create function private.site_photo_conversion_lease()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '15 minutes' $$;

create function private.site_photo_conversion_margin()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '5 minutes' $$;

revoke all on function private.site_photo_conversion_lease() from public;
revoke all on function private.site_photo_conversion_margin() from public;

-- Before converting a pending photo of hers: the obligation is recorded (or
-- extended, a second attempt). Answers the deadline.
create function public.begin_site_photo_conversion(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_deadline timestamptz := pg_catalog.now() + private.site_photo_conversion_lease();
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  select a.status into v_status
  from public.site_assets a
  where a.id = p_asset_id and a.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'site_photo_not_found', hint = 'assetId';
  end if;
  if v_status = 'revoked' then
    raise exception using errcode = 'P0001', message = 'site_photo_revoked', hint = 'assetId';
  end if;
  insert into public.site_photo_conversions (asset_id, business_id, deadline)
  values (p_asset_id, p_business_id, v_deadline)
  on conflict (asset_id) do update
  set deadline = greatest(public.site_photo_conversions.deadline, excluded.deadline);
  return v_deadline;
end;
$$;

-- May the converter still write a file? true while at least the margin is
-- left before its deadline (the photo's state does not matter: a file
-- written for a photo gone is deleted when the obligation is settled).
create function public.site_photo_conversion_writable(p_business_id uuid, p_asset_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.site_photo_conversions c
    where c.asset_id = p_asset_id and c.business_id = p_business_id
      and c.deadline - private.site_photo_conversion_margin() > pg_catalog.now()
  );
$$;

-- The cleanup: settles the conversions past their deadline (no file can be
-- written for them any more), the oldest first. The photo gone or revoked:
-- all its files are to be deleted, recorded again even if a purge was done
-- (and forgotten) meanwhile. Ready or pending: nothing (a pending photo's
-- files go with it, when it is confirmed or forgotten). Answers how many.
create function public.expire_site_photo_conversions(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversion record;
  v_status text;
  v_count integer := 0;
begin
  for v_conversion in
    select c.asset_id, c.business_id from public.site_photo_conversions c
    where c.deadline <= pg_catalog.now()
    order by c.deadline
    limit greatest(least(p_limit, 500), 0)
    for update skip locked
  loop
    select a.status into v_status from public.site_assets a where a.id = v_conversion.asset_id;
    if not found or v_status = 'revoked' then
      perform private.queue_site_photo_purge(
        v_conversion.business_id, v_conversion.asset_id, 'all', '-infinity'::timestamptz
      );
    end if;
    delete from public.site_photo_conversions c where c.asset_id = v_conversion.asset_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation of the bucket with the database
-- ---------------------------------------------------------------------------
--
-- The purges and conversion obligations above are recorded by the code that
-- writes; a write can still land after its obligation was settled (a
-- conversion stalled more than its margin after its last check, a process
-- paused, a request delivered late): nothing recorded would find that file.
-- So the bucket itself is inventoried, from Storage's own index
-- (storage.objects, in this database), against the photos: every object of
-- the bucket `site-photos` with our layout `<business>/<photo>/<file>` that
-- no photo justifies is a suspect, recorded when first seen, and deleted
-- (by the service, through Storage) once it has been a suspect for the
-- safety period. Each pass sees every object present at that moment, so a
-- file written after a pass is found by the next one.
--
-- Justified, never a suspect: the photo exists under that very business
-- and is pending (its original; derivatives of a conversion in progress or
-- interrupted) or ready (its derivatives). Also left alone: any object of a
-- photo still being converted, and any name outside our layout (counted,
-- never deleted). Suspect: no such photo (deleted, discarded, never
-- existed), another business's photo, a revoked one, or a ready photo's
-- original. A photo never comes back once gone or revoked and a ready one
-- never needs its original again: a suspect cannot become justified, so a
-- decision made at any pass stays right.

-- The objects suspected, since when (their own record: Storage's dates are
-- rewritten on every update).
create table public.site_photo_orphans (
  name text primary key,
  business_id uuid not null,
  asset_id uuid not null,
  first_seen_at timestamptz not null default pg_catalog.now(),
  last_seen_at timestamptz not null default pg_catalog.now(),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz
);

alter table public.site_photo_orphans enable row level security;
revoke all on table public.site_photo_orphans from public, anon, authenticated;

-- One row: where the pass stands, who runs it, and what it found.
create table public.site_photo_reconciliation (
  id boolean primary key default true check (id),
  -- The last object name examined in the current pass ('' : from the start).
  cursor text not null default '',
  run_id uuid,
  lease_until timestamptz,
  pass_started_at timestamptz,
  pass_scanned integer not null default 0,
  pass_suspects integer not null default 0,
  pass_unknown integer not null default 0,
  pass_deleted integer not null default 0,
  pass_failed integer not null default 0,
  last_page_at timestamptz,
  -- The last complete pass: every object examined.
  last_pass_completed_at timestamptz,
  last_pass_scanned integer,
  last_pass_suspects integer,
  last_pass_unknown integer,
  last_pass_deleted integer,
  last_pass_failed integer
);

insert into public.site_photo_reconciliation default values;

alter table public.site_photo_reconciliation enable row level security;
revoke all on table public.site_photo_reconciliation from public, anon, authenticated;

-- How long an object stays a suspect before it is deleted: well beyond the
-- time any action in progress needs (a conversion's lease, a request).
create function private.site_photo_orphan_grace()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '1 hour' $$;

revoke all on function private.site_photo_orphan_grace() from public;

-- A run takes the pass for 5 minutes (renewed by each page): another run
-- meanwhile gets null and does nothing. Answers the run's cursor.
create function public.claim_site_photo_reconciliation(p_run uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor text;
begin
  update public.site_photo_reconciliation r
  set run_id = p_run,
      lease_until = pg_catalog.now() + interval '5 minutes',
      pass_started_at = case when r.cursor = '' then pg_catalog.now() else r.pass_started_at end,
      pass_scanned = case when r.cursor = '' then 0 else r.pass_scanned end,
      pass_suspects = case when r.cursor = '' then 0 else r.pass_suspects end,
      pass_unknown = case when r.cursor = '' then 0 else r.pass_unknown end,
      pass_deleted = case when r.cursor = '' then 0 else r.pass_deleted end,
      pass_failed = case when r.cursor = '' then 0 else r.pass_failed end
  where r.id
    and (r.lease_until is null or r.lease_until <= pg_catalog.now() or r.run_id = p_run)
  returning r.cursor into v_cursor;
  return v_cursor;
end;
$$;

create function public.release_site_photo_reconciliation(p_run uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.site_photo_reconciliation r
  set run_id = null, lease_until = null
  where r.id and r.run_id = p_run;
$$;

-- The next `p_limit` objects of the bucket after the cursor (Storage's
-- index, by name): each one judged against the photos now; suspects
-- recorded, records of objects gone or justified dropped. Answers the
-- suspects due for deletion (suspected for the safety period), how many
-- were examined, and whether the pass is complete. Raises
-- `reconciliation_lease_lost` if the run no longer holds the pass.
create function public.site_photo_reconciliation_page(p_run uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.site_photo_reconciliation%rowtype;
  v_limit integer := greatest(least(p_limit, 1000), 1);
  v_last text;
  v_scanned integer;
  v_suspects integer;
  v_unknown integer;
  v_complete boolean;
  v_due jsonb;
  -- The page, judged: [{name, business_id, asset_id, verdict}] (no
  -- temporary table: a security definer function must not use one that a
  -- caller of the same pooled session could have made first).
  v_page jsonb;
begin
  select * into v_state from public.site_photo_reconciliation r where r.id for update;
  if p_run is null
    or v_state.run_id is distinct from p_run
    or v_state.lease_until is null
    or v_state.lease_until <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'reconciliation_lease_lost';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', j.name, 'business_id', j.business_id, 'asset_id', j.asset_id, 'verdict', j.verdict
  ) order by j.name collate "C"), '[]'::jsonb)
  into v_page
  from (
  select o.name, m.business_id, m.asset_id,
    case
      when m.asset_id is null then 'unknown'
      when exists (
        select 1 from public.site_photo_conversions c
        where c.asset_id = m.asset_id and c.deadline > pg_catalog.now()
      ) then 'converting'
      when exists (
        select 1 from public.site_assets a
        where a.id = m.asset_id
          and a.business_id = m.business_id
          and (a.status = 'pending' or (a.status = 'ready' and m.file <> 'original'))
      ) then 'justified'
      else 'suspect'
    end as verdict
  from (
    select o.name
    from storage.objects o
    where o.bucket_id = 'site-photos'
      and o.archived_at is null
      and not o.is_delete_marker
      and o.name collate "C" > v_state.cursor collate "C"
    order by o.name collate "C"
    limit v_limit
  ) o
  left join lateral (
    select (p.parts)[1]::uuid as business_id, (p.parts)[2]::uuid as asset_id, (p.parts)[3] as file
    from (
      select pg_catalog.regexp_match(
        o.name,
        '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(original|w480\.webp|w828\.webp|w1200\.webp)$'
      ) as parts
    ) p
    where p.parts is not null
  ) m on true
  ) j;

  select count(*), max(p.name collate "C") into v_scanned, v_last
  from pg_catalog.jsonb_to_recordset(v_page) as p(name text);
  v_complete := v_scanned < v_limit;

  -- Records of names in the range just examined that are no longer
  -- suspects (deleted, or nothing to delete) are dropped.
  delete from public.site_photo_orphans x
  where x.name collate "C" > v_state.cursor collate "C"
    and (v_complete or x.name collate "C" <= v_last collate "C")
    and not exists (
      select 1 from pg_catalog.jsonb_to_recordset(v_page) as p(name text, verdict text)
      where p.name = x.name and p.verdict = 'suspect'
    );

  insert into public.site_photo_orphans (name, business_id, asset_id)
  select p.name, p.business_id, p.asset_id
  from pg_catalog.jsonb_to_recordset(v_page) as p(name text, business_id uuid, asset_id uuid, verdict text)
  where p.verdict = 'suspect'
  on conflict (name) do update set last_seen_at = pg_catalog.now();

  select count(*) filter (where p.verdict = 'suspect'), count(*) filter (where p.verdict = 'unknown')
  into v_suspects, v_unknown
  from pg_catalog.jsonb_to_recordset(v_page) as p(verdict text);

  select coalesce(pg_catalog.jsonb_agg(x.name order by x.name), '[]'::jsonb) into v_due
  from public.site_photo_orphans x
  join pg_catalog.jsonb_to_recordset(v_page) as p(name text, verdict text)
    on p.name = x.name and p.verdict = 'suspect'
  where x.first_seen_at <= pg_catalog.now() - private.site_photo_orphan_grace();

  update public.site_photo_reconciliation r
  set cursor = case when v_complete then '' else v_last end,
      lease_until = pg_catalog.now() + interval '5 minutes',
      last_page_at = pg_catalog.now(),
      pass_scanned = r.pass_scanned + v_scanned,
      pass_suspects = r.pass_suspects + v_suspects,
      pass_unknown = r.pass_unknown + v_unknown
  where r.id;

  if v_complete then
    update public.site_photo_reconciliation r
    set last_pass_completed_at = pg_catalog.now(),
        last_pass_scanned = r.pass_scanned,
        last_pass_suspects = r.pass_suspects,
        last_pass_unknown = r.pass_unknown,
        last_pass_deleted = r.pass_deleted,
        last_pass_failed = r.pass_failed,
        pass_started_at = null
    where r.id;
  end if;

  return pg_catalog.jsonb_build_object(
    'scanned', v_scanned,
    'suspects', v_suspects,
    'unknown', v_unknown,
    'due', v_due,
    'complete', v_complete
  );
end;
$$;

-- What became of the suspects the run tried to delete: `p_deleted` are gone
-- (records dropped), `p_failed` stay recorded, counted, for the next pass.
-- Only from the run that holds the pass, with its lease still valid,
-- checked under the pass's row lock before anything changes (the same
-- transaction): the late answer of a run whose lease expired would
-- otherwise erase the record and counts of the run that took over
-- (`reconciliation_lease_lost`; what it deleted is seen gone by the next
-- pass anyway).
create function public.record_site_photo_orphan_deletions(
  p_run uuid,
  p_deleted text[],
  p_failed text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.site_photo_reconciliation%rowtype;
begin
  select * into v_state from public.site_photo_reconciliation r where r.id for update;
  if p_run is null
    or v_state.run_id is distinct from p_run
    or v_state.lease_until is null
    or v_state.lease_until <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'reconciliation_lease_lost';
  end if;

  delete from public.site_photo_orphans x where x.name = any (p_deleted);
  update public.site_photo_orphans x
  set attempts = x.attempts + 1, last_attempt_at = pg_catalog.now()
  where x.name = any (p_failed);
  update public.site_photo_reconciliation r
  set pass_deleted = r.pass_deleted + coalesce(pg_catalog.cardinality(p_deleted), 0),
      pass_failed = r.pass_failed + coalesce(pg_catalog.cardinality(p_failed), 0),
      -- A pass completed in this run counts its last deletions too.
      last_pass_deleted = case when r.cursor = '' and r.run_id = p_run
        then coalesce(r.last_pass_deleted, 0) + coalesce(pg_catalog.cardinality(p_deleted), 0)
        else r.last_pass_deleted end,
      last_pass_failed = case when r.cursor = '' and r.run_id = p_run
        then coalesce(r.last_pass_failed, 0) + coalesce(pg_catalog.cardinality(p_failed), 0)
        else r.last_pass_failed end,
      lease_until = pg_catalog.now() + interval '5 minutes'
  where r.id;
end;
$$;

-- For monitoring: where the reconciliation stands.
create function public.site_photo_reconciliation_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'lastPassCompletedAt', r.last_pass_completed_at,
    'lastPageAt', r.last_page_at,
    'passInProgress', r.cursor <> '',
    'lastPass', pg_catalog.jsonb_build_object(
      'scanned', r.last_pass_scanned,
      'suspects', r.last_pass_suspects,
      'unknown', r.last_pass_unknown,
      'deleted', r.last_pass_deleted,
      'failed', r.last_pass_failed
    ),
    -- Photos with files (pending or ready): a pass that scanned none of
    -- them while these exist means Storage's index was not readable.
    'photos', (select count(*) from public.site_assets a where a.status in ('pending', 'ready')),
    'suspects', (select count(*) from public.site_photo_orphans),
    'oldestSuspectSince', (select min(x.first_seen_at) from public.site_photo_orphans x),
    'failingSuspects', (select count(*) from public.site_photo_orphans x where x.attempts > 0)
  )
  from public.site_photo_reconciliation r where r.id;
$$;

-- Uploads abandoned: photos still pending after their upload URL expired
-- (never sent, never confirmed, or a conversion interrupted after writing
-- derivatives). Forgotten, the oldest first; their files are recorded for
-- deletion by the row's trigger. Answers how many.
create function public.discard_abandoned_site_assets(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with abandoned as (
    select a.id from public.site_assets a
    where a.status = 'pending'
      and a.created_at < pg_catalog.now() - private.site_photo_upload_window()
      -- Not while it is being converted: her confirmation may still finish.
      and not exists (
        select 1 from public.site_photo_conversions c
        where c.asset_id = a.id and c.deadline > pg_catalog.now()
      )
    order by a.created_at
    limit greatest(least(p_limit, 500), 0)
    for update skip locked
  )
  delete from public.site_assets a using abandoned
  where a.id = abandoned.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Writes (the service, for a member)
-- ---------------------------------------------------------------------------

-- A new photo, pending until its file is verified. At most 20 pending
-- uploads per business over the last 24 hours (abuse).
create function public.create_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_content_type text,
  p_byte_size integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  if p_content_type is null
    -- HEIC (HEVC) cannot be decoded by the server: refused here, the
    -- studio lets iOS convert to JPEG (contract § 8).
    or p_content_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/avif') then
    raise exception using errcode = '22023', message = 'site_photo_unsupported', hint = 'contentType';
  end if;
  if p_byte_size is null or p_byte_size not between 1 and 10485760 then
    raise exception using errcode = '22023', message = 'site_photo_too_large', hint = 'byteSize';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('site_assets:' || p_business_id::text, 0)
  );
  if (
    select count(*) from public.site_assets a
    where a.business_id = p_business_id
      and a.status = 'pending'
      and a.created_at > pg_catalog.now() - interval '24 hours'
  ) >= 20 then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  insert into public.site_assets (business_id, status, byte_size, created_by)
  values (p_business_id, 'pending', p_byte_size, p_actor)
  returning id into v_id;
  return v_id;
end;
$$;

-- The file was verified by the server (real type, size, dimensions) and its
-- derivatives were made: the photo is ready, and its original is to be
-- deleted (purge recorded). Only a pending photo.
create function public.confirm_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid,
  p_content_type text,
  p_byte_size integer,
  p_width integer,
  p_height integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  select a.status into v_status
  from public.site_assets a
  where a.id = p_asset_id and a.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'site_photo_not_found', hint = 'assetId';
  end if;
  if v_status = 'ready' then
    return;
  end if;
  if v_status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'site_photo_revoked', hint = 'assetId';
  end if;
  update public.site_assets a
  set status = 'ready',
      content_type = p_content_type,
      byte_size = p_byte_size,
      width = p_width,
      height = p_height
  where a.id = p_asset_id;
  perform private.queue_site_photo_purge(
    p_business_id, p_asset_id, 'original',
    (select a.created_at from public.site_assets a where a.id = p_asset_id)
  );
end;
$$;

-- A pending photo whose file was refused: forgotten.
create function public.discard_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  delete from public.site_assets a
  where a.id = p_asset_id and a.business_id = p_business_id and a.status = 'pending';
end;
$$;

-- Deletes a photo nothing refers to: not the draft, not any published
-- version (site_asset_in_use: revoke it instead); its files are to be
-- deleted (the row's trigger records the purge). Called again once deleted
-- while its purge is left: 'deleted' again, so the caller retries the files.
-- A revoked photo stays as a record, so it can never come back.
create function public.delete_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('site_assets:' || p_business_id::text, 0)
  );
  select a.status into v_status
  from public.site_assets a
  where a.id = p_asset_id and a.business_id = p_business_id
  for update;
  if not found then
    if exists (
      select 1 from public.site_photo_purges p
      where p.asset_id = p_asset_id and p.business_id = p_business_id and p.scope = 'all'
        and p.last_done_at is null
    ) then
      return 'deleted';
    end if;
    raise exception using errcode = 'P0002', message = 'site_photo_not_found', hint = 'assetId';
  end if;
  if v_status = 'revoked' then
    return 'revoked';
  end if;
  -- The draft and the history are read under the site's row lock: a save
  -- or a publication cannot add a reference meanwhile.
  perform 1 from public.sites s where s.business_id = p_business_id for update;
  if exists (
    select 1 from public.sites s
    where s.business_id = p_business_id
      and s.draft_config is not null
      and private.site_config_refers_to(s.draft_config, p_asset_id)
  ) or exists (
    select 1 from public.site_versions v
    where v.business_id = p_business_id
      and private.site_config_refers_to(v.config, p_asset_id)
  ) then
    raise exception using errcode = 'P0001', message = 'site_asset_in_use', hint = 'assetId';
  end if;
  delete from public.site_assets a where a.id = p_asset_id;
  return 'deleted';
end;
$$;

-- Revokes a photo, whatever refers to it. Final and idempotent; the first
-- reason stays. Nothing published is rewritten: every render shows its
-- places without a photo. Its files are to be deleted (purge recorded).
create function private.revoke_site_asset(p_business_id uuid, p_asset_id uuid, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.site_assets a
  set status = 'revoked',
      revoked_at = coalesce(a.revoked_at, pg_catalog.now()),
      revoked_reason = coalesce(a.revoked_reason, p_reason)
  where a.id = p_asset_id and a.business_id = p_business_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'site_photo_not_found', hint = 'assetId';
  end if;
  perform private.queue_site_photo_purge(
    p_business_id, p_asset_id, 'all',
    (select a.created_at from public.site_assets a where a.id = p_asset_id)
  );
end;
$$;

revoke all on function private.revoke_site_asset(uuid, uuid, text) from public;

-- Her request, from the studio.
create function public.revoke_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  perform private.revoke_site_asset(p_business_id, p_asset_id, 'owner');
end;
$$;

-- A privacy request (the person in the photo, or a deletion request)
-- handled by the service: no acting member.
create function public.revoke_site_asset_for_privacy(
  p_business_id uuid,
  p_asset_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.revoke_site_asset(p_business_id, p_asset_id, 'privacy');
end;
$$;

-- ---------------------------------------------------------------------------
-- Serving (the service, for the proxies)
-- ---------------------------------------------------------------------------

-- The public proxy: the business of `p_slug` if this photo is ready and
-- referred to by its PUBLISHED version; null otherwise (a draft's photo, a
-- revoked one, another business's: never served).
create function public.public_site_photo(p_slug text, p_asset_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.business_id
  from public.site_assets a
  join public.sites s on s.business_id = a.business_id
  join public.site_versions v on v.id = s.published_version_id
  where a.id = p_asset_id
    and a.status = 'ready'
    and a.business_id = private.business_id_by_slug(p_slug)
    and private.site_config_refers_to(v.config, p_asset_id);
$$;

-- The studio's preview: a ready photo of HER business, published or not.
create function public.member_site_photo(p_business_id uuid, p_actor uuid, p_asset_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  return exists (
    select 1 from public.site_assets a
    where a.id = p_asset_id and a.business_id = p_business_id and a.status = 'ready'
  );
end;
$$;

-- The public read now says which of the published version's photos cannot
-- be shown (revoked since): drawn without a photo.
drop function public.get_public_site(text);

create function public.get_public_site(p_slug text)
returns table (
  version_id uuid,
  number integer,
  published_at timestamptz,
  plan text,
  schema_version integer,
  config jsonb,
  unavailable_assets uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
begin
  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  return query
  select v.id, v.number, v.published_at, s.plan, v.schema_version, v.config,
         private.site_unavailable_assets(v_business_id, v.config)
  from public.sites s
  join public.site_versions v on v.id = s.published_version_id
  where s.business_id = v_business_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'site_not_published';
  end if;
end;
$$;

revoke all on function public.get_public_site(text) from public;
grant execute on function public.get_public_site(text) to anon, authenticated, service_role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.create_site_asset(uuid, uuid, text, integer)',
    'public.confirm_site_asset(uuid, uuid, uuid, text, integer, integer, integer)',
    'public.discard_site_asset(uuid, uuid, uuid)',
    'public.delete_site_asset(uuid, uuid, uuid)',
    'public.revoke_site_asset(uuid, uuid, uuid)',
    'public.revoke_site_asset_for_privacy(uuid, uuid)',
    'public.public_site_photo(text, uuid)',
    'public.member_site_photo(uuid, uuid, uuid)',
    'public.discard_abandoned_site_assets(integer)',
    'public.complete_site_photo_purge(uuid, uuid, text)',
    'public.fail_site_photo_purge(uuid, uuid, text)',
    'public.pending_site_photo_purges(timestamptz, integer)',
    'public.begin_site_photo_conversion(uuid, uuid, uuid)',
    'public.site_photo_conversion_writable(uuid, uuid)',
    'public.expire_site_photo_conversions(integer)',
    'public.claim_site_photo_reconciliation(uuid)',
    'public.release_site_photo_reconciliation(uuid)',
    'public.site_photo_reconciliation_page(uuid, integer)',
    'public.record_site_photo_orphan_deletions(uuid, text[], text[])',
    'public.site_photo_reconciliation_status()'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
