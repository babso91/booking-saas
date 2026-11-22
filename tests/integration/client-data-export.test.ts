import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Higani point 205, her right of access: the professional exports from the
// customer's record everything her business holds about her, as one
// document she can hand over. Owner or admin, her business only, no secret.

let owner: Professional;
let business: TestBusiness;
let ines: string;
let service: string;

type Export = {
  format: string;
  business: { name: string };
  client: Record<string, unknown>;
  appointments: Record<string, unknown>[];
  notes: { content: string }[];
  marketingConsent: { events: { state: string; channel: string }[] };
  emails: { type: string; to: string; status: string }[];
  clientSpace: Record<string, unknown> | null;
  loyalty: { balance: number | null; entries: unknown[]; rewards: unknown[] };
  forms: unknown[];
  referrals: unknown[];
  waitlist: unknown[];
  marketingMessages: unknown[];
};

const exportOf = (who: Professional, clientId: string, b = business) =>
  who.client.rpc("crm_export_client", {
    p_business_id: b.id,
    p_client_id: clientId,
  });

beforeEach(async () => {
  owner = await createProfessional("export");
  business = await createBusiness(owner.userId, { name: "Salon Lina" });
  service = await createService(business.id, { name: "Rehaussement" });
  ines = await createClientRecord(business.id, "ines@client.test", "Inès");
  await db.query(
    "update public.clients set last_name = 'Martin', phone = '0612345678', internal_notes = 'Peau sensible' where id = $1",
    [ines],
  );
  const appointment = await insertAppointment({
    businessId: business.id,
    clientId: ines,
    serviceId: service,
    startsAt: "2026-12-01T09:00:00Z",
    endsAt: "2026-12-01T10:00:00Z",
  });
  await db.query(
    `update public.appointments
        set client_first_name_snapshot = 'Inès', client_email_snapshot = 'ines@client.test'
      where id = $1`,
    [appointment],
  );
  await db.query(
    `insert into public.client_notes (business_id, client_id, content, created_by)
     values ($1, $2, 'Préfère le matin', $3)`,
    [business.id, ines, owner.userId],
  );
  await db.query(
    `insert into public.email_events (business_id, client_id, appointment_id, type, recipient_email, dedupe_key, status)
     values ($1, $2, $3, 'booking_confirmation', 'ines@client.test', $4, 'sent')`,
    [business.id, ines, appointment, `export-${randomUUID()}`],
  );
  const withdrawn = await owner.client.rpc("marketing_set_consent", {
    p_business_id: business.id,
    p_client_id: ines,
    p_purpose: "marketing",
    p_channel: "email",
    p_action: "withdraw",
    p_proof_version: null,
    p_request_id: randomUUID(),
  } as never);
  expect(withdrawn.error).toBeNull();
});

describe("point 205: everything her business holds about her", () => {
  it("one document: her record, appointments, notes, consent and emails", async () => {
    const { data, error } = await exportOf(owner, ines);
    expect(error).toBeNull();
    const document = data as unknown as Export;
    expect(document.format).toBe("higani.client-export.v1");
    expect(document.business).toEqual({ name: "Salon Lina" });
    expect(document.client).toMatchObject({
      firstName: "Inès",
      lastName: "Martin",
      email: "ines@client.test",
      phone: "0612345678",
      professionalNotes: "Peau sensible",
    });
    expect(document.appointments).toEqual([
      expect.objectContaining({
        service: "Rehaussement",
        status: "confirmed",
        bookedWith: expect.objectContaining({
          firstName: "Inès",
          email: "ines@client.test",
        }),
      }),
    ]);
    expect(document.notes.map((note) => note.content)).toEqual([
      "Préfère le matin",
    ]);
    expect(document.marketingConsent.events).toEqual([
      expect.objectContaining({ channel: "email", state: "withdrawn" }),
    ]);
    // The confirmation inserted above, and the reminder the database
    // queued for her appointment.
    expect(document.emails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "booking_confirmation",
          to: "ines@client.test",
          status: "sent",
        }),
        expect.objectContaining({
          type: "appointment_reminder",
          to: "ines@client.test",
          status: "pending",
        }),
      ]),
    );
    expect(document.emails).toHaveLength(2);
    // Every part is present, even empty: the document always has one shape.
    expect(document.clientSpace).toBeNull();
    expect(document.loyalty).toEqual({
      balance: null,
      entries: [],
      rewards: [],
    });
    for (const part of [
      document.forms,
      document.referrals,
      document.waitlist,
      document.marketingMessages,
    ])
      expect(part).toEqual([]);
  });

  it("holds no secret or technical key", async () => {
    const hash = `secret-hash-${randomUUID()}`;
    await db.query(
      "update public.clients set loyalty_token_hash = $2 where id = $1",
      [ines, hash],
    );
    const { data } = await exportOf(owner, ines);
    const text = JSON.stringify(data);
    for (const secret of [
      hash,
      "token",
      "fingerprint",
      "request_id",
      "requestId",
      "dedupe",
      "lease",
    ])
      expect(text, secret).not.toContain(secret);
  });

  it("nothing from another customer or another business", async () => {
    const other = await createClientRecord(
      business.id,
      "autre@client.test",
      "Autre",
    );
    await db.query(
      `insert into public.client_notes (business_id, client_id, content, created_by)
       values ($1, $2, 'Note sur une autre', $3)`,
      [business.id, other, owner.userId],
    );
    const elsewhereOwner = await createProfessional("export-elsewhere");
    const elsewhere = await createBusiness(elsewhereOwner.userId);
    // The same person, known by another business under the same address.
    const twin = await createClientRecord(
      elsewhere.id,
      "ines@client.test",
      "Inès",
    );
    await db.query(
      `insert into public.client_notes (business_id, client_id, content, created_by)
       values ($1, $2, 'Note de l''autre salon', $3)`,
      [elsewhere.id, twin, elsewhereOwner.userId],
    );

    const text = JSON.stringify((await exportOf(owner, ines)).data);
    expect(text).not.toContain("Note sur une autre");
    expect(text).not.toContain("Note de l'autre salon");

    // Nor can either business read the other's customer.
    expect((await exportOf(owner, twin, elsewhere)).error?.message).toBe(
      "forbidden",
    );
    expect((await exportOf(elsewhereOwner, ines)).error?.message).toBe(
      "forbidden",
    );
    // A customer of another business, asked under one's own business.
    expect((await exportOf(owner, twin)).error?.message).toBe(
      "client_not_found",
    );
  });

  it("owner or admin only: a practitioner and anonymous callers get nothing", async () => {
    const practitioner = await createProfessional("export-practitioner");
    await db.query(
      `insert into public.business_members (business_id, user_id, role)
       values ($1, $2, 'practitioner')`,
      [business.id, practitioner.userId],
    );
    expect((await exportOf(practitioner, ines)).error?.message).toBe(
      "forbidden",
    );
    const anonymous = await anonClient().rpc("crm_export_client", {
      p_business_id: business.id,
      p_client_id: ines,
    });
    expect(anonymous.error).not.toBeNull();
    expect(anonymous.data).toBeNull();
  });
});
