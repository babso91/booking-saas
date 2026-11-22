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
  who.client.rpc("privacy_export_client", {
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
    const anonymous = await anonClient().rpc("privacy_export_client", {
      p_business_id: business.id,
      p_client_id: ines,
    });
    expect(anonymous.error).not.toBeNull();
    expect(anonymous.data).toBeNull();
  });
});

// Her right to erasure, on the rules the founder validated on 22/11:
// anonymised rather than deleted, refused while an appointment is to come,
// this business only. Nothing is emailed.
describe("point 205: erasing her data", () => {
  let past: string;

  const recordOf = async (id: string) =>
    (
      await db.query<{
        first_name: string;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        internal_notes: string | null;
        erased_at: Date | null;
        version: number;
      }>(
        "select first_name, last_name, email, phone, internal_notes, erased_at, version from public.clients where id = $1",
        [id],
      )
    ).rows[0]!;
  const erase = async (who = owner, clientId = ines, b = business) =>
    who.client.rpc("privacy_erase_client", {
      p_business_id: b.id,
      p_client_id: clientId,
      p_expected_version: (await recordOf(clientId)).version,
    });
  const emailsOf = async (clientId: string) =>
    (
      await db.query<{ type: string; status: string; recipient: string }>(
        `select type, status, recipient_email::text as recipient
           from public.email_events where client_id = $1 order by created_at`,
        [clientId],
      )
    ).rows;

  beforeEach(async () => {
    // Her appointment to come is cancelled; a past one was completed.
    await db.query(
      "update public.appointments set status = 'cancelled', cancellation_reason = 'Inès malade' where client_id = $1",
      [ines],
    );
    past = await insertAppointment({
      businessId: business.id,
      clientId: ines,
      serviceId: service,
      startsAt: "2026-10-01T09:00:00Z",
      endsAt: "2026-10-01T10:00:00Z",
      status: "completed",
    });
    await db.query(
      `insert into private.waitlist_requests
         (business_id, service_id, windows, any_time, first_name, email, active_until,
          confirm_token_hash, confirm_expires_at, request_id, fingerprint, network_key)
       values ($1, $2, '[]', true, 'Inès', 'INES@client.test', now() + interval '30 days',
               $3, now() + interval '1 day', $4, 'f', 'n')`,
      [business.id, service, `hash-${randomUUID()}`, randomUUID()],
    );
    await db.query(
      `insert into public.client_hub_access (business_id, client_id, email, granted_by, granted_at)
       values ($1, $2, 'ines@client.test', $3, now())`,
      [business.id, ines, owner.userId],
    );
  });

  it("anonymises her record and appointments, deletes notes, consents and access, emails nothing", async () => {
    const before = await emailsOf(ines);
    expect(before.some((e) => e.status === "pending")).toBe(true);

    const erased = await erase();
    expect(erased.error).toBeNull();
    expect(erased.data).toMatchObject({ erased: true });

    expect(await recordOf(ines)).toMatchObject({
      first_name: "Cliente effacée",
      last_name: null,
      email: null,
      phone: null,
      internal_notes: null,
      erased_at: expect.any(Date),
    });
    const { rows: appointments } = await db.query(
      `select status, service_name_snapshot, price_cents_snapshot,
              client_first_name_snapshot, client_last_name_snapshot,
              client_email_snapshot, client_phone_snapshot, internal_notes,
              cancellation_reason
         from public.appointments where client_id = $1 order by starts_at`,
      [ines],
    );
    // History and amounts kept; nothing that names her.
    expect(appointments).toHaveLength(2);
    for (const appointment of appointments)
      expect(appointment).toMatchObject({
        service_name_snapshot: "Rehaussement",
        client_first_name_snapshot: "Cliente effacée",
        client_last_name_snapshot: null,
        client_email_snapshot: null,
        client_phone_snapshot: null,
        internal_notes: null,
        cancellation_reason: null,
      });
    expect(appointments.map((a) => a.status)).toEqual([
      "completed",
      "cancelled",
    ]);

    // No new email, nothing left to send, no address kept.
    const after = await emailsOf(ines);
    expect(after).toHaveLength(before.length);
    expect(after.some((e) => e.status === "pending")).toBe(false);
    expect(after.every((e) => e.recipient === "adresse-effacee")).toBe(true);

    for (const [table, where] of [
      ["public.client_notes", "client_id = $1"],
      ["private.consent_events", "client_id = $1"],
      ["public.client_hub_access", "client_id = $1"],
      [
        "private.waitlist_requests",
        "business_id = (select business_id from public.clients where id = $1)",
      ],
    ] as const) {
      const { rows } = await db.query(
        `select count(*)::int as n from ${table} where ${where}`,
        [ines],
      );
      expect(rows[0].n, table).toBe(0);
    }

    // Her export now holds nothing that identifies her.
    const text = JSON.stringify((await exportOf(owner, ines)).data);
    for (const trace of [
      "ines@client.test",
      "Martin",
      "0612345678",
      "Peau sensible",
      "Préfère le matin",
      "Inès malade",
    ])
      expect(text, trace).not.toContain(trace);
    expect(past).toBeTruthy();
  });

  it("is refused while an appointment is to come, and changes nothing", async () => {
    const upcoming = await insertAppointment({
      businessId: business.id,
      clientId: ines,
      serviceId: service,
      // A month from the run: always to come.
      startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 30 * 86_400_000 + 3_600_000).toISOString(),
    });
    const refused = await erase();
    expect(refused.error?.message).toBe("client_has_upcoming_appointments");
    expect(await recordOf(ines)).toMatchObject({
      email: "ines@client.test",
      erased_at: null,
    });

    // Once cancelled, it goes through.
    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [upcoming],
    );
    expect((await erase()).error).toBeNull();
  });

  it("checks the version she was shown, and answers a second erasure", async () => {
    const stale = await owner.client.rpc("privacy_erase_client", {
      p_business_id: business.id,
      p_client_id: ines,
      p_expected_version: (await recordOf(ines)).version - 1,
    });
    expect(stale.error?.message).toBe("stale_client");
    expect((await recordOf(ines)).erased_at).toBeNull();

    expect((await erase()).data).toMatchObject({ erased: true });
    const again = await owner.client.rpc("privacy_erase_client", {
      p_business_id: business.id,
      p_client_id: ines,
      p_expected_version: 1,
    });
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ erased: false });
  });

  it("this business only: the same person elsewhere keeps everything", async () => {
    const elsewhereOwner = await createProfessional("erase-elsewhere");
    const elsewhere = await createBusiness(elsewhereOwner.userId);
    const twin = await createClientRecord(
      elsewhere.id,
      "ines@client.test",
      "Inès",
    );
    const elsewhereService = await createService(elsewhere.id);
    const kept = await insertAppointment({
      businessId: elsewhere.id,
      clientId: twin,
      serviceId: elsewhereService,
      startsAt: "2026-10-02T09:00:00Z",
      endsAt: "2026-10-02T10:00:00Z",
      status: "completed",
    });

    expect((await erase()).error).toBeNull();
    expect(await recordOf(twin)).toMatchObject({
      first_name: "Inès",
      email: "ines@client.test",
      erased_at: null,
    });
    const { rows } = await db.query(
      "select client_email_snapshot from public.appointments where id = $1",
      [kept],
    );
    expect(rows[0].client_email_snapshot).toBe("ines@client.test");
  });

  it("an erased record gets no new appointment, and its booked contact stays immutable otherwise", async () => {
    expect((await erase()).error).toBeNull();
    await expect(
      insertAppointment({
        businessId: business.id,
        clientId: ines,
        serviceId: service,
        startsAt: "2027-02-01T09:00:00Z",
        endsAt: "2027-02-01T10:00:00Z",
      }),
    ).rejects.toMatchObject({ message: "client_erased" });

    // Outside an erasure, a booked contact never changes.
    const other = await createClientRecord(
      business.id,
      "autre2@client.test",
      "Autre",
    );
    const theirs = await insertAppointment({
      businessId: business.id,
      clientId: other,
      serviceId: service,
      startsAt: "2026-10-03T09:00:00Z",
      endsAt: "2026-10-03T10:00:00Z",
      status: "completed",
    });
    await expect(
      db.query(
        `update public.appointments
            set client_first_name_snapshot = 'Cliente effacée', client_email_snapshot = null
          where id = $1`,
        [theirs],
      ),
    ).rejects.toMatchObject({ message: "contact_snapshot_immutable" });
  });

  it("owner or admin only, never from another business", async () => {
    const practitioner = await createProfessional("erase-practitioner");
    await db.query(
      `insert into public.business_members (business_id, user_id, role)
       values ($1, $2, 'practitioner')`,
      [business.id, practitioner.userId],
    );
    expect((await erase(practitioner)).error?.message).toBe("forbidden");
    const intruder = await createProfessional("erase-intruder");
    await createBusiness(intruder.userId);
    expect((await erase(intruder)).error?.message).toBe("forbidden");
    const anonymous = await anonClient().rpc("privacy_erase_client", {
      p_business_id: business.id,
      p_client_id: ines,
      p_expected_version: 1,
    });
    expect(anonymous.error).not.toBeNull();
    expect((await recordOf(ines)).erased_at).toBeNull();
  });
});

