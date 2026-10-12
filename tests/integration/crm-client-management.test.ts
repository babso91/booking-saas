import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createClientAction,
  getClientRecordAction,
  updateClientAction,
} from "@/features/crm/actions/client-management";
import {
  createClientNoteAction,
  deleteClientNoteAction,
  listClientNotesAction,
  updateClientNoteAction,
} from "@/features/crm/actions/client-notes";
import {
  getClientProfileAction,
  listClientsAction,
  listClientTimelineAction,
} from "@/features/crm/actions/crm";
import type { ClientNotesPageDto } from "@/features/crm/types";
import type { ActionResult, AppErrorCode } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import {
  anonClient,
  createBusiness,
  createProfessional,
  createService,
  db,
  env,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  type OpenTransaction,
} from "./support/transactions";

// CRM V1, customer management and private notes, through the real Server
// Actions, the user's Supabase session, PostgreSQL row level security and
// the SQL functions of 20261014090000. Arrangement and inspection only go
// through `db` (postgres).

let sessionClient: AppSupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

function as(professional: Professional | null) {
  sessionClient = professional ? professional.client : anonClient();
}

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function failure<T>(
  result: ActionResult<T>,
  code: AppErrorCode,
  field?: string,
) {
  expect(result).toMatchObject({ ok: false, error: { code } });
  if (field && !result.ok) {
    expect(Object.keys(result.error.fieldErrors ?? {})).toContain(field);
  }
}

const DAY = 86_400_000;

/** `days` from now (UTC), at 09:00 UTC. */
function at(days: number) {
  const date = new Date(Date.now() + days * DAY);
  date.setUTCHours(9, 0, 0, 0);
  return date.toISOString();
}
const plusHour = (iso: string) =>
  new Date(new Date(iso).getTime() + 3_600_000).toISOString();

async function clientRow(id: string) {
  const { rows } = await db.query(
    `select id, business_id, first_name, last_name, email::text as email, phone,
            internal_notes, version, created_at, updated_at
     from public.clients where id = $1`,
    [id],
  );
  return rows[0] as Record<string, unknown> | undefined;
}

