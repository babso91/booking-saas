import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

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
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// The practitioner role (docs/TEAM_CONTRACT.md, « Rôle praticienne »)
// through PostgREST with real sessions: what she reads directly from every
// sensitive table, what the functions let her do, and that the owner sees
// what she always saw.

type Rpc = { data: unknown; error: { message: string } | null };
const call = (client: AppSupabaseClient, fn: string, args: object) =>
  (client.rpc as unknown as (f: string, a: object) => Promise<Rpc>)(fn, args);
async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

let owner: Professional;
let business: TestBusiness;
let serviceId: string;
let alice: Professional; // practitioner
let bea: Professional; // another practitioner
let aliceStaff: string;
let beaStaff: string;
const clients: Record<string, string> = {};
const visits: Record<string, string> = {};

/** A profile, an invitation as practitioner, and her acceptance. */
async function practitioner(label: string) {
  const member = await ok<TeamMemberDto>(
    call(owner.client, "create_staff_member", {
      p_business_id: business.id,
      p_operation_id: randomUUID(),
      p_display_name: label,
      p_bookable: true,
      p_service_ids: [serviceId],
    }),
  );
  const person = await createProfessional(
    `caps-${label
      .normalize("NFD")
      .replace(/[^a-z]/gi, "")
      .toLowerCase()}`,
  );
  const token = generateTeamInviteToken();
  await ok(
    call(owner.client, "send_team_invitation", {
      p_business_id: business.id,
      p_operation_id: randomUUID(),
      p_staff_id: member.id,
      p_expected_revision: member.revision,
      p_email: person.email,
      p_role: "practitioner",
      p_token_hash: hashTeamInviteToken(token),
    }),
  );
  await ok(
    call(person.client, "accept_team_invitation", {
      p_token_hash: hashTeamInviteToken(token),
    }),
  );
  return { person, staffId: member.id };
}

function at(days: number, hour: number) {
  const start = new Date(Date.now() + days * 86_400_000);
  start.setUTCHours(hour, 0, 0, 0);
  return {
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
  };
}

async function visit(
  clientId: string,
  staffId: string,
  days: number,
  hour: number,
) {
  const id = await insertAppointment({
    businessId: business.id,
    clientId,
    serviceId,
    ...at(days, hour),
  });
  await db.query("update public.appointments set staff_id = $2 where id = $1", [
    id,
    staffId,
  ]);
  return id;
}

const rows = async (client: AppSupabaseClient, table: string) => {
  const { data, error } = await (
    client.from as unknown as (t: string) => {
      select: (
        c: string,
      ) => Promise<{ data: unknown[] | null; error: unknown }>;
    }
  )(table).select("*");
  expect(error, table).toBeNull();
  return data ?? [];
};

/** Rows she can read, or none when the table is not granted at all. */
const readable = async (client: AppSupabaseClient, table: string) => {
  const { data, error } = await (
    client.from as unknown as (t: string) => {
      select: (
        c: string,
      ) => Promise<{ data: unknown[] | null; error: { code: string } | null }>;
    }
  )(table).select("*");
  if (error?.code === "42501") return [];
  expect(error, table).toBeNull();
  return data ?? [];
};

beforeAll(async () => {
  owner = await createProfessional("caps-owner");
  business = await createBusiness(owner.userId);
  serviceId = await createService(business.id, { name: "Pose" });
  ({ person: alice, staffId: aliceStaff } = await practitioner("Alice"));
  ({ person: bea, staffId: beaStaff } = await practitioner("Béa"));

  for (const name of ["hers", "colleague", "nobody", "old"]) {
    clients[name] = await createClientRecord(
      business.id,
      `caps-${name}-${randomUUID().slice(0, 8)}@client.test`,
      name,
    );
  }
  visits.past = await visit(clients.hers!, aliceStaff, -1, 9);
  visits.future = await visit(clients.hers!, aliceStaff, 3, 10);
  visits.colleague = await visit(clients.colleague!, beaStaff, 3, 11);
  visits.old = await visit(clients.old!, aliceStaff, -400, 9);

  // Sensitive rows of the business: a private note, a loyalty entry, an email.
  await db.query(
    "insert into public.client_notes (business_id, client_id, content, created_by) values ($1, $2, 'Allergie au latex', $3)",
    [business.id, clients.hers, owner.userId],
  );
  await db.query(
    `insert into public.loyalty_events (business_id, client_id, type, points_delta, reason, idempotency_key)
     values ($1, $2, 'manual_adjustment', 10, 'Geste', $3)`,
    [business.id, clients.hers, `caps-${randomUUID()}`],
  );
});