describe("point 205 with her reviews (point 8)", () => {
  let tag: string;
  let current: string;
  let previous: string;

  /** A client space account (one per address), as signing in creates it. */
  const account = async (email: string) =>
    (
      await db.query<{ id: string }>(
        "insert into private.client_hub_accounts (email) values ($1) returning id",
        [email],
      )
    ).rows[0]!.id;
  const review = (
    businessId: string,
    accountId: string,
    stars: number,
    comment: string,
    daysAgo: number,
  ) =>
    db.query(
      `insert into private.business_reviews (business_id, account_id, stars, comment, posted_at)
       values ($1, $2, $3, $4, now() - $5 * interval '1 day')`,
      [businessId, accountId, stars, comment, daysAgo],
    );
  const reviewsOf = async (businessId: string) =>
    (
      await db.query<{ comment: string }>(
        "select comment from private.business_reviews where business_id = $1 order by comment",
        [businessId],
      )
    ).rows.map((row) => row.comment);
  const erase = async () => {
    const { rows } = await db.query<{ version: number }>(
      "select version from public.clients where id = $1",
      [ines],
    );
    return owner.client.rpc("privacy_erase_client", {
      p_business_id: business.id,
      p_client_id: ines,
      p_expected_version: rows[0]!.version,
    });
  };

  let elsewhere: TestBusiness;

  beforeEach(async () => {
    tag = randomUUID().slice(0, 8);
    current = `ines-${tag}@client.test`;
    previous = `ines.avant-${tag}@client.test`;
    // Nothing to come; a past visit booked with her former address, which
    // she changed since.
    await db.query(
      "update public.appointments set status = 'cancelled' where client_id = $1",
      [ines],
    );
    await db.query("update public.clients set email = $2 where id = $1", [
      ines,
      previous,
    ]);
    await insertAppointment({
      businessId: business.id,
      clientId: ines,
      serviceId: service,
      startsAt: "2026-10-01T09:00:00Z",
      endsAt: "2026-10-01T10:00:00Z",
      status: "completed",
    });
    await db.query("update public.clients set email = $2 where id = $1", [
      ines,
      current,
    ]);

    const mine = await account(current);
    const former = await account(previous);
    const someone = await account(`lou-${tag}@client.test`);
    await review(business.id, former, 4, "Bien, avant", 40);
    await review(business.id, mine, 5, "Parfait, Inès", 3);
    await review(business.id, someone, 3, "Correct", 2);
    const stranger = await createProfessional("export-elsewhere");
    elsewhere = await createBusiness(stranger.userId);
    await review(elsewhere.id, mine, 5, "Ailleurs aussi", 1);
  });

  it("her export holds her reviews of this business, at both her addresses", async () => {
    const { data, error } = await exportOf(owner, ines);
    expect(error).toBeNull();
    const reviews = (data as { reviews: Record<string, unknown>[] }).reviews;
    expect(reviews.map(({ stars, comment }) => ({ stars, comment }))).toEqual([
      { stars: 4, comment: "Bien, avant" },
      { stars: 5, comment: "Parfait, Inès" },
    ]);
    expect(reviews[0]).toHaveProperty("postedAt");
  });

  it("her erasure deletes them; another client's and another business's stay", async () => {
    const { data, error } = await erase();
    expect(error).toBeNull();
    expect(data).toMatchObject({ erased: true });
    expect(await reviewsOf(business.id)).toEqual(["Correct"]);
    expect(await reviewsOf(elsewhere.id)).toEqual(["Ailleurs aussi"]);
    // Her public page counts what remains.
    const { data: shown } = await anonClient().rpc(
      "get_public_business_reviews" as never,
      { p_slug: business.slug } as never,
    );
    expect(shown).toMatchObject({ count: 1 });
  });

  it("a refused erasure deletes nothing", async () => {
    await insertAppointment({
      businessId: business.id,
      clientId: ines,
      serviceId: service,
      startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 30 * 86_400_000 + 3_600_000).toISOString(),
    });
    expect((await erase()).error?.message).toBe(
      "client_has_upcoming_appointments",
    );
    expect(await reviewsOf(business.id)).toEqual([
      "Bien, avant",
      "Correct",
      "Parfait, Inès",
    ]);
  });
});