async function countClients(businessId: string, where = "true") {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.clients c
     where c.business_id = $1 and ${where}`,
    [businessId],
  );
  return rows[0]!.n;
}

async function noteRow(id: string) {
  const { rows } = await db.query(
    "select * from public.client_notes where id = $1",
    [id],
  );
  return rows[0] as Record<string, unknown> | undefined;
}

let ownerA: Professional;
let ownerB: Professional;
let loner: Professional;
let A: TestBusiness;
let B: TestBusiness;
let coupe: string;

beforeAll(async () => {
  ownerA = await createProfessional("crm-manage-a");
  ownerB = await createProfessional("crm-manage-b");
  loner = await createProfessional("crm-manage-none");
  A = await createBusiness(ownerA.userId, { timezone: "Europe/Paris" });
  B = await createBusiness(ownerB.userId, { timezone: "America/Vancouver" });
  coupe = await createService(A.id, {
    name: "Coupe",
    durationMinutes: 60,
    priceCents: 4500,
  });
});

/** A new customer of A through the action, with a fresh request id. */
async function newCustomer(fields: {
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
}) {
  as(ownerA);
  return ok(await createClientAction({ ...fields, requestId: randomUUID() }))
    .client;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("creating a customer", () => {
  it("normalizes the contact (NFC, trim, canonical email) and is read by the CRM read model", async () => {
    as(ownerA);
    const created = ok(
      await createClientAction({
        firstName: "  Élodie ",
        lastName: " Martin ",
        email: "  Elodie.MARTIN@Example.com ",
        phone: " 06 12 34 56 78 ",
        requestId: randomUUID(),
      }),
    );
    expect(created.created).toBe(true);
    expect(created.client).toMatchObject({
      displayName: "Élodie Martin",
      firstName: "Élodie",
      lastName: "Martin",
      email: "elodie.martin@example.com",
      phone: "06 12 34 56 78",
      version: 1,
    });
    expect(await clientRow(created.client.id)).toMatchObject({
      business_id: A.id,
      first_name: "Élodie",
      email: "elodie.martin@example.com",
      internal_notes: null,
      version: 1,
    });

    const directory = ok(await listClientsAction({ query: "elodie.martin" }));
    expect(directory.clients).toMatchObject([
      {
        id: created.client.id,
        completedCount: 0,
        upcomingCount: 0,
        nextAppointment: null,
      },
    ]);
    const profile = ok(
      await getClientProfileAction({ clientId: created.client.id }),
    );
    expect(profile.client).toMatchObject({
      id: created.client.id,
      email: "elodie.martin@example.com",
    });
    const timeline = ok(
      await listClientTimelineAction({ clientId: created.client.id }),
    );
    expect(timeline).toMatchObject({ events: [], nextCursor: null });
    expect(
      ok(await getClientRecordAction({ clientId: created.client.id })),
    ).toEqual(created.client);
  });

  it("without email or phone: a new customer each time; a name or a phone is never an identity", async () => {
    const first = await newCustomer({ firstName: "Sam" });
    const second = await newCustomer({ firstName: "Sam" });
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ email: null, phone: null, lastName: null });

    const lea = await newCustomer({
      firstName: "Léa",
      lastName: "Perrin",
      email: "lea.perrin@example.com",
      phone: "0611223344",
    });
    // Same name and phone, another email: another customer, the first one
    // untouched.
    const homonym = await newCustomer({
      firstName: "Léa",
      lastName: "Perrin",
      email: "lea.p@example.com",
      phone: "0611223344",
    });
    const noEmail = await newCustomer({
      firstName: "Léa",
      lastName: "Perrin",
      phone: "0611223344",
    });
    expect(new Set([lea.id, homonym.id, noEmail.id]).size).toBe(3);
    expect(await clientRow(lea.id)).toMatchObject({
      email: "lea.perrin@example.com",
      version: 1,
    });
  });

  it("an email another customer of the business has: client_email_conflict naming it, nothing written or merged", async () => {
    const existing = await newCustomer({
      firstName: "Inès",
      email: "ines@example.com",
    });
    const before = await clientRow(existing.id);

    as(ownerA);
    for (const email of [
      "ines@example.com",
      "  INES@Example.COM ",
      "ines@example.com ",
    ]) {
      const result = await createClientAction({
        firstName: "Inès",
        lastName: "Dupont",
        email,
        phone: "0700000000",
        requestId: randomUUID(),
      });
      failure(result, "client_email_conflict", "email");
      expect(result.ok ? null : result.error.conflict).toEqual({
        clientId: existing.id,
        displayName: "Inès",
      });
    }
    // Never filled nor merged: the record is exactly as it was.
    expect(await clientRow(existing.id)).toEqual(before);
    expect(
      await countClients(
        A.id,
        "c.email = 'ines@example.com'::extensions.citext",
      ),
    ).toBe(1);
  });

  it("the same email in another business is another customer (identity is per business)", async () => {
    const inA = await newCustomer({
      firstName: "Nora",
      email: "nora@example.com",
    });
    as(ownerB);
    const inB = ok(
      await createClientAction({
        firstName: "Nora",
        email: "nora@example.com",
        requestId: randomUUID(),
      }),
    );
    expect(inB.created).toBe(true);
    expect(inB.client.id).not.toBe(inA.id);
    expect(await clientRow(inB.client.id)).toMatchObject({
      business_id: B.id,
    });
  });

  it("a retry or a double submission creates one customer", async () => {
    as(ownerA);
    const input = {
      firstName: "Zélie",
      phone: "0612345678",
      requestId: randomUUID(),
    };
    const first = ok(await createClientAction(input));
    const again = ok(await createClientAction(input));
    expect(first.created).toBe(true);
    expect(again).toEqual({ client: first.client, created: false });

    // A double submission, concurrent, without email.
    const doubled = { firstName: "Yasmine", requestId: randomUUID() };
    const results = (
      await Promise.all(
        Array.from({ length: 5 }, () => createClientAction(doubled)),
      )
    ).map(ok);
    expect(new Set(results.map((result) => result.client.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await countClients(A.id, "c.first_name = 'Yasmine'")).toBe(1);
  });

  it("a request id reused for another contact: idempotency_conflict, nothing written", async () => {
    as(ownerA);
    const requestId = randomUUID();
    ok(await createClientAction({ firstName: "Maëlle", requestId }));
    failure(
      await createClientAction({
        firstName: "Maëlle",
        lastName: "B",
        requestId,
      }),
      "idempotency_conflict",
      "requestId",
    );
    expect(await countClients(A.id, "c.first_name = 'Maëlle'")).toBe(1);
  });

  it("concurrent creations of one email: one customer, the others are conflicts naming it", async () => {
    as(ownerA);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createClientAction({
          firstName: `Rose ${index}`,
          email: "rose@example.com",
          requestId: randomUUID(),
        }),
      ),
    );
    const created = results.filter((result) => result.ok);
    expect(created).toHaveLength(1);
    const winner = ok(created[0]!).client;
    for (const result of results.filter((result) => !result.ok)) {
      failure(result, "client_email_conflict", "email");
      expect(result.ok ? null : result.error.conflict?.clientId).toBe(
        winner.id,
      );
    }
    expect(
      await countClients(
        A.id,
        "c.email = 'rose@example.com'::extensions.citext",
      ),
    ).toBe(1);
  });

  it("malformed or unbounded input: validation_error on the field, nothing written", async () => {
    as(ownerA);
    const before = await countClients(A.id);
    const valid = { firstName: "Valide", requestId: randomUUID() };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...valid, firstName: "   " }, "firstName"],
      [{ ...valid, firstName: "x".repeat(121) }, "firstName"],
      [{ ...valid, lastName: "x".repeat(121) }, "lastName"],
      [{ ...valid, email: "pas-un-email" }, "email"],
      [{ ...valid, email: `${"x".repeat(250)}@example.com` }, "email"],
      [{ ...valid, phone: "appelle-moi" }, "phone"],
      [{ ...valid, phone: "+33 6 12 34 56 78 90 12 34 56 78 90" }, "phone"],
      [{ ...valid, requestId: "pas-un-uuid" }, "requestId"],
      [{ firstName: "Sans clé" }, "requestId"],
      [{ ...valid, firstName: 42 }, "firstName"],
    ];
    for (const [input, field] of cases) {
      failure(await createClientAction(input), "validation_error", field);
    }
    failure(await createClientAction(null), "validation_error");
    expect(await countClients(A.id)).toBe(before);

    // The database applies the same rules to a direct call.
    const { error } = await ownerA.client.rpc("crm_create_client", {
      p_business_id: A.id,
      p_first_name: "Directe",
      p_email: "a b@example.com",
      p_request_id: randomUUID(),
    });
    expect(error).toMatchObject({ message: "invalid_input", hint: "email" });
    expect(await countClients(A.id)).toBe(before);
  });

  it("anonymous, business-less and other-business callers are refused", async () => {
    as(null);
    failure(
      await createClientAction({
        firstName: "Anonyme",
        requestId: randomUUID(),
      }),
      "unauthenticated",
    );
    as(loner);
    failure(
      await createClientAction({ firstName: "Seule", requestId: randomUUID() }),
      "no_business",
    );

    // Directly through the API: never anonymous, never into another business.
    const anonymous = await anonClient().rpc("crm_create_client", {
      p_business_id: A.id,
      p_first_name: "Anonyme",
      p_request_id: randomUUID(),
    });
    expect(anonymous.error?.code).toBe("42501");
    const intruder = await ownerB.client.rpc("crm_create_client", {
      p_business_id: A.id,
      p_first_name: "Intruse",
      p_request_id: randomUUID(),
    });
    expect(intruder.error).toMatchObject({
      code: "42501",
      message: "forbidden",
    });
    expect(
      await countClients(
        A.id,
        "c.first_name in ('Anonyme', 'Seule', 'Intruse')",
      ),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edition
// ---------------------------------------------------------------------------

describe("editing a customer", () => {
  it("replaces identity and contact on the version read; the read model follows", async () => {
    const record = await newCustomer({
      firstName: "Clara",
      lastName: "Petit",
      email: "clara@example.com",
      phone: "0601010101",
    });
    as(ownerA);
    const updated = ok(
      await updateClientAction({
        clientId: record.id,
        expectedVersion: 1,
        firstName: " Clara ",
        lastName: "Petit-Leroy",
        email: " Clara.Leroy@Example.com",
        phone: "0602020202",
      }),
    );
    expect(updated).toMatchObject({
      changed: true,
      client: {
        id: record.id,
        displayName: "Clara Petit-Leroy",
        email: "clara.leroy@example.com",
        phone: "0602020202",
        version: 2,
      },
      retained: {
        upcomingAppointmentsWithOtherEmail: 0,
        queuedEmailsToOtherAddress: 0,
      },
    });
    const profile = ok(await getClientProfileAction({ clientId: record.id }));
    expect(profile.client).toMatchObject({
      lastName: "Petit-Leroy",
      email: "clara.leroy@example.com",
    });
    expect(
      ok(await listClientsAction({ query: "clara.leroy" })).clients.map(
        (client) => client.id,
      ),
    ).toEqual([record.id]);

    // Optional fields removed: absent, null or empty.
    const cleared = ok(
      await updateClientAction({
        clientId: record.id,
        expectedVersion: 2,
        firstName: "Clara",
        email: null,
        phone: "",
      }),
    );
    expect(cleared.client).toMatchObject({
      lastName: null,
      email: null,
      phone: null,
      version: 3,
    });
  });

  it("a stale version is refused; a retried edit (same values) succeeds without writing", async () => {
    const record = await newCustomer({ firstName: "Iris" });
    as(ownerA);
    const edit = {
      clientId: record.id,
      expectedVersion: 1,
      firstName: "Iris",
      lastName: "Moreau",
    };
    expect(ok(await updateClientAction(edit)).client.version).toBe(2);

    // The same edit again (a double submission): already done.
    const retried = ok(await updateClientAction(edit));
    expect(retried).toMatchObject({ changed: false, client: { version: 2 } });

    // Another edit based on version 1: stale.
    failure(
      await updateClientAction({ ...edit, lastName: "Bernard" }),
      "stale_client",
      "expectedVersion",
    );
    expect(await clientRow(record.id)).toMatchObject({
      last_name: "Moreau",
      version: 2,
    });

    // Any write of the record makes an earlier version stale (a booking
    // filling the phone, a direct write).
    await db.query(
      "update public.clients set phone = '0611111111' where id = $1",
      [record.id],
    );
    failure(
      await updateClientAction({
        ...edit,
        expectedVersion: 2,
        lastName: "Roux",
      }),
      "stale_client",
    );
  });

  it("concurrent edits based on one version: one is written, the other is stale", async () => {
    const record = await newCustomer({ firstName: "Lou" });
    as(ownerA);
    const results = await Promise.all(
      ["Martin", "Durand"].map((lastName) =>
        updateClientAction({
          clientId: record.id,
          expectedVersion: 1,
          firstName: "Lou",
          lastName,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    failure(
      results.find((result) => !result.ok)!,
      "stale_client",
    );
    expect(await clientRow(record.id)).toMatchObject({ version: 2 });
  });

  it("an email another customer has: client_email_conflict naming it, the record unchanged", async () => {
    const owner = await newCustomer({
      firstName: "Jade",
      lastName: "Lambert",
      email: "jade@example.com",
    });
    const record = await newCustomer({
      firstName: "Julie",
      email: "julie@example.com",
    });
    const before = await clientRow(record.id);
    as(ownerA);
    const result = await updateClientAction({
      clientId: record.id,
      expectedVersion: 1,
      firstName: "Julie",
      email: "JADE@example.com ",
    });
    failure(result, "client_email_conflict", "email");
    expect(result.ok ? null : result.error.conflict).toEqual({
      clientId: owner.id,
      displayName: "Jade Lambert",
    });
    expect(await clientRow(record.id)).toEqual(before);
    expect(await clientRow(owner.id)).toMatchObject({ version: 1 });
  });

  it("history keeps the contact it was made with: appointment snapshots, queued emails, timeline", async () => {
    const record = await newCustomer({
      firstName: "Anna",
      lastName: "Roy",
      email: "anna@example.com",
      phone: "0603030303",
    });
    const past = await insertAppointment({
      businessId: A.id,
      clientId: record.id,
      serviceId: coupe,
      startsAt: at(-10),
      endsAt: plusHour(at(-10)),
      status: "completed",
    });
    const upcoming = await insertAppointment({
      businessId: A.id,
      clientId: record.id,
      serviceId: coupe,
      startsAt: at(10),
      endsAt: plusHour(at(10)),
    });
    await db.query(
      `insert into public.email_events
         (business_id, client_id, appointment_id, type, recipient_email, dedupe_key)
       values ($1, $2, $3, 'booking_confirmation', 'anna@example.com', $4)`,
      [A.id, record.id, upcoming, `crm-manage-${upcoming}`],
    );
    const snapshots = async () =>
      (
        await db.query(
          `select id, client_first_name_snapshot, client_last_name_snapshot,
                  client_email_snapshot, client_phone_snapshot, version
           from public.appointments where client_id = $1 order by starts_at`,
          [record.id],
        )
      ).rows;
    const snapshotsBefore = await snapshots();
    expect(snapshotsBefore[0]).toMatchObject({
      client_first_name_snapshot: "Anna",
      client_email_snapshot: "anna@example.com",
    });

    as(ownerA);
    const updated = ok(
      await updateClientAction({
        clientId: record.id,
        expectedVersion: 1,
        firstName: "Annabelle",
        lastName: "Roy",
        email: "annabelle@example.com",
        phone: "0604040404",
      }),
    );
    expect(updated.retained).toEqual({
      upcomingAppointmentsWithOtherEmail: 1,
      queuedEmailsToOtherAddress: 1,
    });

    // Appointments keep their snapshot (and their version); the queued email
    // keeps its recipient.
    expect(await snapshots()).toEqual(snapshotsBefore);
    const { rows: emails } = await db.query(
      "select recipient_email::text as recipient from public.email_events where client_id = $1",
      [record.id],
    );
    expect(emails).toEqual([{ recipient: "anna@example.com" }]);

    // The read model: current record in the profile, the contact at the
    // time in the timeline.
    const profile = ok(await getClientProfileAction({ clientId: record.id }));
    expect(profile.client).toMatchObject({
      firstName: "Annabelle",
      email: "annabelle@example.com",
    });
    const timeline = ok(
      await listClientTimelineAction({ clientId: record.id }),
    );
    const event = timeline.events.find(
      (item) => item.id === `appointment:${past}`,
    );
    expect(event).toMatchObject({
      kind: "appointment",
      appointment: {
        contact: {
          firstName: "Anna",
          email: "anna@example.com",
          phone: "0603030303",
        },
      },
    });
  });

  it("the legacy free-text notes of the record are never changed", async () => {
    const record = await newCustomer({ firstName: "Lina" });
    await db.query(
      "update public.clients set internal_notes = $2 where id = $1",
      [record.id, "Ancienne note\n\nAutre note"],
    );
    const { version } = (await clientRow(record.id)) as { version: number };
    as(ownerA);
    ok(
      await updateClientAction({
        clientId: record.id,
        expectedVersion: version,
        firstName: "Lina",
        email: "lina@example.com",
      }),
    );
    expect(await clientRow(record.id)).toMatchObject({
      internal_notes: "Ancienne note\n\nAutre note",
    });
  });

  it("Google Calendar: mirrors become due when the first name (the event title) changes, only then", async () => {
    const record = await newCustomer({ firstName: "Mila" });
    const appointment = await insertAppointment({
      businessId: A.id,
      clientId: record.id,
      serviceId: coupe,
      startsAt: at(20),
      endsAt: plusHour(at(20)),
    });
    await db.query(
      `insert into private.appointment_calendar_mirrors (appointment_id, business_id, event_id)
       values ($1, $2, $3)`,
      [appointment, A.id, `crmmanage${appointment.replaceAll("-", "")}`],
    );
    const revision = async () =>
      Number(
        (
          await db.query(
            "select desired_revision from private.appointment_calendar_mirrors where appointment_id = $1",
            [appointment],
          )
        ).rows[0].desired_revision,
      );
    const start = await revision();

    as(ownerA);
    ok(
      await updateClientAction({
        clientId: record.id,
        expectedVersion: 1,
        firstName: "Mila",
        lastName: "Garnier",
        email: "mila@example.com",
        phone: "0605050505",
      }),
    );
    expect(await revision()).toBe(start);

    ok(
      await updateClientAction({
        clientId: record.id,
        expectedVersion: 2,
        firstName: "Milana",
        lastName: "Garnier",
        email: "mila@example.com",
        phone: "0605050505",
      }),
    );
    expect(await revision()).toBe(start + 1);
  });

  it("another business's customer: not found, untouched; malformed identifiers: validation_error", async () => {
    const record = await newCustomer({
      firstName: "Eva",
      email: "eva@example.com",
    });
    const before = await clientRow(record.id);

    as(ownerB);
    failure(
      await getClientRecordAction({ clientId: record.id }),
      "client_not_found",
    );
    failure(
      await updateClientAction({
        clientId: record.id,
        expectedVersion: 1,
        firstName: "Volée",
      }),
      "client_not_found",
    );
    const direct = await ownerB.client.rpc("crm_update_client", {
      p_business_id: A.id,
      p_client_id: record.id,
      p_expected_version: 1,
      p_first_name: "Volée",
    });
    expect(direct.error).toMatchObject({ code: "42501", message: "forbidden" });
    expect(await clientRow(record.id)).toEqual(before);

    as(ownerA);
    failure(
      await updateClientAction({
        clientId: randomUUID(),
        expectedVersion: 1,
        firstName: "Personne",
      }),
      "client_not_found",
    );
    for (const input of [
      { clientId: "pas-un-uuid", expectedVersion: 1, firstName: "X" },
      { clientId: record.id, expectedVersion: 0, firstName: "X" },
      { clientId: record.id, expectedVersion: 1.5, firstName: "X" },
      { clientId: record.id, expectedVersion: "1", firstName: "X" },
      { clientId: record.id, firstName: "X" },
      { clientId: record.id, expectedVersion: 1, firstName: "" },
    ]) {
      failure(await updateClientAction(input), "validation_error");
    }
    failure(await getClientRecordAction({ clientId: "1" }), "validation_error");
    expect(await clientRow(record.id)).toEqual(before);

    as(null);
    failure(
      await updateClientAction({
        clientId: record.id,
        expectedVersion: 1,
        firstName: "X",
      }),
      "unauthenticated",
    );
  });
});

// ---------------------------------------------------------------------------
// Private notes
// ---------------------------------------------------------------------------

describe("private notes", () => {
  it("write, read, edit and delete; dates, authorship and versions come from the database", async () => {
    const record = await newCustomer({ firstName: "Chloé" });
    as(ownerA);
    const written = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "  Allergie au latex.\n  Préfère le matin.  ",
        requestId: randomUUID(),
      }),
    );
    expect(written).toMatchObject({
      created: true,
      note: {
        clientId: record.id,
        content: "Allergie au latex.\n  Préfère le matin.",
        version: 1,
        edited: false,
        createdBy: ownerA.userId,
        updatedBy: null,
      },
    });
    expect(written.note.createdAt.local).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
    expect(written.note.updatedAt).toEqual(written.note.createdAt);

    const page = ok(await listClientNotesAction({ clientId: record.id }));
    expect(page).toMatchObject({
      timezone: "Europe/Paris",
      legacyNotes: null,
      notes: [written.note],
      nextCursor: null,
    });

    const edited = ok(
      await updateClientNoteAction({
        clientId: record.id,
        noteId: written.note.id,
        expectedVersion: 1,
        content: "Allergie au latex et à la colle.",
      }),
    );
    expect(edited).toMatchObject({
      changed: true,
      note: {
        id: written.note.id,
        content: "Allergie au latex et à la colle.",
        version: 2,
        edited: true,
        createdBy: ownerA.userId,
        updatedBy: ownerA.userId,
        createdAt: written.note.createdAt,
      },
    });
    expect(new Date(edited.note.updatedAt.at).getTime()).toBeGreaterThan(
      new Date(written.note.createdAt.at).getTime(),
    );

    expect(
      ok(
        await deleteClientNoteAction({
          clientId: record.id,
          noteId: written.note.id,
          expectedVersion: 2,
        }),
      ),
    ).toEqual({ noteId: written.note.id, deleted: true });
    expect(await noteRow(written.note.id)).toBeUndefined();
    expect(
      ok(await listClientNotesAction({ clientId: record.id })).notes,
    ).toEqual([]);
  });

  it("newest first, keyset pages without duplicate or skip, ties included", async () => {
    const record = await newCustomer({ firstName: "Paula" });
    as(ownerA);
    const written: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      written.push(
        ok(
          await createClientNoteAction({
            clientId: record.id,
            content: `Note ${index}`,
            requestId: randomUUID(),
          }),
        ).note.id,
      );
    }
    // Two notes of one instant (one transaction): ordered by id.
    const { rows: tied } = await db.query<{ id: string }>(
      `insert into public.client_notes (business_id, client_id, content)
       values ($1, $2, 'Même instant A'), ($1, $2, 'Même instant B')
       returning id`,
      [A.id, record.id],
    );
    const expected = [
      ...tied
        .map((row) => row.id)
        .sort()
        .reverse(),
      ...[...written].reverse(),
    ];

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const page: ClientNotesPageDto = ok(
        await listClientNotesAction({ clientId: record.id, limit: 3, cursor }),
      );
      pages.push(page.notes.map((note) => note.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages.map((page) => page.length)).toEqual([3, 3, 3]);
    expect(pages.flat()).toEqual(expected);

    // A note written while paginating is newer than every page: it only
    // appears from the first page again.
    const first = ok(
      await listClientNotesAction({ clientId: record.id, limit: 3 }),
    );
    const fresh = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "Plus récente",
        requestId: randomUUID(),
      }),
    ).note.id;
    const second = ok(
      await listClientNotesAction({
        clientId: record.id,
        limit: 3,
        cursor: first.nextCursor,
      }),
    );
    expect(second.notes.map((note) => note.id)).toEqual(expected.slice(3, 6));
    expect(
      ok(await listClientNotesAction({ clientId: record.id, limit: 1 }))
        .notes[0]?.id,
    ).toBe(fresh);
  });

  it("a retry or a double submission writes one note; a reused key is idempotency_conflict", async () => {
    const record = await newCustomer({ firstName: "Rita" });
    const other = await newCustomer({ firstName: "Sonia" });
    as(ownerA);
    const input = {
      clientId: record.id,
      content: "Rappeler pour la couleur.",
      requestId: randomUUID(),
    };
    const first = ok(await createClientNoteAction(input));
    const again = ok(await createClientNoteAction(input));
    expect(again).toEqual({ note: first.note, created: false });

    const doubled = { ...input, requestId: randomUUID(), content: "Doublon" };
    const results = (
      await Promise.all(
        Array.from({ length: 5 }, () => createClientNoteAction(doubled)),
      )
    ).map(ok);
    expect(new Set(results.map((result) => result.note.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);

    failure(
      await createClientNoteAction({ ...input, content: "Autre texte" }),
      "idempotency_conflict",
      "requestId",
    );
    failure(
      await createClientNoteAction({ ...input, clientId: other.id }),
      "idempotency_conflict",
    );
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.client_notes where client_id = any($1)",
      [[record.id, other.id]],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("concurrent edits of one version: one is written, the other is stale; a retried edit is unchanged", async () => {
    const record = await newCustomer({ firstName: "Tess" });
    as(ownerA);
    const note = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "Première version",
        requestId: randomUUID(),
      }),
    ).note;
    const edits = ["Version A", "Version B"].map((content) => ({
      clientId: record.id,
      noteId: note.id,
      expectedVersion: 1,
      content,
    }));
    const results = await Promise.all(edits.map(updateClientNoteAction));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    failure(
      results.find((result) => !result.ok)!,
      "stale_note",
      "expectedVersion",
    );

    const winner = edits[results.findIndex((result) => result.ok)]!;
    const retried = ok(await updateClientNoteAction(winner));
    expect(retried).toMatchObject({
      changed: false,
      note: { version: 2, content: winner.content },
    });
  });

  it("deletion is guarded by the version read, and deleting again does nothing", async () => {
    const record = await newCustomer({ firstName: "Una" });
    as(ownerA);
    const note = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "À supprimer",
        requestId: randomUUID(),
      }),
    ).note;
    ok(
      await updateClientNoteAction({
        clientId: record.id,
        noteId: note.id,
        expectedVersion: 1,
        content: "Modifiée entre-temps",
      }),
    );
    const removal = {
      clientId: record.id,
      noteId: note.id,
      expectedVersion: 1,
    };
    failure(await deleteClientNoteAction(removal), "stale_note");
    expect(await noteRow(note.id)).toBeDefined();

    const current = { ...removal, expectedVersion: 2 };
    expect(ok(await deleteClientNoteAction(current)).deleted).toBe(true);
    expect(ok(await deleteClientNoteAction(current)).deleted).toBe(false);
    failure(
      await updateClientNoteAction({ ...current, content: "Trop tard" }),
      "note_not_found",
      "noteId",
    );
  });

  it("a note stays with its customer: addressed through another customer, it is not found and untouched", async () => {
    const record = await newCustomer({ firstName: "Vera" });
    const other = await newCustomer({ firstName: "Wanda" });
    as(ownerA);
    const note = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "Note de Vera",
        requestId: randomUUID(),
      }),
    ).note;
    const before = await noteRow(note.id);

    failure(
      await updateClientNoteAction({
        clientId: other.id,
        noteId: note.id,
        expectedVersion: 1,
        content: "Détournée",
      }),
      "note_not_found",
    );
    expect(
      ok(
        await deleteClientNoteAction({
          clientId: other.id,
          noteId: note.id,
          expectedVersion: 1,
        }),
      ).deleted,
    ).toBe(false);
    expect(
      ok(await listClientNotesAction({ clientId: other.id })).notes,
    ).toEqual([]);
    expect(await noteRow(note.id)).toEqual(before);

    // Even a member's direct write cannot move it, re-date it or re-sign
    // it: members may update the content only (column privilege).
    for (const change of [
      { client_id: other.id },
      { created_at: "2020-01-01T00:00:00Z" },
      { created_by: ownerB.userId },
    ]) {
      const { error } = await ownerA.client
        .from("client_notes")
        .update(change)
        .eq("id", note.id);
      expect(error?.code).toBe("42501");
    }
    expect(await noteRow(note.id)).toEqual(before);
  });

  it("another business: never read, written, edited or deleted, through the actions or the API", async () => {
    const record = await newCustomer({ firstName: "Xena" });
    as(ownerA);
    const note = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "Confidentiel",
        requestId: randomUUID(),
      }),
    ).note;
    const before = await noteRow(note.id);

    as(ownerB);
    failure(
      await listClientNotesAction({ clientId: record.id }),
      "client_not_found",
    );
    failure(
      await createClientNoteAction({
        clientId: record.id,
        content: "Intrusion",
        requestId: randomUUID(),
      }),
      "client_not_found",
    );
    failure(
      await updateClientNoteAction({
        clientId: record.id,
        noteId: note.id,
        expectedVersion: 1,
        content: "Intrusion",
      }),
      "note_not_found",
    );
    expect(
      ok(
        await deleteClientNoteAction({
          clientId: record.id,
          noteId: note.id,
          expectedVersion: 1,
        }),
      ).deleted,
    ).toBe(false);

    // The table through the API, as B: invisible, unwritable.
    const read = await ownerB.client
      .from("client_notes")
      .select("*")
      .eq("id", note.id);
    expect(read.data).toEqual([]);
    const intoA = await ownerB.client.from("client_notes").insert({
      business_id: A.id,
      client_id: record.id,
      content: "Intrusion",
    });
    expect(intoA.error?.code).toBe("42501");
    const throughB = await ownerB.client.from("client_notes").insert({
      business_id: B.id,
      client_id: record.id,
      content: "Intrusion",
    });
    expect(throughB.error?.code).toBe("23503");
    const edit = await ownerB.client
      .from("client_notes")
      .update({ content: "Intrusion" })
      .eq("id", note.id)
      .select();
    expect(edit.data).toEqual([]);
    const removal = await ownerB.client
      .from("client_notes")
      .delete()
      .eq("id", note.id)
      .select();
    expect(removal.data).toEqual([]);
    for (const call of [
      ownerB.client.rpc("crm_list_client_notes", {
        p_business_id: A.id,
        p_client_id: record.id,
      }),
      ownerB.client.rpc("crm_create_client_note", {
        p_business_id: A.id,
        p_client_id: record.id,
        p_content: "Intrusion",
        p_request_id: randomUUID(),
      }),
      ownerB.client.rpc("crm_delete_client_note", {
        p_business_id: A.id,
        p_client_id: record.id,
        p_note_id: note.id,
        p_expected_version: 1,
      }),
    ]) {
      expect((await call).error).toMatchObject({
        code: "42501",
        message: "forbidden",
      });
    }

    expect(await noteRow(note.id)).toEqual(before);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.client_notes where client_id = $1",
      [record.id],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("anonymous callers and public booking never reach notes", async () => {
    const record = await newCustomer({ firstName: "Yael" });
    as(ownerA);
    ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "Privée",
        requestId: randomUUID(),
      }),
    );

    as(null);
    failure(
      await listClientNotesAction({ clientId: record.id }),
      "unauthenticated",
    );
    failure(
      await createClientNoteAction({
        clientId: record.id,
        content: "Anonyme",
        requestId: randomUUID(),
      }),
      "unauthenticated",
    );
    const anonymous = anonClient();
    expect((await anonymous.from("client_notes").select("*")).error?.code).toBe(
      "42501",
    );
    expect(
      (
        await anonymous.rpc("crm_list_client_notes", {
          p_business_id: A.id,
          p_client_id: record.id,
        })
      ).error?.code,
    ).toBe("42501");

    // No function but the CRM notes functions and the relationship timeline
    // reads the table: the public booking functions (the only ones anonymous
    // callers may run) never do.
    const { rows } = await db.query<{ name: string; anon: boolean }>(
      `select p.pronamespace::regnamespace || '.' || p.proname as name,
              has_function_privilege('anon', p.oid, 'execute') as anon
       from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and strpos(p.prosrc, 'client_notes') > 0
       order by 1`,
    );
    expect(rows).toEqual([
      { name: "public.crm_client_timeline", anon: false },
      { name: "public.crm_create_client_note", anon: false },
      { name: "public.crm_delete_client_note", anon: false },
      { name: "public.crm_list_client_notes", anon: false },
      { name: "public.crm_update_client_note", anon: false },
    ]);
  });

  it("malformed input: validation_error before any read or write", async () => {
    const record = await newCustomer({ firstName: "Zoé" });
    as(ownerA);
    const valid = {
      clientId: record.id,
      content: "OK",
      requestId: randomUUID(),
    };
    for (const [input, field] of [
      [{ ...valid, content: " \n\t " }, "content"],
      [{ ...valid, content: "x".repeat(5001) }, "content"],
      [{ ...valid, content: 12 }, "content"],
      [{ ...valid, clientId: "pas-un-uuid" }, "clientId"],
      [{ ...valid, requestId: undefined }, "requestId"],
    ] as const) {
      failure(await createClientNoteAction(input), "validation_error", field);
    }
    for (const input of [
      { clientId: record.id, noteId: "x", expectedVersion: 1, content: "A" },
      {
        clientId: record.id,
        noteId: randomUUID(),
        expectedVersion: 0,
        content: "A",
      },
      { clientId: record.id, noteId: randomUUID(), content: "A" },
    ]) {
      failure(await updateClientNoteAction(input), "validation_error");
    }
    failure(
      await deleteClientNoteAction({
        clientId: record.id,
        noteId: "x",
        expectedVersion: 1,
      }),
      "validation_error",
    );
    for (const cursor of ["%%%", "e30", "x".repeat(2000)]) {
      failure(
        await listClientNotesAction({ clientId: record.id, cursor }),
        "validation_error",
      );
    }
    failure(
      await listClientNotesAction({ clientId: record.id, limit: 101 }),
      "validation_error",
    );
    failure(
      await updateClientNoteAction({
        clientId: record.id,
        noteId: randomUUID(),
        expectedVersion: 1,
        content: "Inconnue",
      }),
      "note_not_found",
    );
    failure(
      await createClientNoteAction({ ...valid, clientId: randomUUID() }),
      "client_not_found",
    );
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.client_notes where client_id = $1",
      [record.id],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("a cursor of another customer's notes is refused", async () => {
    const record = await newCustomer({ firstName: "Adèle" });
    const other = await newCustomer({ firstName: "Brune" });
    as(ownerA);
    for (const content of ["Un", "Deux"]) {
      ok(
        await createClientNoteAction({
          clientId: record.id,
          content,
          requestId: randomUUID(),
        }),
      );
    }
    const page = ok(
      await listClientNotesAction({ clientId: record.id, limit: 1 }),
    );
    expect(page.nextCursor).not.toBeNull();
    failure(
      await listClientNotesAction({
        clientId: other.id,
        cursor: page.nextCursor,
      }),
      "validation_error",
      "cursor",
    );
  });

  it("legacy free-text notes: returned read only, never changed by notes", async () => {
    const record = await newCustomer({ firstName: "Céleste" });
    await db.query(
      "update public.clients set internal_notes = $2 where id = $1",
      [record.id, "Note historique\nsur deux lignes"],
    );
    as(ownerA);
    const note = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "Nouvelle note datée",
        requestId: randomUUID(),
      }),
    ).note;
    ok(
      await updateClientNoteAction({
        clientId: record.id,
        noteId: note.id,
        expectedVersion: 1,
        content: "Note datée modifiée",
      }),
    );
    ok(
      await deleteClientNoteAction({
        clientId: record.id,
        noteId: note.id,
        expectedVersion: 2,
      }),
    );
    expect(
      ok(await listClientNotesAction({ clientId: record.id })).legacyNotes,
    ).toBe("Note historique\nsur deux lignes");
    expect(await clientRow(record.id)).toMatchObject({
      internal_notes: "Note historique\nsur deux lignes",
    });

    await db.query(
      "update public.clients set internal_notes = '  ' where id = $1",
      [record.id],
    );
    expect(
      ok(await listClientNotesAction({ clientId: record.id })).legacyNotes,
    ).toBeNull();
  });

  it("a note joins the relationship timeline at its date; the other events are unchanged", async () => {
    const record = await newCustomer({ firstName: "Daphné" });
    await insertAppointment({
      businessId: A.id,
      clientId: record.id,
      serviceId: coupe,
      startsAt: at(-3),
      endsAt: plusHour(at(-3)),
      status: "completed",
    });
    as(ownerA);
    const before = ok(await listClientTimelineAction({ clientId: record.id }));
    const note = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "Dans la timeline",
        requestId: randomUUID(),
      }),
    ).note;
    const after = ok(await listClientTimelineAction({ clientId: record.id }));
    expect(after.events.slice(1)).toEqual(before.events);
    expect(after.events[0]).toEqual({
      id: `note:${note.id}`,
      kind: "note",
      occurredAt: note.createdAt,
      note,
    });
  });
});

// ---------------------------------------------------------------------------
// Deterministic interleavings: a first call holds its write uncommitted, the
// action waits for it, then the first call commits
// ---------------------------------------------------------------------------

/** Resolves once another backend running `call` waits on a lock. */
async function waitForBlockedCall(call: string, except: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await db.query(
      `select 1 from pg_stat_activity
       where wait_event_type = 'Lock' and pid <> $2
         and strpos(query, $1) > 0`,
      [call, except],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${call} never waited for the first transaction`);
}

