-- R3-02, client forms (docs/CLIENT_FORMS_CONTRACT.md): templates with one
-- editable draft and immutable published versions; a form sent for one visit
-- (assignment); the client's answers, frozen once sent (submission).
--
--   private.form_templates    one draft per template (optimistic draft_version)
--   private.form_versions     published versions, never modified
--   private.form_assignments  one form asked for one appointment
--   private.form_submissions  the answers as sent, one per assignment, immutable
--   private.form_requests     replay of every write (requestId), per author
--
-- Every table is private: professionals reach them through the functions
-- below (security definer, owner/admin of the business, trusted session), the
-- client through the Client Hub functions (her Hub session + an active access
-- to the CRM record of the appointment). A booking's contact details never
-- open a form.
--
-- Out of this lot (contract, « Écarts »): automatic assignment and the
-- frequency rule, the email that tells her a form waits, the marketing
-- consent register. No health or special-category field in V1.

create table private.form_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  draft jsonb not null,
  draft_version integer not null default 1,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id)
);

create index form_templates_business_idx on private.form_templates (business_id, created_at);

create table private.form_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null,
  business_id uuid not null,
  number integer not null check (number > 0),
  content jsonb not null,
  content_hash text not null,
  published_at timestamptz not null default now(),
  published_by uuid,
  unique (template_id, number),
  unique (id, business_id),
  foreign key (template_id, business_id)
    references private.form_templates (id, business_id) on delete cascade
);

create table private.form_assignments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  appointment_id uuid not null,
  client_id uuid not null,
  template_id uuid not null,
  version_id uuid not null,
  status text not null default 'assigned'
    check (status in ('assigned', 'submitted', 'completed', 'revoked')),
  revision integer not null default 1,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  revoked_at timestamptz,
  foreign key (appointment_id, business_id)
    references public.appointments (id, business_id) on delete cascade,
  foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade,
  foreign key (version_id, business_id)
    references private.form_versions (id, business_id) on delete cascade,
  foreign key (template_id, business_id)
    references private.form_templates (id, business_id) on delete cascade
);

-- The same form (any version) is open at most once per visit.
create unique index form_assignments_one_open
  on private.form_assignments (appointment_id, template_id)
  where status in ('assigned', 'submitted');
create index form_assignments_client_idx
  on private.form_assignments (business_id, client_id, created_at desc);

create table private.form_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null unique references private.form_assignments (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  answers jsonb not null,
  submitted_at timestamptz not null default now()
);

create table private.form_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  request_id uuid not null,
  actor text not null,
  kind text not null,
  fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (business_id, request_id)
);

revoke all on private.form_templates, private.form_versions, private.form_assignments,
  private.form_submissions, private.form_requests from public, anon, authenticated;

-- A submission is a record of what she sent: never rewritten.
create function private.form_submissions_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'form_submission_immutable';
end;
$$;

create trigger form_submissions_no_update
  before update on private.form_submissions
  for each row execute function private.form_submissions_immutable();

create trigger form_versions_no_update
  before update on private.form_versions
  for each row execute function private.form_submissions_immutable();

