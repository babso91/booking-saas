import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as postBooking } from "@/app/api/bookings/route";
import {
  generateTeamInviteToken,
  hashTeamInviteToken,
  type TeamMemberDto,
} from "@/features/team/data/team";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  env,
  everyDay,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Point 100 (Higani backlog): who changed an appointment, and what. Every
// write path appends to the history in its own transaction; the history
// keeps the actor and the changed fields only (never a note's text nor the
// client's contact details), and is read by whoever may read the
// appointment.

const SECRET = "appointment-history-proxy-secret-0123456789";
const BASE = "http://localhost:3000";
const TZ = "Europe/Paris";

type Change = { type: string } & Record<string, unknown>;
type Entry = {
  id: number;
  version: number;
  localAt: string;
  actor: { kind: string; name: string | null; isYou: boolean };
  backfilled: boolean;
  changes: Change[];
};
type History = { timeZone: string; entries: Entry[]; truncated: boolean };

let owner: Professional;
let business: TestBusiness;
let coupe: string;
let couleur: string;
let inesId: string;
let mayaId: string;

const localDate = (daysFromToday: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(Date.now() + daysFromToday * 86_400_000),
  );
async function instant(date: string, time: string) {
  const { rows } = await db.query<{ at: Date }>(
    "select ($1::date + $2::time) at time zone $3 as at",
    [date, time, TZ],
  );
  return rows[0]!.at.toISOString();
}

async function call<T>(
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await client.rpc(fn as never, args as never);
  return { data: data as T, error };
}
async function ok<T>(promise: Promise<{ data: T; error: unknown }>) {
  const { data, error } = await promise;
  expect(error).toBeNull();
  return data;
}

const history = (id: string, client = owner.client) =>
  call<History>(client, "appointment_history", {
    p_business_id: business.id,
    p_appointment_id: id,
  });

async function create(date: string, time: string, notes?: string) {
  const [row] = await ok(
    call<{ appointment_id: string }[]>(
      owner.client,
      "agenda_create_appointment",
      {
        p_business_id: business.id,
        p_service_id: coupe,
        p_client_id: inesId,
        p_starts_at: await instant(date, time),
        p_request_id: randomUUID(),
        ...(notes ? { p_internal_notes: notes } : {}),
      },
    ),
  );
  return row!.appointment_id;
}
async function current(id: string) {
  const { rows } = await db.query(
    "select version, service_id, client_id, internal_notes from public.appointments where id = $1",
    [id],
  );
  return rows[0] as {
    version: number;
    service_id: string;
    client_id: string;
    internal_notes: string | null;
  };
}
async function update(
  id: string,
  changes: {
    startsAt?: string;
    serviceId?: string;
    clientId?: string;
    notes?: string | null;
  },
) {
  const row = await current(id);
  await ok(
    call(owner.client, "agenda_update_appointment", {
      p_business_id: business.id,
      p_appointment_id: id,
      p_expected_version: row.version,
      p_service_id: changes.serviceId ?? row.service_id,
      p_client_id: changes.clientId ?? row.client_id,
      p_internal_notes:
        changes.notes === undefined ? row.internal_notes : changes.notes,
      ...(changes.startsAt ? { p_starts_at: changes.startsAt } : {}),
    }),
  );
}
async function setStatus(id: string, status: string) {
  const row = await current(id);
  await ok(
    call(owner.client, "agenda_set_appointment_status", {
      p_business_id: business.id,
      p_appointment_id: id,
      p_expected_version: row.version,
      p_status: status,
    }),
  );
}

beforeAll(async () => {
  process.env.BOOKING_PROXY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_APP_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;

  owner = await createProfessional("history");
  await db.query(
    "update public.profiles set first_name = 'Nora', last_name = 'Belkacem' where id = $1",
    [owner.userId],
  );
  business = await createBusiness(owner.userId, {
    timezone: TZ,
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 60,
      maximum_booking_advance_days: 60,
    },
  });
  await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
  coupe = await createService(business.id, {
    name: "Coupe",
    durationMinutes: 60,
    priceCents: 4000,
  });
  couleur = await createService(business.id, {
    name: "Couleur",
    durationMinutes: 90,
    priceCents: 7000,
  });
  inesId = await createClientRecord(
    business.id,
    "ines.moreau@client.test",
    "Inès",
  );
  await db.query(
    "update public.clients set last_name = 'Moreau' where id = $1",
    [inesId],
  );
  mayaId = await createClientRecord(business.id, "maya@client.test", "Maya");
});

