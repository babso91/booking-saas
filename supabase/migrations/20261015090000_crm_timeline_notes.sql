-- CRM V1, step 4 (backend part of PR #19): private dated notes in the
-- relationship timeline.
--
-- public.crm_client_timeline gains a fourth source, `note`: every note of
-- the customer (public.client_notes, 20261014090000) that exists now, as one
-- event `note:<uuid>` dated by its created_at, the instant it was written,
-- set by the database and never changed: an edit changes the event's
-- content, never its place; a deleted note is no longer read. There is no
-- edit or delete event, and nothing is invented (authors may be null: a
-- deleted account; the legacy free text clients.internal_notes, with no date
-- or author, is not a timeline event).
--
-- Everything else is unchanged: signature, SECURITY INVOKER (the members-only
-- row level security of client_notes applies to this branch as to the
-- others), membership check, order (occurred_at descending, then event id
-- descending, byte by byte) and keyset. The index
-- client_notes_client_idx (business_id, client_id, created_at desc, id desc)
-- serves the branch. Grants are kept by CREATE OR REPLACE.

-- One page of a customer's relationship history, newest first. Only
-- persisted facts, one event per business fact:
--   appointment  every appointment of the customer except the upcoming ones
--                (confirmed, starting after p_as_of: shown apart, in the
--                profile); dated by its start. Its contact is the
--                appointment's own snapshot, its service name and price the
--                ones recorded on it; completed_at is when it was marked
--                completed (null when unknown);
--   loyalty      a loyalty_events ledger entry, dated by its creation; a
--                reward redemption is part of the ledger entry it references
--                (reward_redemptions.loyalty_event_id, unique), never an
--                event of its own;
--   email        an email_events row, dated by its creation (when it was
--                recorded): its status says scheduled (pending), sending,
--                sent, failed or cancelled; delivery is not tracked. No
--                payload, provider identifier or error text;
--   note         a private note (client_notes), dated by its creation; its
--                current content, version, authors (null when unknown) and
--                dates. Professionals only (row level security).
-- Identity: "<kind>:<uuid>", stable. Order: occurred_at descending, then
-- event id descending, compared byte by byte (collation "C": independent of
-- the database locale), a total order. Keyset: the next page starts strictly
-- after (p_before_at, p_before_id), the last event read; p_as_of, returned
-- with every row, must be given back so every page excludes the same
-- upcoming appointments. At most p_limit + 1 rows: the extra one says
-- another page exists. data: the event's fields (crm read model contract).
create or replace function public.crm_client_timeline(
  p_business_id uuid,
  p_client_id uuid,
  p_limit integer default 20,
  p_as_of timestamptz default null,
  p_before_at timestamptz default null,
  p_before_id text default null
)
returns table (
  event_id text,
  kind text,
  occurred_at timestamptz,
  as_of timestamptz,
  data jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.now());
begin
  perform public.crm_assert_member(p_business_id);
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'limit';
  end if;
  if (p_before_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'cursor';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found';
  end if;

  return query
  with events as (
    select
      'appointment:' || a.id::text as event_id,
      'appointment'::text as kind,
      a.starts_at as occurred_at,
      pg_catalog.jsonb_build_object(
        'id', a.id,
        'status', a.status,
        'startsAt', a.starts_at,
        'endsAt', a.ends_at,
        'serviceId', a.service_id,
        'serviceName', a.service_name_snapshot,
        'durationMinutes', a.duration_minutes_snapshot,
        'priceCents', a.price_cents_snapshot,
        'currency', a.currency,
        'source', case when a.created_by is null then 'public' else 'manual' end,
        'completedAt', a.completed_at,
        'cancellationReason', a.cancellation_reason,
        'contact', pg_catalog.jsonb_build_object(
          'firstName', a.client_first_name_snapshot,
          'lastName', a.client_last_name_snapshot,
          'email', a.client_email_snapshot,
          'phone', a.client_phone_snapshot
        )
      ) as data
    from public.appointments a
    where a.business_id = p_business_id
      and a.client_id = p_client_id
      and not (a.status = 'confirmed' and a.starts_at > v_as_of)
    union all
    select
      'loyalty:' || l.id::text,
      'loyalty',
      l.created_at,
      pg_catalog.jsonb_build_object(
        'id', l.id,
        'type', l.type,
        'pointsDelta', l.points_delta,
        'reason', l.reason,
        'appointmentId', l.appointment_id,
        'redemption', (
          select pg_catalog.jsonb_build_object(
            'id', r.id,
            'rewardId', r.reward_id,
            'rewardName', w.name,
            'pointsSpent', r.points_spent,
            'redeemedAt', r.redeemed_at
          )
          from public.reward_redemptions r
          left join public.rewards w
            on w.id = r.reward_id and w.business_id = r.business_id
          where r.loyalty_event_id = l.id
            and r.business_id = l.business_id
        )
      )
    from public.loyalty_events l
    where l.business_id = p_business_id
      and l.client_id = p_client_id
    union all
    select
      'email:' || e.id::text,
      'email',
      e.created_at,
      pg_catalog.jsonb_build_object(
        'id', e.id,
        'type', e.type,
        'status', e.status,
        'scheduledFor', e.scheduled_for,
        'sentAt', e.sent_at,
        'recipientEmail', e.recipient_email::text,
        'appointmentId', e.appointment_id
      )
    from public.email_events e
    where e.business_id = p_business_id
      and e.client_id = p_client_id
    union all
    select
      'note:' || n.id::text,
      'note',
      n.created_at,
      pg_catalog.jsonb_build_object(
        'id', n.id,
        'content', n.content,
        'version', n.version,
        'createdBy', n.created_by,
        'updatedBy', n.updated_by,
        'createdAt', n.created_at,
        'updatedAt', n.updated_at
      )
    from public.client_notes n
    where n.business_id = p_business_id
      and n.client_id = p_client_id
  )
  select ev.event_id, ev.kind, ev.occurred_at, v_as_of, ev.data
  from events ev
  where p_before_at is null
    or (ev.occurred_at, ev.event_id collate "C") < (p_before_at, p_before_id collate "C")
  order by ev.occurred_at desc, ev.event_id collate "C" desc
  limit p_limit + 1;
end;
$$;
