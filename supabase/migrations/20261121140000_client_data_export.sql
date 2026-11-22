-- Everything a business holds about one of its customers, as one document
-- (Higani point 205, right of access and portability). The professional,
-- owner or admin of the business, exports it from the customer's record to
-- answer her request. Read-only.
--
-- Included, for this business only: her record and contact, her
-- appointments with the contact and options they were booked with, the
-- professional's notes, her marketing consent history and confirmations,
-- her loyalty (balance, entries, rewards), her forms and answers, the
-- emails sent to her (type, address, status, dates; not their content
-- variables), her client space access, her referrals, her waitlist
-- requests made with her address, and the marketing messages sent to her.
-- Excluded: secrets and technical keys (token hashes, request ids and
-- fingerprints, leases), and nothing from any other business.
create function public.privacy_export_client(p_business_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client public.clients;
  v_business_name text;
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = p_client_id and c.business_id = p_business_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'client_not_found';
  end if;

  select b.name into v_business_name
  from public.businesses b
  where b.id = p_business_id;

  return pg_catalog.jsonb_build_object(
    'format', 'higani.client-export.v1',
    'exportedAt', pg_catalog.now(),
    'business', pg_catalog.jsonb_build_object('name', v_business_name),
    'client', pg_catalog.jsonb_build_object(
      'firstName', v_client.first_name,
      'lastName', v_client.last_name,
      'email', v_client.email,
      'phone', v_client.phone,
      'professionalNotes', v_client.internal_notes,
      'createdAt', v_client.created_at,
      'updatedAt', v_client.updated_at
    ),
    'appointments', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'startsAt', a.starts_at,
        'endsAt', a.ends_at,
        'status', a.status,
        'service', a.service_name_snapshot,
        'durationMinutes', a.duration_minutes_snapshot,
        'priceCents', a.price_cents_snapshot,
        'currency', a.currency,
        'options', a.options_snapshot,
        'cancellationReason', a.cancellation_reason,
        'professionalNotes', a.internal_notes,
        'bookedWith', pg_catalog.jsonb_build_object(
          'firstName', a.client_first_name_snapshot,
          'lastName', a.client_last_name_snapshot,
          'email', a.client_email_snapshot,
          'phone', a.client_phone_snapshot
        ),
        'createdAt', a.created_at,
        'completedAt', a.completed_at
      ) order by a.starts_at)
      from public.appointments a
      where a.business_id = p_business_id and a.client_id = p_client_id
    ), '[]'::jsonb),
    'notes', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'content', n.content,
        'createdAt', n.created_at,
        'updatedAt', n.updated_at
      ) order by n.created_at)
      from public.client_notes n
      where n.business_id = p_business_id and n.client_id = p_client_id
    ), '[]'::jsonb),
    'marketingConsent', pg_catalog.jsonb_build_object(
      'events', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'purpose', e.purpose,
          'channel', e.channel,
          'state', e.state,
          'source', e.source,
          'textVersion', e.proof_version,
          'at', e.created_at
        ) order by e.created_at, e.id)
        from private.consent_events e
        where e.business_id = p_business_id and e.client_id = p_client_id
      ), '[]'::jsonb),
      'confirmations', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'channels', cc.channels,
          'email', cc.email,
          'phone', cc.phone,
          'sentAt', cc.sent_at,
          'confirmedAt', cc.confirmed_at,
          'expiresAt', cc.expires_at
        ) order by cc.created_at)
        from private.consent_confirmations cc
        where cc.business_id = p_business_id and cc.client_id = p_client_id
      ), '[]'::jsonb)
    ),
    'loyalty', pg_catalog.jsonb_build_object(
      'balance', (
        select lb.balance
        from public.loyalty_balances lb
        where lb.business_id = p_business_id and lb.client_id = p_client_id
      ),
      'entries', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'type', le.type,
          'points', le.points_delta,
          'reason', le.reason,
          'at', le.created_at
        ) order by le.created_at, le.ledger_seq)
        from public.loyalty_events le
        where le.business_id = p_business_id and le.client_id = p_client_id
      ), '[]'::jsonb),
      'rewards', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'reward', r.reward_name_snapshot,
          'points', r.points_spent,
          'status', r.status,
          'redeemedAt', r.redeemed_at,
          'fulfilledAt', r.fulfilled_at,
          'cancelledAt', r.cancelled_at
        ) order by r.redeemed_at)
        from public.reward_redemptions r
        where r.business_id = p_business_id and r.client_id = p_client_id
      ), '[]'::jsonb)
    ),
    'forms', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'title', v.content ->> 'title',
        'status', fa.status,
        'sentAt', fa.created_at,
        'answers', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'answers', fs.answers,
            'submittedAt', fs.submitted_at
          ) order by fs.submitted_at)
          from private.form_submissions fs
          where fs.assignment_id = fa.id and fs.business_id = p_business_id
        ), '[]'::jsonb)
      ) order by fa.created_at)
      from private.form_assignments fa
      left join private.form_versions v on v.id = fa.version_id
      where fa.business_id = p_business_id and fa.client_id = p_client_id
    ), '[]'::jsonb),
    'emails', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'type', ee.type,
        'to', ee.recipient_email,
        'status', ee.status,
        'scheduledFor', ee.scheduled_for,
        'sentAt', ee.sent_at,
        'createdAt', ee.created_at
      ) order by ee.created_at, ee.id)
      from public.email_events ee
      where ee.business_id = p_business_id and ee.client_id = p_client_id
    ), '[]'::jsonb),
    'clientSpace', (
      select pg_catalog.jsonb_build_object(
        'email', h.email,
        'grantedAt', h.granted_at,
        'revokedAt', h.revoked_at,
        'revocation', h.revocation
      )
      from public.client_hub_access h
      where h.business_id = p_business_id and h.client_id = p_client_id
    ),
    'referrals', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'role', case when rf.referrer_client_id = p_client_id then 'referrer' else 'referred' end,
        'state', rf.state,
        'rewardPoints', rf.reward_points,
        'claimedAt', rf.claimed_at
      ) order by rf.claimed_at)
      from private.referrals rf
      where rf.business_id = p_business_id
        and (rf.referrer_client_id = p_client_id or rf.referred_client_id = p_client_id)
    ), '[]'::jsonb),
    'waitlist', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'service', s.name,
        'firstName', w.first_name,
        'email', w.email,
        'windows', w.windows,
        'anyTime', w.any_time,
        'state', w.state,
        'createdAt', w.created_at
      ) order by w.created_at)
      from private.waitlist_requests w
      left join public.services s on s.id = w.service_id
      where w.business_id = p_business_id
        and v_client.email is not null
        and private.canonical_email(w.email::text) = private.canonical_email(v_client.email::text)
    ), '[]'::jsonb),
    'marketingMessages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'channel', g.channel,
        'status', g.status,
        'at', g.created_at
      ) order by g.created_at)
      from private.growth_occurrences g
      where g.business_id = p_business_id and g.client_id = p_client_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.privacy_export_client(uuid, uuid) from public, anon, authenticated;
grant execute on function public.privacy_export_client(uuid, uuid) to authenticated;
