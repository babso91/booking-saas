-- The Atelier, the professional's side (docs/ATELIER_CONTRACT.md, R5-03).
--
-- An order (made by the platform: its quote is a product hypothesis,
-- nothing is ever charged here) brings proposals for her site, made by an
-- operator whose access to the order expires. A proposal is a snapshot of
-- a whole site configuration made on a given draft revision. She reads it,
-- asks for a correction (one of the included ones, counted once per
-- request, within the order's agreed scopes), asks for it to be remade on
-- her current draft (no correction used), or applies it: her draft is
-- saved through the Studio's own path (save_site_draft: revision, schema
-- and photo checks), never published.

create table private.atelier_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  title text not null check (pg_catalog.char_length(title) between 1 and 120),
  status text not null default 'quoted' check (status in (
    'quoted', 'accepted', 'awaiting_assets', 'in_production', 'in_review',
    'revision_requested', 'delivered', 'cancelled'
  )),
  quote_version integer not null default 1,
  -- A product hypothesis set by the platform; never charged from here.
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'EUR',
  included_corrections integer not null check (included_corrections between 0 and 20),
  corrections_used integer not null default 0 check (corrections_used >= 0),
  -- What the quote covers: a correction outside is out of scope.
  scopes text[] not null default '{}',
  created_at timestamptz not null default pg_catalog.now(),
  check (corrections_used <= included_corrections)
);

create index atelier_orders_business_idx on private.atelier_orders (business_id);

-- The operator's access to one order, until it expires.
create table private.atelier_operator_grants (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references private.atelier_orders (id) on delete cascade,
  operator_label text not null check (pg_catalog.char_length(operator_label) between 1 and 80),
  expires_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now()
);

create table private.atelier_proposals (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references private.atelier_orders (id) on delete cascade,
  business_id uuid not null,
  quote_version integer not null,
  base_draft_revision integer not null check (base_draft_revision >= 0),
  schema_version integer not null,
  config jsonb not null,
  changes text[] not null check (pg_catalog.cardinality(changes) between 1 and 30),
  state text not null default 'submitted'
    check (state in ('submitted', 'changes_requested', 'accepted', 'applied')),
  author_label text not null,
  rebase_requested boolean not null default false,
  applied_revision integer,
  submitted_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index atelier_proposals_order_idx on private.atelier_proposals (order_id, submitted_at desc);

create table private.atelier_requests (
  order_id uuid not null references private.atelier_orders (id) on delete cascade,
  request_id uuid not null,
  kind text not null,
  fingerprint text not null,
  response jsonb not null,
  primary key (order_id, request_id)
);

revoke all on table private.atelier_orders from public, anon, authenticated;
revoke all on table private.atelier_operator_grants from public, anon, authenticated;
revoke all on table private.atelier_proposals from public, anon, authenticated;
revoke all on table private.atelier_requests from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function private.atelier_view(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'order', pg_catalog.jsonb_build_object(
      'orderId', o.id, 'title', o.title, 'status', o.status,
      'quote', pg_catalog.jsonb_build_object(
        'version', o.quote_version, 'amountCents', o.amount_cents, 'currency', o.currency,
        'includedCorrections', o.included_corrections
      ),
      'correctionsUsed', o.corrections_used
    ),
    'proposals', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'proposalId', p.id, 'baseDraftRevision', p.base_draft_revision, 'state', p.state,
        'submittedAt', p.submitted_at, 'authorLabel', p.author_label, 'changes', p.changes,
        'rebaseRequested', p.rebase_requested
      ) order by p.submitted_at desc, p.id)
      from private.atelier_proposals p where p.order_id = o.id
    ), '[]'::jsonb),
    'currentDraftRevision', coalesce((
      select s.draft_revision from public.sites s where s.business_id = o.business_id
    ), 0)
  )
  from private.atelier_orders o
  where o.id = p_order_id;
$$;

-- Her order (owner only); atelier_access_expired for anything else, the
-- same answer whether it exists or not.
create function private.atelier_owner_order(p_order_id uuid)
returns private.atelier_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order private.atelier_orders;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  select * into v_order from private.atelier_orders o where o.id = p_order_id;
  if v_order.id is null
     or not public.has_business_role(v_order.business_id, array['owner']::public.business_member_role[]) then
    raise exception using errcode = 'P0001', message = 'atelier_access_expired';
  end if;
  return v_order;
end;
$$;