describe("point 100: who changed an appointment, and what", () => {
  it("her own changes, newest first, each with what changed", async () => {
    const day = localDate(5);
    const id = await create(day, "10:00", "Allergie au henné");
    await update(id, {
      startsAt: await instant(localDate(6), "14:30"),
      serviceId: couleur,
    });
    await update(id, { notes: "Préfère le matin" });
    await update(id, { clientId: mayaId });
    await setStatus(id, "cancelled");

    const { data, error } = await history(id);
    expect(error).toBeNull();
    expect(data.timeZone).toBe(TZ);
    expect(data.truncated).toBe(false);
    const entries = data.entries;
    expect(entries.map((e) => e.version)).toEqual([5, 4, 3, 2, 1]);
    for (const entry of entries) {
      expect(entry.actor).toEqual({
        kind: "member",
        name: expect.any(String),
        isYou: true,
      });
      expect(entry.backfilled).toBe(false);
    }

    expect(entries[0]!.changes).toEqual([
      { type: "status", from: "confirmed", to: "cancelled" },
    ]);
    expect(entries[1]!.changes).toEqual([
      expect.objectContaining({
        type: "client",
        fromName: "Inès Moreau",
        toName: "Maya",
      }),
    ]);
    expect(entries[2]!.changes).toEqual([{ type: "notes" }]);
    expect(entries[3]!.changes).toEqual([
      expect.objectContaining({
        type: "moved",
        from: expect.objectContaining({
          localStartsAt: `${day}T10:00`,
          localEndsAt: `${day}T11:00`,
        }),
        to: expect.objectContaining({
          localStartsAt: `${localDate(6)}T14:30`,
          localEndsAt: `${localDate(6)}T16:00`,
        }),
      }),
      { type: "service", from: "Coupe", to: "Couleur" },
      expect.objectContaining({
        type: "price",
        fromCents: 4000,
        toCents: 7000,
      }),
    ]);
    expect(entries[4]!.changes).toEqual([
      expect.objectContaining({
        type: "created",
        serviceName: "Coupe",
        status: "confirmed",
        localStartsAt: `${day}T10:00`,
        localEndsAt: `${day}T11:00`,
        inSeries: false,
      }),
    ]);
  });

  it("keeps neither the note's text nor her client's details", async () => {
    const id = await create(localDate(7), "11:00", "Code porte 4B12");
    await update(id, { notes: "Nouveau code 9Z77" });
    const { rows } = await db.query<{ stored: string }>(
      "select string_agg(changes::text || coalesce(actor_name, ''), ' ') as stored from private.appointment_changes where appointment_id = $1",
      [id],
    );
    for (const secret of ["4B12", "9Z77", "Moreau", "ines.moreau"]) {
      expect(rows[0]!.stored).not.toContain(secret);
    }
  });

  it("a write she cannot see in the agenda records nothing", async () => {
    const id = await create(localDate(8), "09:00");
    const before = (await history(id)).data.entries.length;
    await db.query(
      "update public.appointments set updated_at = now() where id = $1",
      [id],
    );
    // Saving the appointment as it is: no change.
    await update(id, {});
    expect((await history(id)).data.entries).toHaveLength(before);
  });

  it("an online booking is the client's; a database script is the system's", async () => {
    const day = localDate(9);
    const response = await postBooking(
      new NextRequest(new URL("/api/bookings", BASE), {
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          origin: BASE,
          "x-booking-proxy-secret": SECRET,
          "x-booking-client-ip": randomIp(),
        }),
        body: JSON.stringify({
          slug: business.slug,
          serviceId: coupe,
          startsAt: await instant(day, "15:00"),
          firstName: "Lou",
          email: `lou-${randomUUID().slice(0, 8)}@client.test`,
          requestId: randomUUID(),
        }),
      }),
    );
    expect(response.status).toBe(201);
    const id = (await response.json()).data.booking.appointmentId as string;

    await db.query(
      "update public.appointments set internal_notes = 'Import' where id = $1",
      [id],
    );
    const { entries } = (await history(id)).data;
    expect(entries.map((e) => [e.actor.kind, e.changes[0]!.type])).toEqual([
      ["system", "notes"],
      ["client", "created"],
    ]);
    expect(entries[1]!.actor).toEqual({
      kind: "client",
      name: null,
      isYou: false,
    });
  });

  it("a practitioner reads the history of her appointments only; a stranger nothing", async () => {
    const member = await ok<TeamMemberDto>(
      call(owner.client, "create_staff_member", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_display_name: "Léa",
        p_bookable: true,
        p_service_ids: [coupe, couleur],
      }),
    );
    const lea = await createProfessional("history-practitioner");
    const token = generateTeamInviteToken();
    await ok(
      call(owner.client, "send_team_invitation", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_staff_id: member.id,
        p_expected_revision: member.revision,
        p_email: lea.email,
        p_role: "practitioner",
        p_token_hash: hashTeamInviteToken(token),
      }),
    );
    await ok(
      call(lea.client, "accept_team_invitation", {
        p_token_hash: hashTeamInviteToken(token),
      }),
    );

    const hers = await create(localDate(10), "10:00");
    const other = await create(localDate(10), "13:00");
    await db.query(
      "update public.appointments set staff_id = $2 where id = $1",
      [hers, member.id],
    );

    const read = await history(hers, lea.client);
    expect(read.error).toBeNull();
    const [assigned, created] = read.data.entries;
    // Assigned by a database script here: the system; she is not "you".
    expect(assigned!.changes).toEqual([
      expect.objectContaining({ type: "staff", toName: "Léa" }),
    ]);
    expect(created!.actor).toMatchObject({ kind: "member", isYou: false });
    expect(created!.actor.name).toBeTruthy();

    expect((await history(other, lea.client)).error?.message).toBe(
      "appointment_not_found",
    );
    const stranger = await createProfessional("history-stranger");
    expect((await history(hers, stranger.client)).error?.message).toBe(
      "forbidden",
    );
    expect(
      (
        await call(owner.client, "appointment_history", {
          p_business_id: business.id,
          p_appointment_id: randomUUID(),
        })
      ).error?.message,
    ).toBe("appointment_not_found");
  });

  it("once her client is erased (point 205), nothing of the client remains in the history", async (context) => {
    const { rowCount } = await db.query(
      "select 1 from pg_proc where proname = 'privacy_erase_client'",
    );
    // Runs once the erasure (#129) is merged alongside.
    if (!rowCount) context.skip();

    const zoe = await createClientRecord(
      business.id,
      "zoe.martin@client.test",
      "Zoé",
    );
    await db.query(
      "update public.clients set last_name = 'Martin' where id = $1",
      [zoe],
    );
    const { rows } = await db.query<{ id: string }>(
      `insert into public.appointments (
         business_id, client_id, service_id, starts_at, ends_at, status,
         service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot,
         buffer_minutes_snapshot, internal_notes
       )
       values ($1, $2, $3, now() - interval '3 days',
               now() - interval '3 days' + interval '1 hour', 'completed',
               'Coupe', 60, 4000, 0, 'Code porte 1234')
       returning id`,
      [business.id, zoe, coupe],
    );
    const id = rows[0]!.id;
    const { rows: version } = await db.query<{ version: number }>(
      "select version from public.clients where id = $1",
      [zoe],
    );
    await ok(
      call(owner.client, "privacy_erase_client", {
        p_business_id: business.id,
        p_client_id: zoe,
        p_expected_version: version[0]!.version,
      }),
    );

    const [erased] = (await history(id)).data.entries;
    expect(erased).toMatchObject({
      actor: { kind: "member", isYou: true },
      changes: [{ type: "notes" }],
    });
    const stored = await db.query<{ text: string }>(
      "select string_agg(changes::text || coalesce(actor_name, ''), ' ') as text from private.appointment_changes where appointment_id = $1",
      [id],
    );
    for (const trace of ["Zoé", "Martin", "zoe.martin", "1234"]) {
      expect(stored.rows[0]!.text).not.toContain(trace);
    }
  });

  it("every function writing appointments is a known actor (new ones must be labelled)", async () => {
    // A signed-in member, or the service role (the client's own flows).
    // Adding a writer: check how its actor is labelled, then add it here.
    const { rows } = await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')
         and (p.prosrc ~* 'insert\\s+into\\s+public\\.appointments\\s*(\\(|as|$)'
           or p.prosrc ~* 'update\\s+public\\.appointments'
           or p.prosrc ~* 'delete\\s+from\\s+public\\.appointments')
       order by 1`,
    );
    // Every writer, with the actor its writes are labelled with.
    const known: Record<string, string> = {
      "private.create_public_booking_at": "client (service role)",
      "public.agenda_create_appointment": "member",
      "public.agenda_set_appointment_status": "member",
      "public.agenda_update_appointment": "member",
      "public.client_hub_cancel_appointment": "client (service role)",
      "public.client_hub_reschedule_appointment": "client (service role)",
      // Point 205 (#129): she erases her client; only contact snapshots
      // change, which records nothing (her note, if cleared, is hers).
      "public.privacy_erase_client": "member",
    };
    const writers = rows.map((r) => r.name);
    expect(writers.filter((name) => !(name in known))).toEqual([]);
    expect(writers).toEqual(
      expect.arrayContaining([
        "private.create_public_booking_at",
        "public.agenda_create_appointment",
        "public.agenda_set_appointment_status",
        "public.agenda_update_appointment",
        "public.client_hub_cancel_appointment",
        "public.client_hub_reschedule_appointment",
      ]),
    );
  });
});