/** As ownerA, in a transaction left open. */
async function firstCall<T>(sql: string, params: unknown[]) {
  const transaction = await openTransaction({
    role: "authenticated",
    userId: ownerA.userId,
  });
  const { rows } = await transaction.connection.query(sql, params);
  return { transaction, row: rows[0] as T };
}

async function interleave<T>(
  first: OpenTransaction,
  call: string,
  second: () => Promise<T>,
): Promise<T> {
  try {
    const pending = second();
    await waitForBlockedCall(call, first.pid);
    await closeTransaction(first, "commit");
    return await pending;
  } catch (error) {
    await closeTransaction(first, "rollback").catch(() => undefined);
    throw error;
  }
}

describe("concurrent writes, interleaved deterministically", () => {
  it("a submission racing the same request waits for it and answers with its customer", async () => {
    const requestId = randomUUID();
    const { transaction, row } = await firstCall<{
      status: string;
      client_id: string;
    }>(
      "select * from public.crm_create_client($1, 'Gaëlle', null, null, null, $2)",
      [A.id, requestId],
    );
    expect(row.status).toBe("created");
    as(ownerA);
    const result = ok(
      await interleave(transaction, "crm_create_client", () =>
        createClientAction({ firstName: "Gaëlle", requestId }),
      ),
    );
    expect(result).toMatchObject({
      created: false,
      client: { id: row.client_id },
    });
    expect(await countClients(A.id, "c.first_name = 'Gaëlle'")).toBe(1);
  });

  it("a creation racing another of the same email waits, then names that customer", async () => {
    const { transaction, row } = await firstCall<{ client_id: string }>(
      "select * from public.crm_create_client($1, 'Hélène', 'Roux', 'helene@example.com', null, $2)",
      [A.id, randomUUID()],
    );
    as(ownerA);
    const result = await interleave(transaction, "crm_create_client", () =>
      createClientAction({
        firstName: "Hélène",
        email: "HELENE@example.com",
        requestId: randomUUID(),
      }),
    );
    failure(result, "client_email_conflict", "email");
    expect(result.ok ? null : result.error.conflict).toEqual({
      clientId: row.client_id,
      displayName: "Hélène Roux",
    });
  });

  it("an edit racing another of the same version waits, then is stale (no lost update)", async () => {
    const record = await newCustomer({ firstName: "Iona" });
    const { transaction } = await firstCall(
      "select * from public.crm_update_client($1, $2, 1, 'Iona', 'Première')",
      [A.id, record.id],
    );
    as(ownerA);
    const result = await interleave(transaction, "crm_update_client", () =>
      updateClientAction({
        clientId: record.id,
        expectedVersion: 1,
        firstName: "Iona",
        lastName: "Seconde",
      }),
    );
    failure(result, "stale_client");
    expect(await clientRow(record.id)).toMatchObject({
      last_name: "Première",
      version: 2,
    });
  });

  it("a note racing the same request waits for it and answers with its note", async () => {
    const record = await newCustomer({ firstName: "Jeanne" });
    const requestId = randomUUID();
    const { transaction, row } = await firstCall<{ note_id: string }>(
      "select * from public.crm_create_client_note($1, $2, 'Même note', $3)",
      [A.id, record.id, requestId],
    );
    as(ownerA);
    const result = ok(
      await interleave(transaction, "crm_create_client_note", () =>
        createClientNoteAction({
          clientId: record.id,
          content: "Même note",
          requestId,
        }),
      ),
    );
    expect(result).toMatchObject({
      created: false,
      note: { id: row.note_id },
    });
  });

  it("a note edit racing another of the same version waits, then is stale (no lost update)", async () => {
    const record = await newCustomer({ firstName: "Katia" });
    as(ownerA);
    const note = ok(
      await createClientNoteAction({
        clientId: record.id,
        content: "Départ",
        requestId: randomUUID(),
      }),
    ).note;
    const { transaction } = await firstCall(
      "select * from public.crm_update_client_note($1, $2, $3, 1, 'Première')",
      [A.id, record.id, note.id],
    );
    const result = await interleave(transaction, "crm_update_client_note", () =>
      updateClientNoteAction({
        clientId: record.id,
        noteId: note.id,
        expectedVersion: 1,
        content: "Seconde",
      }),
    );
    failure(result, "stale_note");
    expect(await noteRow(note.id)).toMatchObject({
      content: "Première",
      version: 2,
    });
  });
});