create function private.atelier_replay(p_order_id uuid, p_request_id uuid, p_kind text, p_payload jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_request private.atelier_requests;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  select * into v_request from private.atelier_requests r
  where r.order_id = p_order_id and r.request_id = p_request_id;
  if found then
    if v_request.kind <> p_kind or v_request.fingerprint <> pg_catalog.md5(p_payload::text) then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return v_request.response;
  end if;
  return null;
end;
$$;

create function private.atelier_record(
  p_order_id uuid, p_request_id uuid, p_kind text, p_payload jsonb, p_response jsonb
)
returns jsonb
language sql
set search_path = ''
as $$
  insert into private.atelier_requests (order_id, request_id, kind, fingerprint, response)
  values (p_order_id, p_request_id, p_kind, pg_catalog.md5(p_payload::text), p_response)
  returning response;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.atelier_view(uuid)',
    'private.atelier_owner_order(uuid)',
    'private.atelier_replay(uuid, uuid, text, jsonb)',
    'private.atelier_record(uuid, uuid, text, jsonb, jsonb)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Her side (owner)
-- ---------------------------------------------------------------------------

create function public.atelier_read(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.atelier_owner_order(p_order_id);
  return private.atelier_view(p_order_id);
end;
$$;

-- One included correction, consumed once per request, within the order's
-- scopes (atelier_out_of_scope: a separate quote, nothing charged without
-- her agreement), while some remain (atelier_revision_limit_reached).
create function public.atelier_request_correction(
  p_proposal_id uuid,
  p_scope text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal private.atelier_proposals;
  v_order private.atelier_orders;
  v_payload jsonb := pg_catalog.jsonb_build_object('proposalId', p_proposal_id, 'scope', p_scope);
  v_replay jsonb;
begin
  select * into v_proposal from private.atelier_proposals p where p.id = p_proposal_id;
  v_order := private.atelier_owner_order(v_proposal.order_id);
  select * into v_order from private.atelier_orders o where o.id = v_order.id for update;
  v_replay := private.atelier_replay(v_order.id, p_request_id, 'correction', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  -- Read again under the order's lock: an apply may have just landed.
  select * into v_proposal from private.atelier_proposals p where p.id = p_proposal_id for update;
  if v_order.status in ('delivered', 'cancelled') or v_proposal.state = 'applied' then
    raise exception using errcode = 'P0001', message = 'atelier_access_expired';
  end if;
  if v_proposal.quote_version <> v_order.quote_version then
    raise exception using errcode = 'P0001', message = 'atelier_quote_changed';
  end if;
  if p_scope is null or not (p_scope = any (v_order.scopes)) then
    raise exception using errcode = 'P0001', message = 'atelier_out_of_scope';
  end if;
  if v_order.corrections_used >= v_order.included_corrections then
    raise exception using errcode = 'P0001', message = 'atelier_revision_limit_reached';
  end if;
  update private.atelier_orders o
  set corrections_used = o.corrections_used + 1, status = 'revision_requested'
  where o.id = v_order.id;
  update private.atelier_proposals p
  set state = 'changes_requested', updated_at = pg_catalog.now()
  where p.id = v_proposal.id;
  return private.atelier_record(v_order.id, p_request_id, 'correction', v_payload, private.atelier_view(v_order.id));
end;
$$;

-- The same proposal remade on her current draft: never a correction.
create function public.atelier_request_rebase(p_proposal_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal private.atelier_proposals;
  v_order private.atelier_orders;
  v_payload jsonb := pg_catalog.jsonb_build_object('proposalId', p_proposal_id);
  v_replay jsonb;
begin
  select * into v_proposal from private.atelier_proposals p where p.id = p_proposal_id;
  v_order := private.atelier_owner_order(v_proposal.order_id);
  select * into v_order from private.atelier_orders o where o.id = v_order.id for update;
  v_replay := private.atelier_replay(v_order.id, p_request_id, 'rebase', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  -- Read again under the order's lock: an apply may have just landed.
  select * into v_proposal from private.atelier_proposals p where p.id = p_proposal_id for update;
  if v_proposal.state = 'applied' or v_order.status in ('delivered', 'cancelled') then
    raise exception using errcode = 'P0001', message = 'atelier_access_expired';
  end if;
  if v_proposal.quote_version <> v_order.quote_version then
    raise exception using errcode = 'P0001', message = 'atelier_quote_changed';
  end if;
  update private.atelier_proposals p
  set rebase_requested = true, state = 'changes_requested', updated_at = pg_catalog.now()
  where p.id = v_proposal.id;
  return private.atelier_record(v_order.id, p_request_id, 'rebase', v_payload, private.atelier_view(v_order.id));
end;
$$;

-- Applies the proposal to her draft through the Studio's own save
-- (save_site_draft: revision, schema and photo checks). Her draft must be
-- the one the proposal was made on and the one she saw:
-- stale_site_draft (hint: her current revision) otherwise, nothing
-- overwritten. Never publishes.
create function public.atelier_apply(
  p_proposal_id uuid,
  p_expected_draft_revision integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal private.atelier_proposals;
  v_order private.atelier_orders;
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'proposalId', p_proposal_id, 'expectedDraftRevision', p_expected_draft_revision);
  v_replay jsonb;
  v_current integer;
  v_revision integer;
begin
  select * into v_proposal from private.atelier_proposals p where p.id = p_proposal_id;
  v_order := private.atelier_owner_order(v_proposal.order_id);
  select * into v_order from private.atelier_orders o where o.id = v_order.id for update;
  v_replay := private.atelier_replay(v_order.id, p_request_id, 'apply', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_proposal from private.atelier_proposals p where p.id = p_proposal_id for update;
  if v_proposal.state not in ('submitted', 'accepted') or v_order.status in ('delivered', 'cancelled') then
    raise exception using errcode = 'P0001', message = 'atelier_access_expired';
  end if;
  if v_proposal.quote_version <> v_order.quote_version then
    raise exception using errcode = 'P0001', message = 'atelier_quote_changed';
  end if;
  -- Locked: the Studio cannot save between this check and the save below.
  select coalesce((select s.draft_revision from public.sites s
                   where s.business_id = v_order.business_id for update), 0)
  into v_current;
  if v_current <> v_proposal.base_draft_revision or v_current is distinct from p_expected_draft_revision then
    raise exception using errcode = 'P0001', message = 'stale_site_draft', hint = v_current::text;
  end if;

  v_revision := public.save_site_draft(
    v_order.business_id, (select auth.uid()), p_expected_draft_revision,
    v_proposal.schema_version, v_proposal.config
  );
  update private.atelier_proposals p
  set state = 'applied', applied_revision = v_revision, updated_at = pg_catalog.now()
  where p.id = v_proposal.id;
  return private.atelier_record(
    v_order.id, p_request_id, 'apply', v_payload,
    pg_catalog.jsonb_build_object('draftRevision', v_revision)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The platform and its operator (the service only)
-- ---------------------------------------------------------------------------

create function public.atelier_create_order(
  p_business_id uuid,
  p_title text,
  p_amount_cents integer,
  p_included_corrections integer,
  p_scopes text[]
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into private.atelier_orders (business_id, title, amount_cents, included_corrections, scopes)
  values (p_business_id, p_title, p_amount_cents, p_included_corrections, coalesce(p_scopes, '{}'))
  returning id;
$$;

create function public.atelier_grant_operator(p_order_id uuid, p_operator_label text, p_days integer)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into private.atelier_operator_grants (order_id, operator_label, expires_at)
  values (p_order_id, p_operator_label,
          pg_catalog.now() + pg_catalog.make_interval(days => least(greatest(p_days, 1), 90)))
  returning id;
$$;

-- The operator's proposal: her grant must be live (atelier_access_expired
-- otherwise); the configuration is checked as the Studio checks a draft.
create function public.atelier_submit_proposal(
  p_grant_id uuid,
  p_base_draft_revision integer,
  p_schema_version integer,
  p_config jsonb,
  p_changes text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant private.atelier_operator_grants;
  v_order private.atelier_orders;
  v_id uuid;
begin
  select * into v_grant from private.atelier_operator_grants g where g.id = p_grant_id;
  if v_grant.id is null or v_grant.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'atelier_access_expired';
  end if;
  select * into v_order from private.atelier_orders o where o.id = v_grant.order_id for update;
  if v_order.status in ('delivered', 'cancelled') then
    raise exception using errcode = 'P0001', message = 'atelier_access_expired';
  end if;
  perform private.assert_site_document(p_schema_version, p_config);
  insert into private.atelier_proposals (
    order_id, business_id, quote_version, base_draft_revision, schema_version, config,
    changes, author_label
  ) values (
    v_order.id, v_order.business_id, v_order.quote_version, p_base_draft_revision,
    p_schema_version, p_config, p_changes, v_grant.operator_label
  )
  returning id into v_id;
  update private.atelier_orders o set status = 'in_review' where o.id = v_order.id;
  return v_id;
end;
$$;

revoke all on function public.atelier_read(uuid) from public, anon;
revoke all on function public.atelier_request_correction(uuid, text, uuid) from public, anon;
revoke all on function public.atelier_request_rebase(uuid, uuid) from public, anon;
revoke all on function public.atelier_apply(uuid, integer, uuid) from public, anon;
grant execute on function public.atelier_read(uuid) to authenticated;
grant execute on function public.atelier_request_correction(uuid, text, uuid) to authenticated;
grant execute on function public.atelier_request_rebase(uuid, uuid) to authenticated;
grant execute on function public.atelier_apply(uuid, integer, uuid) to authenticated;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.atelier_create_order(uuid, text, integer, integer, text[])',
    'public.atelier_grant_operator(uuid, text, integer)',
    'public.atelier_submit_proposal(uuid, integer, integer, jsonb, text[])'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