-- ---------------------------------------------------------------------------
-- Template rules (the same as the screen's draftProblems + checkTemplate)

create function private.form_check_draft(p_draft jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_title text := pg_catalog.btrim(coalesce(p_draft ->> 'title', ''));
  v_intro text := coalesce(p_draft ->> 'intro', '');
  v_review text := p_draft ->> 'review';
  v_frequency jsonb := p_draft -> 'frequency';
  v_fields jsonb := p_draft -> 'fields';
  v_field jsonb;
  v_option jsonb;
  v_seen text[] := '{}';
  v_types jsonb := '{}';
  v_options jsonb := '{}';
  v_labels text[];
  v_option_ids text[];
  v_id text;
  v_type text;
  v_label text;
  v_source text;
  v_equals jsonb;
  v_out jsonb := '[]';
  v_clean jsonb;
  v_days integer;
begin
  if pg_catalog.jsonb_typeof(p_draft) is distinct from 'object'
     or pg_catalog.char_length(v_title) not between 1 and 120
     or pg_catalog.char_length(v_intro) > 2000
     or v_review is null or v_review not in ('none', 'professional')
     or pg_catalog.jsonb_typeof(v_frequency) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_fields) is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_fields) not between 1 and 50 then
    raise exception using errcode = 'P0001', message = 'invalid_template';
  end if;

  if v_frequency ->> 'kind' = 'every_appointment' then
    v_frequency := '{"kind": "every_appointment"}';
  elsif v_frequency ->> 'kind' = 'reuse_completed_for_days'
        and pg_catalog.jsonb_typeof(v_frequency -> 'days') = 'number' then
    v_days := (v_frequency ->> 'days')::numeric;
    if v_days::numeric <> (v_frequency ->> 'days')::numeric or v_days not between 1 and 365 then
      raise exception using errcode = 'P0001', message = 'invalid_template';
    end if;
    v_frequency := pg_catalog.jsonb_build_object('kind', 'reuse_completed_for_days', 'days', v_days);
  else
    raise exception using errcode = 'P0001', message = 'invalid_template';
  end if;

  for v_field in select f from pg_catalog.jsonb_array_elements(v_fields) f loop
    v_id := v_field ->> 'id';
    v_type := v_field ->> 'type';
    v_label := pg_catalog.btrim(coalesce(v_field ->> 'label', ''));
    if pg_catalog.jsonb_typeof(v_field) is distinct from 'object'
       or v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,64}$' or v_id = any (v_seen)
       or v_type is null or v_type not in ('short_text', 'single_choice', 'boolean', 'attestation')
       or pg_catalog.char_length(v_label) not between 1 and 200
       or pg_catalog.jsonb_typeof(v_field -> 'required') is distinct from 'boolean'
       or (v_field ? 'help' and pg_catalog.jsonb_typeof(v_field -> 'help') not in ('string', 'null'))
       or pg_catalog.char_length(coalesce(v_field ->> 'help', '')) > 500 then
      raise exception using errcode = 'P0001', message = 'invalid_template';
    end if;

    v_clean := pg_catalog.jsonb_build_object(
      'id', v_id, 'type', v_type, 'label', v_label,
      'required', (v_field -> 'required')::boolean,
      'help', nullif(pg_catalog.btrim(coalesce(v_field ->> 'help', '')), '')
    );

    if v_type = 'single_choice' then
      if pg_catalog.jsonb_typeof(v_field -> 'options') is distinct from 'array'
         or pg_catalog.jsonb_array_length(v_field -> 'options') not between 2 and 20 then
        raise exception using errcode = 'P0001', message = 'invalid_template';
      end if;
      v_labels := '{}';
      v_option_ids := '{}';
      for v_option in select o from pg_catalog.jsonb_array_elements(v_field -> 'options') o loop
        if pg_catalog.jsonb_typeof(v_option) is distinct from 'object'
           or coalesce(v_option ->> 'id', '') !~ '^[A-Za-z0-9_-]{1,64}$'
           or (v_option ->> 'id') = any (v_option_ids)
           or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_option ->> 'label', ''))) not between 1 and 200
           or pg_catalog.lower(pg_catalog.btrim(v_option ->> 'label')) = any (v_labels) then
          raise exception using errcode = 'P0001', message = 'invalid_template';
        end if;
        v_option_ids := v_option_ids || (v_option ->> 'id');
        v_labels := v_labels || pg_catalog.lower(pg_catalog.btrim(v_option ->> 'label'));
      end loop;
      v_clean := v_clean || pg_catalog.jsonb_build_object('options', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', o ->> 'id', 'label', pg_catalog.btrim(o ->> 'label')) order by n)
        from pg_catalog.jsonb_array_elements(v_field -> 'options') with ordinality as x(o, n)
      ));
      v_options := v_options || pg_catalog.jsonb_build_object(v_id, pg_catalog.to_jsonb(v_option_ids));
    elsif v_field ? 'options' and pg_catalog.jsonb_typeof(v_field -> 'options') <> 'null' then
      raise exception using errcode = 'P0001', message = 'invalid_template';
    end if;

    if v_type = 'attestation' then
      if pg_catalog.char_length(pg_catalog.btrim(coalesce(v_field ->> 'attestationText', ''))) not between 1 and 2000 then
        raise exception using errcode = 'P0001', message = 'invalid_template';
      end if;
      v_clean := v_clean || pg_catalog.jsonb_build_object('attestationText', v_field ->> 'attestationText');
    end if;

    -- A condition is on an EARLIER question, by id, with a value it can take.
    if v_field ? 'showIf' and pg_catalog.jsonb_typeof(v_field -> 'showIf') = 'object' then
      v_source := v_field -> 'showIf' ->> 'field';
      v_equals := v_field -> 'showIf' -> 'equals';
      if v_source is null or not (v_source = any (v_seen)) then
        raise exception using errcode = 'P0001', message = 'invalid_template';
      end if;
      if v_types ->> v_source in ('boolean', 'attestation') then
        if pg_catalog.jsonb_typeof(v_equals) is distinct from 'boolean' then
          raise exception using errcode = 'P0001', message = 'invalid_template';
        end if;
      elsif v_types ->> v_source = 'single_choice' then
        if pg_catalog.jsonb_typeof(v_equals) is distinct from 'string'
           or not (v_options -> v_source) ? (v_equals #>> '{}') then
          raise exception using errcode = 'P0001', message = 'invalid_template';
        end if;
      else
        raise exception using errcode = 'P0001', message = 'invalid_template';
      end if;
      v_clean := v_clean || pg_catalog.jsonb_build_object(
        'showIf', pg_catalog.jsonb_build_object('field', v_source, 'equals', v_equals));
    elsif v_field ? 'showIf' and pg_catalog.jsonb_typeof(v_field -> 'showIf') <> 'null' then
      raise exception using errcode = 'P0001', message = 'invalid_template';
    else
      v_clean := v_clean || '{"showIf": null}';
    end if;

    v_seen := v_seen || v_id;
    v_types := v_types || pg_catalog.jsonb_build_object(v_id, v_type);
    v_out := v_out || pg_catalog.jsonb_build_array(v_clean);
  end loop;

  return pg_catalog.jsonb_build_object(
    'title', v_title, 'intro', v_intro, 'review', v_review,
    'frequency', v_frequency, 'fields', v_out
  );
end;
$$;

revoke all on function private.form_check_draft(jsonb) from public;

-- ---------------------------------------------------------------------------
-- Access, replay, projections

create function private.assert_forms_access(p_business_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not public.has_business_role(p_business_id, array['owner', 'admin']::public.business_member_role[]) then
    raise exception using errcode = 'P0001', message = 'permission_denied';
  end if;
end;
$$;

revoke all on function private.assert_forms_access(uuid) from public;

-- The recorded answer of a write, for its author only. Null: not seen yet.
create function private.form_replay(
  p_business_id uuid,
  p_request_id uuid,
  p_actor text,
  p_kind text,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_existing private.form_requests;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  -- Two copies of the same request in flight: the second waits for the
  -- first, then reads its recorded answer instead of failing on the key.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text || '/' || p_request_id::text, 0));
  select * into v_existing
  from private.form_requests r
  where r.business_id = p_business_id and r.request_id = p_request_id;
  if found then
    if v_existing.actor <> p_actor or v_existing.kind <> p_kind
       or v_existing.fingerprint <> pg_catalog.md5(p_payload::text) then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return v_existing.response;
  end if;
  return null;
end;
$$;

revoke all on function private.form_replay(uuid, uuid, text, text, jsonb) from public;

create function private.form_record(
  p_business_id uuid,
  p_request_id uuid,
  p_actor text,
  p_kind text,
  p_payload jsonb,
  p_response jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
begin
  insert into private.form_requests (business_id, request_id, actor, kind, fingerprint, response)
  values (p_business_id, p_request_id, p_actor, p_kind, pg_catalog.md5(p_payload::text), p_response);
  return p_response;
end;
$$;

revoke all on function private.form_record(uuid, uuid, text, text, jsonb, jsonb) from public;

create function private.form_template_json(p_template_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'templateId', t.id,
    'status', t.status,
    'draftVersion', t.draft_version,
    'draft', t.draft,
    'published', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'versionId', v.id, 'number', v.number, 'publishedAt', v.published_at
      ) order by v.number desc)
      from private.form_versions v where v.template_id = t.id
    ), '[]'::jsonb)
  )
  from private.form_templates t
  where t.id = p_template_id;