describe("a practitioner reads", () => {
  it("her own appointments and the customers she receives, nothing else", async () => {
    const appointments = (await rows(alice.client, "appointments")) as {
      id: string;
    }[];
    expect(appointments.map((a) => a.id).sort()).toEqual(
      [visits.past, visits.future, visits.old].sort(),
    );
    // No customer row directly (private columns): her agenda names them.
    expect(await rows(alice.client, "clients")).toEqual([]);
    const agenda = await ok<{ id: string; client: Record<string, unknown> }[]>(
      call(alice.client, "practitioner_agenda", {
        p_business_id: business.id,
        p_from: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        p_to: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      }),
    );
    expect(agenda.map((a) => a.id)).toEqual([visits.past, visits.future]);
    expect(Object.keys(agenda[0]!.client).sort()).toEqual(
      ["email", "firstName", "id", "lastName", "phone"].sort(),
    );
    expect(
      (
        await call(owner.client, "practitioner_agenda", {
          p_business_id: business.id,
          p_from: new Date().toISOString(),
          p_to: new Date(Date.now() + 86_400_000).toISOString(),
        })
      ).error?.message,
    ).toBe("forbidden");

    // By local days, with the business's clock (business_time stays closed).
    type Days = {
      now: string;
      today: string;
      todayEndsAt: string;
      days: { date: string; startsAt: string; endsAt: string }[];
      visits: { id: string }[];
    };
    const week = await ok<Days>(
      call(alice.client, "practitioner_agenda_days", {
        p_business_id: business.id,
        p_from_date: null,
        p_days: 7,
      }),
    );
    expect(week.days).toHaveLength(7);
    expect(week.days[0]!.date).toBe(week.today);
    expect(new Date(week.now) < new Date(week.todayEndsAt)).toBe(true);
    expect(week.days[1]!.startsAt).toBe(week.days[0]!.endsAt);
    expect(week.visits.map((v) => v.id)).toEqual([visits.future]);
    const { rows: dayBounds } = await db.query(
      `select private.local_day_start($1::date, b.timezone) as lo
       from public.businesses b where b.id = $2`,
      [week.today, business.id],
    );
    expect(new Date(week.days[0]!.startsAt).getTime()).toBe(
      new Date(dayBounds[0].lo).getTime(),
    );
    for (const p_days of [0, 63]) {
      expect(
        (
          await call(alice.client, "practitioner_agenda_days", {
            p_business_id: business.id,
            p_from_date: null,
            p_days,
          })
        ).error?.message,
      ).toBe("invalid_input");
    }
    expect(
      (
        await call(owner.client, "practitioner_agenda_days", {
          p_business_id: business.id,
          p_from_date: null,
          p_days: 7,
        })
      ).error?.message,
    ).toBe("forbidden");
    expect((await rows(alice.client, "businesses")).length).toBe(1);
    expect((await rows(alice.client, "business_settings")).length).toBe(1);
    expect((await rows(alice.client, "services")).length).toBeGreaterThan(0);
    expect((await rows(alice.client, "staff_members")).length).toBe(3);
    const memberships = (await rows(alice.client, "business_members")) as {
      user_id: string;
      role: string;
    }[];
    expect(memberships).toEqual([
      expect.objectContaining({ user_id: alice.userId, role: "practitioner" }),
    ]);
  });

  it("no private note, loyalty, email, calendar, site, Hub access or rewards", async () => {
    for (const table of [
      "client_notes",
      "loyalty_events",
      "loyalty_programs",
      "loyalty_service_rules",
      "reward_redemptions",
      "rewards",
      "email_events",
      "email_delivery_attempts",
      "calendar_connections",
      "external_calendars",
      "external_calendar_events",
      "client_hub_access",
      "sites",
      "site_versions",
      "site_assets",
      "staff_services",
    ]) {
      expect(await readable(alice.client, table), table).toEqual([]);
    }
    // The owner still sees them.
    expect((await rows(owner.client, "client_notes")).length).toBe(1);
    expect((await rows(owner.client, "loyalty_events")).length).toBe(1);
    expect((await rows(owner.client, "appointments")).length).toBe(4);
    expect((await rows(owner.client, "clients")).length).toBe(4);
  });

  it("no professional function: team, CRM, catalog, agenda writes", async () => {
    for (const [fn, args] of [
      ["get_team", { p_business_id: business.id }],
      ["crm_list_clients", { p_business_id: business.id }],
      [
        "agenda_create_appointment",
        {
          p_business_id: business.id,
          p_client_id: clients.hers,
          p_service_id: serviceId,
          p_starts_at: at(5, 9).startsAt,
          p_request_id: randomUUID(),
        },
      ],
    ] as const) {
      const { error } = await call(alice.client, fn, args);
      expect(error, fn).not.toBeNull();
    }
    const { data } = await alice.client
      .from("services")
      .update({ name: "Piratée" })
      .eq("id", serviceId)
      .select();
    expect(data ?? []).toEqual([]);
    const inserted = await alice.client.from("clients").insert({
      business_id: business.id,
      first_name: "Intruse",
      email: `intruse-${randomUUID().slice(0, 6)}@client.test`,
    } as never);
    expect(inserted.error).not.toBeNull();
  });
});

describe("a practitioner acts", () => {
  it("records the outcome of her own visits only, never a cancellation", async () => {
    const status = async (who: Professional, id: string, value: string) => {
      const { rows: current } = await db.query(
        "select version from public.appointments where id = $1",
        [id],
      );
      return call(who.client, "agenda_set_appointment_status", {
        p_business_id: business.id,
        p_appointment_id: id,
        p_expected_version: current[0].version,
        p_status: value,
      });
    };
    expect((await status(alice, visits.past!, "completed")).error).toBeNull();
    expect(
      (await status(alice, visits.colleague!, "cancelled")).error?.message,
    ).toBe("forbidden");
    expect(
      (await status(alice, visits.future!, "cancelled")).error?.message,
    ).toBe("forbidden");
    // Her colleague's visit answers as if it did not exist.
    await db.query(
      "update public.appointments set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1",
      [visits.colleague],
    );
    expect(
      (await status(alice, visits.colleague!, "completed")).error?.message,
    ).toBe("appointment_not_found");
    expect(
      (await status(bea, visits.colleague!, "completed")).error,
    ).toBeNull();
  });

  it("loses everything once her access is withdrawn", async () => {
    const { rows: member } = await db.query(
      "select revision from public.staff_members where id = $1",
      [beaStaff],
    );
    await ok(
      call(owner.client, "revoke_team_access", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_staff_id: beaStaff,
        p_expected_revision: member[0].revision,
      }),
    );
    expect(await rows(bea.client, "appointments")).toEqual([]);
    expect(await rows(bea.client, "clients")).toEqual([]);
    expect(await rows(bea.client, "businesses")).toEqual([]);
  });
});