describe("the functions' surface", () => {
  it("members only, as the caller (RLS applies); the list cannot write; the email helper reads no table", async () => {
    const { rows } = await db.query(
      `select p.proname as name, p.prosecdef as definer, p.provolatile as volatility,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as member
       from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('crm_canonical_email', 'crm_canonical_note_content', 'crm_create_client', 'crm_update_client',
           'crm_list_client_notes', 'crm_create_client_note', 'crm_update_client_note',
           'crm_delete_client_note')
       order by 1`,
    );
    const fn = (name: string, volatility: string, definer = false) => ({
      name,
      definer,
      volatility,
      anon: false,
      member: true,
    });
    expect(rows).toEqual([
      fn("crm_canonical_email", "i", true),
      fn("crm_canonical_note_content", "i"),
      fn("crm_create_client", "v"),
      fn("crm_create_client_note", "v"),
      fn("crm_delete_client_note", "v"),
      fn("crm_list_client_notes", "s"),
      fn("crm_update_client", "v"),
      fn("crm_update_client_note", "v"),
    ]);
    const { rows: helper } = await db.query<{ source: string }>(
      "select btrim(prosrc, E' \\n') as source from pg_proc where proname = 'crm_canonical_email'",
    );
    expect(helper).toEqual([
      { source: "select private.canonical_email(p_value);" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Note authorship: controlled by the database, never erased by a member
// ---------------------------------------------------------------------------

describe("note authorship", () => {
  /** A professional added to `business` as a second member. */
  async function member(label: string, business: TestBusiness) {
    const professional = await createProfessional(label);
    await db.query(
      `insert into public.business_members (business_id, user_id, role)
       values ($1, $2, 'admin')`,
      [business.id, professional.userId],
    );
    return professional;
  }

  /** Alice writes a note, Bob edits it: both authors are recorded. */
  async function writtenAndEdited() {
    const founder = await createProfessional("crm-authors-owner");
    const business = await createBusiness(founder.userId);
    const alice = await member("crm-authors-alice", business);
    const bob = await member("crm-authors-bob", business);
    const { rows } = await db.query<{ id: string }>(
      `insert into public.clients (business_id, first_name) values ($1, 'Emma') returning id`,
      [business.id],
    );
    const clientId = rows[0]!.id;
    as(alice);
    const note = ok(
      await createClientNoteAction({
        clientId,
        content: "Écrite par Alice",
        requestId: randomUUID(),
      }),
    ).note;
    as(bob);
    ok(
      await updateClientNoteAction({
        clientId,
        noteId: note.id,
        expectedVersion: 1,
        content: "Modifiée par Bob",
      }),
    );
    const row = await noteRow(note.id);
    expect(row).toMatchObject({
      created_by: alice.userId,
      updated_by: bob.userId,
      version: 2,
    });
    return { business, alice, bob, clientId, noteId: note.id, row: row! };
  }

  it("a member cannot erase, forge or re-version attribution through the API", async () => {
    const { bob, alice, noteId, row } = await writtenAndEdited();
    for (const change of [
      { created_by: null, updated_by: null },
      { created_by: null },
      { updated_by: null },
      { created_by: bob.userId },
      { updated_by: alice.userId },
      { version: 99 },
      { updated_at: "2030-01-01T00:00:00Z" },
    ]) {
      const { error } = await bob.client
        .from("client_notes")
        .update(change)
        .eq("id", noteId);
      expect(error?.code).toBe("42501");
    }
    expect(await noteRow(noteId)).toEqual(row);

    // The content stays editable directly, with the database's attribution.
    const { error } = await bob.client
      .from("client_notes")
      .update({ content: "Corrigée par Bob" })
      .eq("id", noteId);
    expect(error).toBeNull();
    expect(await noteRow(noteId)).toMatchObject({
      created_by: alice.userId,
      updated_by: bob.userId,
      version: 3,
    });
  });

  it("whatever the role, a reference to an existing profile is never nulled", async () => {
    const { noteId, row } = await writtenAndEdited();
    for (const sql of [
      "update public.client_notes set created_by = null, updated_by = null where id = $1",
      "update public.client_notes set created_by = null where id = $1",
      "update public.client_notes set updated_by = null where id = $1",
    ]) {
      await expect(db.query(sql, [noteId])).rejects.toMatchObject({
        message: "client_note_immutable",
      });
    }
    expect(await noteRow(noteId)).toEqual(row);
  });

  it("a genuinely deleted account clears its references; later edits still work", async () => {
    const { alice, bob, clientId, noteId, row } = await writtenAndEdited();
    const admin = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await admin.auth.admin.deleteUser(alice.userId);
    expect(error).toBeNull();
    const { rows: profiles } = await db.query(
      "select 1 from public.profiles where id = $1",
      [alice.userId],
    );
    expect(profiles).toEqual([]);
    // The foreign key cleared the reference: nothing else moved.
    expect(await noteRow(noteId)).toEqual({ ...row, created_by: null });

    as(bob);
    const edited = ok(
      await updateClientNoteAction({
        clientId,
        noteId,
        expectedVersion: 2,
        content: "Reprise par Bob",
      }),
    ).note;
    expect(edited).toMatchObject({
      createdBy: null,
      updatedBy: bob.userId,
      version: 3,
    });
  });

  it("another business's member cannot touch the attribution either", async () => {
    const { noteId, row } = await writtenAndEdited();
    const { error } = await ownerB.client
      .from("client_notes")
      .update({ created_by: null })
      .eq("id", noteId);
    expect(error?.code).toBe("42501");
    const edit = await ownerB.client
      .from("client_notes")
      .update({ content: "Intrusion" })
      .eq("id", noteId)
      .select();
    expect(edit.data).toEqual([]);
    expect(await noteRow(noteId)).toEqual(row);
  });
});

// ---------------------------------------------------------------------------
// A processed creation request stays processed, even once its note is gone
// ---------------------------------------------------------------------------

describe("deleted notes and replayed creations", () => {
  async function notesOf(clientId: string) {
    const { rows } = await db.query<{ id: string; content: string }>(
      "select id, content from public.client_notes where client_id = $1 order by created_at",
      [clientId],
    );
    return rows;
  }

  async function writeThenDelete(content = "Supprimée ensuite") {
    const record = await newCustomer({ firstName: "Fanny" });
    as(ownerA);
    const input = { clientId: record.id, content, requestId: randomUUID() };
    const note = ok(await createClientNoteAction(input)).note;
    ok(
      await updateClientNoteAction({
        clientId: record.id,
        noteId: note.id,
        expectedVersion: 1,
        content: `${content} (modifiée)`,
      }),
    );
    return { record, input, note };
  }

  it("create, edit, replay: the same note, no duplicate, no content reset", async () => {
    const { record, input, note } = await writeThenDelete();
    const replayed = ok(await createClientNoteAction(input));
    expect(replayed).toMatchObject({
      created: false,
      note: { id: note.id, content: `${input.content} (modifiée)`, version: 2 },
    });
    expect(await notesOf(record.id)).toHaveLength(1);
  });

  it("create, delete, replay: note_deleted, nothing recreated; a changed payload is idempotency_conflict", async () => {
    const { record, input, note } = await writeThenDelete();
    ok(
      await deleteClientNoteAction({
        clientId: record.id,
        noteId: note.id,
        expectedVersion: 2,
      }),
    );

    failure(await createClientNoteAction(input), "note_deleted", "requestId");
    failure(
      await createClientNoteAction({ ...input, content: "Autre texte" }),
      "idempotency_conflict",
      "requestId",
    );
    expect(await notesOf(record.id)).toEqual([]);
    expect(
      ok(await listClientNotesAction({ clientId: record.id })).notes,
    ).toEqual([]);

    // A new request writes a new note, even with the same text.
    const fresh = ok(
      await createClientNoteAction({ ...input, requestId: randomUUID() }),
    );
    expect(fresh.created).toBe(true);
    expect(fresh.note.id).not.toBe(note.id);
    expect(await notesOf(record.id)).toEqual([
      { id: fresh.note.id, content: input.content },
    ]);
  });

  it("a note deleted directly through the API is not recreated by a replay", async () => {
    const { record, input, note } = await writeThenDelete();
    const removal = await ownerA.client
      .from("client_notes")
      .delete()
      .eq("id", note.id)
      .select();
    expect(removal.data).toHaveLength(1);
    failure(await createClientNoteAction(input), "note_deleted");
    expect(await notesOf(record.id)).toEqual([]);
  });

  it("a replay racing the deletion waits for it, then answers note_deleted", async () => {
    const { record, input, note } = await writeThenDelete();
    const { transaction, row } = await firstCall<{ status: string }>(
      "select * from public.crm_delete_client_note($1, $2, $3, 2)",
      [A.id, record.id, note.id],
    );
    expect(row.status).toBe("deleted");
    as(ownerA);
    const result = await interleave(transaction, "crm_create_client_note", () =>
      createClientNoteAction(input),
    );
    failure(result, "note_deleted");
    expect(await notesOf(record.id)).toEqual([]);
  });

  it("the ledger keeps no content, is unreachable from the API, and goes with the customer", async () => {
    const { record, input, note } = await writeThenDelete("Texte privé");
    ok(
      await deleteClientNoteAction({
        clientId: record.id,
        noteId: note.id,
        expectedVersion: 2,
      }),
    );
    const { rows: columns } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'private' and table_name = 'client_note_requests'
       order by ordinal_position`,
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "business_id",
      "request_id",
      "client_id",
      "fingerprint",
      "note_id",
      "created_at",
    ]);
    const { rows: ledger } = await db.query(
      `select note_id from private.client_note_requests
       where business_id = $1 and request_id = $2`,
      [A.id, input.requestId],
    );
    expect(ledger).toEqual([{ note_id: null }]);
    const { rows: content } = await db.query(
      "select 1 from public.client_notes where content like 'Texte privé%'",
    );
    expect(content).toEqual([]);
    const { rows: privileges } = await db.query(
      `select has_table_privilege('authenticated', 'private.client_note_requests', 'select, insert, update, delete') as member,
              has_table_privilege('anon', 'private.client_note_requests', 'select, insert, update, delete') as anon`,
    );
    expect(privileges).toEqual([{ member: false, anon: false }]);

    // The ledger goes with the customer's data.
    await db.query("delete from public.clients where id = $1", [record.id]);
    const { rows: remaining } = await db.query(
      "select 1 from private.client_note_requests where client_id = $1",
      [record.id],
    );
    expect(remaining).toEqual([]);
  });

  it("request ids are per business: the same id in another business is another request", async () => {
    const { input } = await writeThenDelete();
    as(ownerB);
    const elsewhere = ok(
      await createClientAction({ firstName: "Gina", requestId: randomUUID() }),
    ).client;
    const created = ok(
      await createClientNoteAction({
        clientId: elsewhere.id,
        content: input.content,
        requestId: input.requestId,
      }),
    );
    expect(created.created).toBe(true);
    expect(await notesOf(elsewhere.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// One canonical content, whatever the creation path (Server Action, SQL
// function, a member's direct insert)
// ---------------------------------------------------------------------------

describe("one canonical note content, whatever the creation path", () => {
  /** The Server Action's normalization (the contract): NFC, then trim. */
  const canonical = (value: string) => value.normalize("NFC").trim();

  async function customerOfA() {
    return (await newCustomer({ firstName: "Lola" })).id;
  }

  /** A member's direct insert through the API (permitted by RLS). */
  async function directInsert(
    clientId: string,
    content: string,
    requestId: string | null = randomUUID(),
  ) {
    return ownerA.client
      .from("client_notes")
      .insert({
        business_id: A.id,
        client_id: clientId,
        content,
        creation_request_id: requestId,
      })
      .select("id, content, version")
      .single();
  }

  /** The SQL function, called directly as the member. */
  async function rpcCreate(
    clientId: string,
    content: string,
    requestId: string,
  ) {
    return ownerA.client
      .rpc("crm_create_client_note", {
        p_business_id: A.id,
        p_client_id: clientId,
        p_content: content,
        p_request_id: requestId,
      })
      .single();
  }

  async function storedNotes(clientId: string) {
    const { rows } = await db.query<{ id: string; content: string }>(
      "select id, content from public.client_notes where client_id = $1 order by created_at, id",
      [clientId],
    );
    return rows;
  }

  /** The fingerprint the ledger keeps, and the one of the canonical command. */
  async function fingerprints(
    clientId: string,
    requestId: string,
    content: string,
  ) {
    const { rows } = await db.query<{ kept: string; expected: string }>(
      `select r.fingerprint as kept,
              encode(sha256(convert_to(
                jsonb_build_object('client_id', $2::uuid, 'content', $3::text)::text,
                'UTF8')), 'hex') as expected
       from private.client_note_requests r
       where r.business_id = $1 and r.request_id = $4`,
      [A.id, clientId, canonical(content), requestId],
    );
    return rows[0];
  }

  it("a direct insert, then the same command through the SQL function and the action: one note", async () => {
    const clientId = await customerOfA();
    const requestId = randomUUID();
    const raw = "  École  ";

    const inserted = await directInsert(clientId, raw, requestId);
    expect(inserted.error).toBeNull();
    expect(inserted.data!.content).toBe(canonical(raw));
    expect(inserted.data!.content).toBe("École");

    const replayed = await rpcCreate(clientId, raw, requestId);
    expect(replayed.error).toBeNull();
    expect(replayed.data).toEqual({
      status: "replayed",
      note_id: inserted.data!.id,
    });

    as(ownerA);
    expect(
      ok(await createClientNoteAction({ clientId, content: raw, requestId })),
    ).toMatchObject({ created: false, note: { id: inserted.data!.id } });

    expect(await storedNotes(clientId)).toEqual([
      { id: inserted.data!.id, content: "École" },
    ]);
    const prints = await fingerprints(clientId, requestId, raw);
    expect(prints!.kept).toBe(prints!.expected);
  });

  it("a direct insert, its deletion, then a replay: note_deleted, nothing recreated", async () => {
    const clientId = await customerOfA();
    const requestId = randomUUID();
    const raw = "\tÉcole ";
    const inserted = await directInsert(clientId, raw, requestId);
    expect(inserted.error).toBeNull();

    as(ownerA);
    expect(
      ok(
        await deleteClientNoteAction({
          clientId,
          noteId: inserted.data!.id,
          expectedVersion: 1,
        }),
      ).deleted,
    ).toBe(true);

    const replayed = await rpcCreate(clientId, raw, requestId);
    expect(replayed.data).toEqual({ status: "deleted", note_id: null });
    failure(
      await createClientNoteAction({ clientId, content: raw, requestId }),
      "note_deleted",
    );
    expect(await storedNotes(clientId)).toEqual([]);
  });

  it("canonically equivalent NFC and NFD texts are one command, with one fingerprint", async () => {
    const clientId = await customerOfA();
    const nfd = "Crème au café";
    const nfc = "Crème au café";
    expect(nfd).not.toBe(nfc);

    const requestId = randomUUID();
    as(ownerA);
    const created = ok(
      await createClientNoteAction({ clientId, content: nfd, requestId }),
    ).note;
    expect(created.content).toBe(nfc);
    expect((await rpcCreate(clientId, nfc, requestId)).data).toEqual({
      status: "replayed",
      note_id: created.id,
    });
    // The direct path recognizes the same request too (never a conflict).
    const direct = await directInsert(clientId, nfc, requestId);
    expect(direct.error).toMatchObject({ message: "client_note_replayed" });

    // Two requests of the same text, one per path and form: same fingerprint.
    const viaInsert = randomUUID();
    const viaFunction = randomUUID();
    expect((await directInsert(clientId, nfd, viaInsert)).error).toBeNull();
    expect((await rpcCreate(clientId, nfc, viaFunction)).error).toBeNull();
    const first = await fingerprints(clientId, viaInsert, nfd);
    const second = await fingerprints(clientId, viaFunction, nfc);
    expect(first!.kept).toBe(second!.kept);
    expect(first!.kept).toBe(first!.expected);
    expect((await storedNotes(clientId)).map((note) => note.content)).toEqual([
      nfc,
      nfc,
      nfc,
    ]);
  });

  it("peripheral whitespace is trimmed exactly as the action's String.prototype.trim, by every path", async () => {
    const clientId = await customerOfA();
    // Removed by String.prototype.trim (and the database), on both sides.
    const trimmed = [
      " Note ",
      "\t\nNote\r\n",
      " Note ",
      " Note ",
      "　Note﻿",
      "  Note  ",
    ];
    // Kept by String.prototype.trim: kept by the database as well.
    const kept = ["​Note", "Note\u0085", "A  \n  B"];
    for (const raw of [...trimmed, ...kept]) {
      const inserted = await directInsert(clientId, raw);
      expect(inserted.error).toBeNull();
      expect(inserted.data!.content).toBe(canonical(raw));
    }

    // One request, three paths, three spellings: one note.
    const requestId = randomUUID();
    const inserted = await directInsert(clientId, "　\tNote ", requestId);
    expect(inserted.data!.content).toBe("Note");
    expect((await rpcCreate(clientId, " Note\n", requestId)).data).toEqual({
      status: "replayed",
      note_id: inserted.data!.id,
    });
    as(ownerA);
    expect(
      ok(
        await createClientNoteAction({
          clientId,
          content: "﻿Note ",
          requestId,
        }),
      ).created,
    ).toBe(false);

    // A character trim keeps is content: another command.
    expect((await rpcCreate(clientId, "​Note", requestId)).error).toMatchObject(
      { message: "idempotency_conflict" },
    );
  });

  it("empty or too long once canonical: refused on the direct path too; the limit counts the canonical text", async () => {
    const clientId = await customerOfA();
    for (const raw of [" 　\t﻿ ", " \n"]) {
      const inserted = await directInsert(clientId, raw);
      expect(inserted.error).not.toBeNull();
    }
    const padded = await directInsert(clientId, ` ${"x".repeat(5000)}　 `);
    expect(padded.error).toBeNull();
    expect(padded.data!.content).toHaveLength(5000);
    expect(
      (await directInsert(clientId, "x".repeat(5001))).error,
    ).not.toBeNull();
    expect(await storedNotes(clientId)).toHaveLength(1);
  });

  it("a direct edit is canonical too: a whitespace-only difference changes nothing (version kept)", async () => {
    const clientId = await customerOfA();
    const inserted = await directInsert(clientId, "École");
    const noteId = inserted.data!.id;
    const same = await ownerA.client
      .from("client_notes")
      .update({ content: "  École　" })
      .eq("id", noteId)
      .select("content, version")
      .single();
    expect(same.data).toEqual({ content: "École", version: 1 });
    as(ownerA);
    expect(
      ok(
        await updateClientNoteAction({
          clientId,
          noteId,
          expectedVersion: 1,
          content: "\tÉcole ",
        }),
      ).changed,
    ).toBe(false);
    const changed = await ownerA.client
      .from("client_notes")
      .update({ content: " École primaire " })
      .eq("id", noteId)
      .select("content, version")
      .single();
    expect(changed.data).toEqual({ content: "École primaire", version: 2 });
  });

  it("a different text, or another customer, under the same request id: idempotency_conflict on every path", async () => {
    const clientId = await customerOfA();
    const other = await customerOfA();
    const requestId = randomUUID();
    expect(
      (await directInsert(clientId, " Première ", requestId)).error,
    ).toBeNull();

    expect(
      (await rpcCreate(clientId, "Seconde", requestId)).error,
    ).toMatchObject({
      message: "idempotency_conflict",
    });
    expect(
      (await directInsert(clientId, "Seconde", requestId)).error,
    ).toMatchObject({
      message: "idempotency_conflict",
    });
    as(ownerA);
    failure(
      await createClientNoteAction({ clientId, content: "Seconde", requestId }),
      "idempotency_conflict",
    );
    // Same text, another customer of the same business.
    expect((await rpcCreate(other, "Première", requestId)).error).toMatchObject(
      {
        message: "idempotency_conflict",
      },
    );
    failure(
      await createClientNoteAction({
        clientId: other,
        content: "Première",
        requestId,
      }),
      "idempotency_conflict",
    );
    expect(await storedNotes(clientId)).toHaveLength(1);
    expect(await storedNotes(other)).toEqual([]);
  });
});