$$;

revoke all on function private.form_template_json(uuid) from public;

-- Status as she and the professional see it: an open form whose visit is
-- cancelled is no longer asked; one past its deadline has expired.
create function private.form_effective_status(
  p_assignment private.form_assignments,
  p_now timestamptz
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_assignment.status = 'assigned' and exists (
      select 1 from public.appointments a
      where a.id = p_assignment.appointment_id and a.status <> 'confirmed'
    ) then 'revoked'
    when p_assignment.status = 'assigned' and p_assignment.expires_at is not null
         and p_assignment.expires_at <= p_now then 'expired'
    else p_assignment.status
  end;
$$;

revoke all on function private.form_effective_status(private.form_assignments, timestamptz) from public;

create function private.form_assignment_pro_json(p_assignment_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'assignmentId', fa.id,
    'title', v.content ->> 'title',
    'versionNumber', v.number,
    'status', private.form_effective_status(fa, pg_catalog.now()),
    'sentAt', fa.created_at,
    'expiresAt', fa.expires_at,
    'review', v.content ->> 'review',
    'version', fa.revision,
    'submission', case when s.id is null then null else pg_catalog.jsonb_build_object(
      'submittedAt', s.submitted_at,
      'fields', v.content -> 'fields',
      'answers', s.answers
    ) end,
    'reviewedAt', fa.reviewed_at
  )
  from private.form_assignments fa
  join private.form_versions v on v.id = fa.version_id
  left join private.form_submissions s on s.assignment_id = fa.id
  where fa.id = p_assignment_id;
$$;

revoke all on function private.form_assignment_pro_json(uuid) from public;

-- ---------------------------------------------------------------------------
-- Professional: templates

create function public.list_form_templates(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_forms_access(p_business_id);
  return coalesce((
    select pg_catalog.jsonb_agg(private.form_template_json(t.id) order by t.created_at)
    from private.form_templates t
    where t.business_id = p_business_id
  ), '[]'::jsonb);
end;
$$;

create function public.read_form_template(p_business_id uuid, p_template_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_forms_access(p_business_id);
  if not exists (
    select 1 from private.form_templates t
    where t.id = p_template_id and t.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  return private.form_template_json(p_template_id);
end;
$$;

create function public.create_form_template(
  p_business_id uuid,
  p_request_id uuid,
  p_draft jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := 'pro:' || (select auth.uid())::text;
  v_payload jsonb := pg_catalog.jsonb_build_object('draft', p_draft);
  v_replay jsonb;
  v_clean jsonb;
  v_id uuid;
begin
  perform private.assert_forms_access(p_business_id);
  v_replay := private.form_replay(p_business_id, p_request_id, v_actor, 'create', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  v_clean := private.form_check_draft(p_draft);
  if (select count(*) from private.form_templates t where t.business_id = p_business_id) >= 100 then
    raise exception using errcode = 'P0001', message = 'form_limit_reached';
  end if;
  insert into private.form_templates (business_id, draft, created_by)
  values (p_business_id, v_clean, (select auth.uid()))
  returning id into v_id;
  return private.form_record(p_business_id, p_request_id, v_actor, 'create', v_payload,
    private.form_template_json(v_id));
end;
$$;

create function private.form_lock_template(
  p_business_id uuid,
  p_template_id uuid,
  p_expected_draft_version integer
)
returns private.form_templates
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_template private.form_templates;
begin
  select * into v_template
  from private.form_templates t
  where t.id = p_template_id and t.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_draft_version is null or v_template.draft_version <> p_expected_draft_version then
    raise exception using errcode = 'P0001', message = 'version_conflict', hint = 'draftVersion';
  end if;
  return v_template;
end;
$$;

revoke all on function private.form_lock_template(uuid, uuid, integer) from public;

create function public.save_form_draft(
  p_business_id uuid,
  p_template_id uuid,
  p_expected_draft_version integer,
  p_request_id uuid,
  p_draft jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := 'pro:' || (select auth.uid())::text;
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'templateId', p_template_id, 'expectedDraftVersion', p_expected_draft_version, 'draft', p_draft);
  v_replay jsonb;
  v_clean jsonb;
begin
  perform private.assert_forms_access(p_business_id);
  v_replay := private.form_replay(p_business_id, p_request_id, v_actor, 'save', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform private.form_lock_template(p_business_id, p_template_id, p_expected_draft_version);
  v_clean := private.form_check_draft(p_draft);
  update private.form_templates t
  set draft = v_clean, draft_version = t.draft_version + 1, updated_at = pg_catalog.now()
  where t.id = p_template_id;
  return private.form_record(p_business_id, p_request_id, v_actor, 'save', v_payload,
    private.form_template_json(p_template_id));
end;
$$;

-- Freezes the SAVED draft as version n + 1. Forms already sent keep theirs.
create function public.publish_form_template(
  p_business_id uuid,
  p_template_id uuid,
  p_expected_draft_version integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := 'pro:' || (select auth.uid())::text;
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'templateId', p_template_id, 'expectedDraftVersion', p_expected_draft_version);
  v_replay jsonb;
  v_template private.form_templates;
  v_clean jsonb;
  v_number integer;
begin
  perform private.assert_forms_access(p_business_id);
  v_replay := private.form_replay(p_business_id, p_request_id, v_actor, 'publish', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  v_template := private.form_lock_template(p_business_id, p_template_id, p_expected_draft_version);
  -- The rules are checked again: a draft saved under older rules is not trusted.
  v_clean := private.form_check_draft(v_template.draft);
  select coalesce(max(v.number), 0) + 1 into v_number
  from private.form_versions v where v.template_id = p_template_id;
  insert into private.form_versions (template_id, business_id, number, content, content_hash, published_by)
  values (p_template_id, p_business_id, v_number, v_clean,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_clean::text, 'UTF8')), 'hex'),
    (select auth.uid()));
  update private.form_templates t
  set status = 'active', draft_version = t.draft_version + 1, updated_at = pg_catalog.now()
  where t.id = p_template_id;
  return private.form_record(p_business_id, p_request_id, v_actor, 'publish', v_payload,
    private.form_template_json(p_template_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Professional: the forms of a visit

create function public.read_visit_forms(p_business_id uuid, p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments;
  v_client_name text;
begin
  perform private.assert_forms_access(p_business_id);
  select * into v_appointment
  from public.appointments a
  where a.id = p_appointment_id and a.business_id = p_business_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  select pg_catalog.btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))
  into v_client_name
  from public.clients c where c.id = v_appointment.client_id;

  return pg_catalog.jsonb_build_object(
    'appointmentId', v_appointment.id,
    'clientName', v_client_name,
    'assignments', coalesce((
      select pg_catalog.jsonb_agg(private.form_assignment_pro_json(fa.id) order by fa.created_at)
      from private.form_assignments fa
      where fa.appointment_id = v_appointment.id and fa.business_id = p_business_id
    ), '[]'::jsonb),
    'templates', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'templateVersionId', v.id, 'title', v.content ->> 'title', 'versionNumber', v.number
      ) order by t.created_at)
      from private.form_templates t
      join lateral (
        select * from private.form_versions v
        where v.template_id = t.id order by v.number desc limit 1
      ) v on true
      where t.business_id = p_business_id and t.status = 'active'
    ), '[]'::jsonb)
  );
end;
$$;

create function public.assign_visit_form(
  p_business_id uuid,
  p_appointment_id uuid,
  p_template_version_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := 'pro:' || (select auth.uid())::text;
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'appointmentId', p_appointment_id, 'templateVersionId', p_template_version_id);
  v_replay jsonb;
  v_appointment public.appointments;
  v_version private.form_versions;
  v_id uuid;
begin
  perform private.assert_forms_access(p_business_id);
  v_replay := private.form_replay(p_business_id, p_request_id, v_actor, 'assign', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;

  -- The visit must still be ahead and confirmed while the form is created.
  select * into v_appointment
  from public.appointments a
  where a.id = p_appointment_id and a.business_id = p_business_id
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if v_appointment.status <> 'confirmed' or v_appointment.starts_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'appointment_not_editable';
  end if;

  select v.* into v_version
  from private.form_versions v
  join private.form_templates t on t.id = v.template_id
  where v.id = p_template_version_id and v.business_id = p_business_id and t.status = 'active';
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  begin
    insert into private.form_assignments (
      business_id, appointment_id, client_id, template_id, version_id, expires_at, created_by
    ) values (
      p_business_id, v_appointment.id, v_appointment.client_id, v_version.template_id,
      v_version.id, v_appointment.starts_at, (select auth.uid())
    )
    returning id into v_id;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'form_already_assigned';
  end;

  return private.form_record(p_business_id, p_request_id, v_actor, 'assign', v_payload,
    private.form_assignment_pro_json(v_id));
end;
$$;

create function private.form_lock_assignment(
  p_business_id uuid,
  p_assignment_id uuid,
  p_expected_version integer
)
returns private.form_assignments
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_assignment private.form_assignments;
begin
  select * into v_assignment
  from private.form_assignments fa
  where fa.id = p_assignment_id and fa.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_version is null or v_assignment.revision <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'version_conflict', hint = 'version';
  end if;
  return v_assignment;
end;
$$;

revoke all on function private.form_lock_assignment(uuid, uuid, integer) from public;

-- Only a form she has not answered yet can be withdrawn.
create function public.revoke_visit_form(
  p_business_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := 'pro:' || (select auth.uid())::text;
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'assignmentId', p_assignment_id, 'expectedVersion', p_expected_version);
  v_replay jsonb;
  v_assignment private.form_assignments;
begin
  perform private.assert_forms_access(p_business_id);
  v_replay := private.form_replay(p_business_id, p_request_id, v_actor, 'revoke', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  v_assignment := private.form_lock_assignment(p_business_id, p_assignment_id, p_expected_version);
  if v_assignment.status in ('submitted', 'completed') then
    raise exception using errcode = 'P0001', message = 'form_already_submitted';
  end if;
  if v_assignment.status = 'assigned' then
    update private.form_assignments fa
    set status = 'revoked', revoked_at = pg_catalog.now(), revision = fa.revision + 1
    where fa.id = v_assignment.id;
  end if;
  return private.form_record(p_business_id, p_request_id, v_actor, 'revoke', v_payload,
    private.form_assignment_pro_json(v_assignment.id));
end;
$$;

-- `submitted` → `completed`, attributed to the professional by the server.
create function public.review_visit_form(
  p_business_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := 'pro:' || (select auth.uid())::text;
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'assignmentId', p_assignment_id, 'expectedVersion', p_expected_version);
  v_replay jsonb;
  v_assignment private.form_assignments;
begin
  perform private.assert_forms_access(p_business_id);
  v_replay := private.form_replay(p_business_id, p_request_id, v_actor, 'review', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  v_assignment := private.form_lock_assignment(p_business_id, p_assignment_id, p_expected_version);
  if v_assignment.status <> 'submitted' then
    raise exception using errcode = 'P0001', message = 'invalid_status_transition';
  end if;
  update private.form_assignments fa
  set status = 'completed', reviewed_at = pg_catalog.now(), reviewed_by = (select auth.uid()),
      revision = fa.revision + 1
  where fa.id = v_assignment.id;
  return private.form_record(p_business_id, p_request_id, v_actor, 'review', v_payload,
    private.form_assignment_pro_json(v_assignment.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Client Hub: read and send

-- Her CRM record in this business, through an ACTIVE Hub access whose email
-- is still the record's (as private.client_hub_client). With p_lock, the
-- access row is held FOR SHARE: a revocation or an email change waits for
-- the submission, or the submission sees it and stops.
create function private.form_hub_client(
  p_account private.client_hub_accounts,
  p_business_id uuid,
  p_lock boolean
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if p_lock then
    select a.client_id into v_client
    from public.client_hub_access a
    join public.clients c on c.id = a.client_id and c.business_id = a.business_id
    where a.business_id = p_business_id
      and a.revoked_at is null
      and a.email = p_account.email
      and private.canonical_email(c.email::text) = p_account.email::text
    for share of a;
  else
    v_client := private.client_hub_client(p_account, p_business_id);
  end if;
  if v_client is null then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;
  return v_client;
end;
$$;

revoke all on function private.form_hub_client(private.client_hub_accounts, uuid, boolean) from public;

create function private.form_client_json(p_assignment private.form_assignments, p_now timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'assignmentId', p_assignment.id,
    'templateVersionId', v.id,
    'title', v.content ->> 'title',
    'businessName', b.name,
    'intro', nullif(v.content ->> 'intro', ''),
    'status', private.form_effective_status(p_assignment, p_now),
    'expiresAt', p_assignment.expires_at,
    'canSubmit', private.form_effective_status(p_assignment, p_now) = 'assigned',
    'review', v.content ->> 'review',
    'fields', v.content -> 'fields',
    'receipt', case when s.id is null then null else pg_catalog.jsonb_build_object(
      'receiptId', s.id, 'submittedAt', s.submitted_at) end
  )
  from private.form_versions v
  join public.businesses b on b.id = v.business_id
  left join private.form_submissions s on s.assignment_id = p_assignment.id
  where v.id = p_assignment.version_id;
$$;

revoke all on function private.form_client_json(private.form_assignments, timestamptz) from public;

create function public.client_hub_form(
  p_session_token text,
  p_business_id uuid,
  p_assignment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.form_hub_client(v_account, p_business_id, false);
  v_assignment private.form_assignments;
begin
  select * into v_assignment
  from private.form_assignments fa
  where fa.id = p_assignment_id and fa.business_id = p_business_id and fa.client_id = v_client;
  if not found then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;
  return private.form_client_json(v_assignment, pg_catalog.now());
end;
$$;

create function public.client_hub_forms(
  p_session_token text,
  p_business_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.form_hub_client(v_account, p_business_id, false);
begin
  return coalesce((
    select pg_catalog.jsonb_agg(private.form_client_json(fa, pg_catalog.now()) order by fa.created_at desc)
    from private.form_assignments fa
    where fa.business_id = p_business_id and fa.client_id = v_client
      and fa.status <> 'revoked'
  ), '[]'::jsonb);
end;
$$;

create function public.client_hub_submit_form(
  p_session_token text,
  p_business_id uuid,
  p_assignment_id uuid,
  p_template_version_id uuid,
  p_request_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, v_now);
  v_client uuid;
  v_actor text;
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'assignmentId', p_assignment_id, 'templateVersionId', p_template_version_id, 'answers', p_answers);
  v_replay jsonb;
  v_assignment private.form_assignments;
  v_version private.form_versions;
  v_status text;
  v_field jsonb;
  v_answer jsonb;
  v_given jsonb := '{}';
  v_visible jsonb := '{}';
  v_value jsonb;
  v_source text;
  v_out jsonb := '[]';
  v_receipt uuid;
  v_submitted_at timestamptz;
  v_next text;
begin
  v_actor := 'hub:' || v_account.id::text;
  -- Her relation first, held until commit.
  v_client := private.form_hub_client(v_account, p_business_id, true);

  select * into v_assignment
  from private.form_assignments fa
  where fa.id = p_assignment_id and fa.business_id = p_business_id and fa.client_id = v_client
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;

  v_replay := private.form_replay(p_business_id, p_request_id, v_actor, 'submit', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;

  v_status := private.form_effective_status(v_assignment, v_now);
  if v_status = 'revoked' then
    raise exception using errcode = 'P0001', message = 'form_revoked';
  elsif v_status = 'expired' then
    raise exception using errcode = 'P0001', message = 'form_expired';
  elsif v_status <> 'assigned' then
    raise exception using errcode = 'P0001', message = 'form_already_submitted';
  end if;
  if p_template_version_id is distinct from v_assignment.version_id then
    raise exception using errcode = 'P0001', message = 'stale_form';
  end if;

  select * into v_version from private.form_versions v where v.id = v_assignment.version_id;

  -- Index her answers by field; an unknown field or a duplicate is refused.
  if pg_catalog.jsonb_typeof(p_answers) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_answers) > 50 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'answers';
  end if;
  for v_answer in select x from pg_catalog.jsonb_array_elements(p_answers) x loop
    if pg_catalog.jsonb_typeof(v_answer) is distinct from 'object'
       or (v_answer ->> 'fieldId') is null
       or v_given ? (v_answer ->> 'fieldId')
       or not exists (
         select 1 from pg_catalog.jsonb_array_elements(v_version.content -> 'fields') f
         where f ->> 'id' = v_answer ->> 'fieldId'
       ) then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'answers';
    end if;
    v_given := v_given || pg_catalog.jsonb_build_object(v_answer ->> 'fieldId', v_answer);
  end loop;

  -- Walk the questions in order: the server decides which are visible.
  for v_field in select f from pg_catalog.jsonb_array_elements(v_version.content -> 'fields') f loop
    v_source := v_field -> 'showIf' ->> 'field';
    if v_source is not null and not (
      v_visible ? v_source and (v_visible -> v_source) = (v_field -> 'showIf' -> 'equals')
    ) then
      -- Hidden: an answer to it is refused, never stored.
      if v_given ? (v_field ->> 'id') then
        raise exception using errcode = '22023', message = 'invalid_input', hint = 'answers';
      end if;
      continue;
    end if;

    v_answer := v_given -> (v_field ->> 'id');
    v_value := v_answer -> 'value';
    if v_value is null or pg_catalog.jsonb_typeof(v_value) = 'null'
       or (pg_catalog.jsonb_typeof(v_value) = 'string' and pg_catalog.btrim(v_value #>> '{}') = '') then
      if (v_field -> 'required')::boolean then
        raise exception using errcode = 'P0001', message = 'field_required', hint = v_field ->> 'id';
      end if;
      continue;
    end if;

    case v_field ->> 'type'
      when 'short_text' then
        if pg_catalog.jsonb_typeof(v_value) <> 'string'
           or pg_catalog.char_length(v_value #>> '{}') > 1000 then
          raise exception using errcode = '22023', message = 'invalid_input', hint = 'answers';
        end if;
        v_value := pg_catalog.to_jsonb(pg_catalog.btrim(v_value #>> '{}'));
      when 'single_choice' then
        if pg_catalog.jsonb_typeof(v_value) <> 'string' or not exists (
          select 1 from pg_catalog.jsonb_array_elements(v_field -> 'options') o
          where o ->> 'id' = v_value #>> '{}'
        ) then
          raise exception using errcode = '22023', message = 'invalid_input', hint = 'answers';
        end if;
      when 'boolean' then
        if pg_catalog.jsonb_typeof(v_value) <> 'boolean' then
          raise exception using errcode = '22023', message = 'invalid_input', hint = 'answers';
        end if;
        -- A yes/no question: both values are answers, required or not.
      when 'attestation' then
        if v_value <> 'true'::jsonb then
          if (v_field -> 'required')::boolean then
            raise exception using errcode = 'P0001', message = 'field_required', hint = v_field ->> 'id';
          end if;
          continue;
        end if;
        -- She confirms the text she was shown: it must be this version's.
        if (v_answer ->> 'attestedText') is distinct from (v_field ->> 'attestationText') then
          raise exception using errcode = 'P0001', message = 'stale_form';
        end if;
    end case;

    v_visible := v_visible || pg_catalog.jsonb_build_object(v_field ->> 'id', v_value);
    v_out := v_out || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('fieldId', v_field ->> 'id', 'value', v_value)
      || case when v_field ->> 'type' = 'attestation'
           then pg_catalog.jsonb_build_object('attestedText', v_field ->> 'attestationText', 'attestedAt', v_now)
           else '{}'::jsonb end
    );
  end loop;

  insert into private.form_submissions (assignment_id, business_id, answers, submitted_at)
  values (v_assignment.id, p_business_id, v_out, v_now)
  returning id, submitted_at into v_receipt, v_submitted_at;

  v_next := case when v_version.content ->> 'review' = 'professional' then 'submitted' else 'completed' end;
  update private.form_assignments fa
  set status = v_next, revision = fa.revision + 1
  where fa.id = v_assignment.id;

  return private.form_record(p_business_id, p_request_id, v_actor, 'submit', v_payload,
    pg_catalog.jsonb_build_object('receiptId', v_receipt, 'status', v_next, 'submittedAt', v_submitted_at));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function public.list_form_templates(uuid) from public;
revoke all on function public.read_form_template(uuid, uuid) from public;
revoke all on function public.create_form_template(uuid, uuid, jsonb) from public;
revoke all on function public.save_form_draft(uuid, uuid, integer, uuid, jsonb) from public;
revoke all on function public.publish_form_template(uuid, uuid, integer, uuid) from public;
revoke all on function public.read_visit_forms(uuid, uuid) from public;
revoke all on function public.assign_visit_form(uuid, uuid, uuid, uuid) from public;
revoke all on function public.revoke_visit_form(uuid, uuid, integer, uuid) from public;
revoke all on function public.review_visit_form(uuid, uuid, integer, uuid) from public;
revoke all on function public.client_hub_form(text, uuid, uuid) from public;
revoke all on function public.client_hub_forms(text, uuid) from public;
revoke all on function public.client_hub_submit_form(text, uuid, uuid, uuid, uuid, jsonb) from public;

grant execute on function public.list_form_templates(uuid) to authenticated;
grant execute on function public.read_form_template(uuid, uuid) to authenticated;
grant execute on function public.create_form_template(uuid, uuid, jsonb) to authenticated;
grant execute on function public.save_form_draft(uuid, uuid, integer, uuid, jsonb) to authenticated;
grant execute on function public.publish_form_template(uuid, uuid, integer, uuid) to authenticated;
grant execute on function public.read_visit_forms(uuid, uuid) to authenticated;
grant execute on function public.assign_visit_form(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.revoke_visit_form(uuid, uuid, integer, uuid) to authenticated;
grant execute on function public.review_visit_form(uuid, uuid, integer, uuid) to authenticated;
-- The Hub is served by the app's route handlers only (service role + her
-- session token), like every other client_hub_* function.
grant execute on function public.client_hub_form(text, uuid, uuid) to service_role;
grant execute on function public.client_hub_forms(text, uuid) to service_role;
grant execute on function public.client_hub_submit_form(text, uuid, uuid, uuid, uuid, jsonb) to service_role;
