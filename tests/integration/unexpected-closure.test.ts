import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type {
  ClosureDone,
  ClosurePreview,
} from "@/features/availability/data/closure";
import { claimedEmailSchema } from "@/features/notifications/schemas/claimed-email";
import { renderEmail } from "@/features/notifications/templates/render";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  insertAppointment,
  type Professional,
} from "./support/fixtures";

// Point 101: an unexpected closure over booked dates, through the owner's
// real session (20261122190000_unexpected_closure.sql).

type Rpc = {
  data: unknown;
  error: { message: string; details?: string; hint?: string } | null;
};
const call = async (
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Rpc> =>
  (client.rpc as unknown as (f: string, a: object) => Promise<Rpc>)(fn, args);
async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${error.message} ${error.details ?? ""}`);
  return data as T;
}

let owner: Professional;
let stranger: Professional;

beforeAll(async () => {
  owner = await createProfessional("closure");
  stranger = await createProfessional("closure-stranger");
});

/** A business with a 60 min service and three customers, one without email. */
async function salon() {
  const business = await createBusiness(owner.userId, {
    timezone: "Europe/Paris",
  });
  const service = await createService(business.id, {
    name: "Pose",
    durationMinutes: 60,
    priceCents: 5000,
  });
  const tag = randomUUID().slice(0, 8);
  const lea = await createClientRecord(
    business.id,
    `lea-${tag}@client.test`,
    "Léa",
  );
  const nora = await createClientRecord(
    business.id,
    `nora-${tag}@client.test`,
    "Nora",
  );
  const { rows } = await db.query<{ id: string }>(
    "insert into public.clients (business_id, first_name, phone) values ($1, 'Zoé', '06 11 22 33 44') returning id",
    [business.id],
  );
  const visit = (clientId: string, at: string, status?: "cancelled") =>
    insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: at,
      endsAt: new Date(Date.parse(at) + 3_600_000).toISOString(),
      status,
    });
  return { business, service, lea, nora, zoe: rows[0]!.id, visit };
}

const preview = (businessId: string, start: string, end: string) =>
  call(owner.client, "closure_preview", {
    p_business_id: businessId,
    p_start_date: start,
    p_end_date: end,
  });

const commit = (
  businessId: string,
  start: string,
  end: string,
  decisions: {
    appointmentId: string;
    expectedVersion: number;
    moveTo: string | null;
  }[],
  extra: {
    requestId?: string;
    reason?: string | null;
    message?: string | null;
  } = {},
) =>
  call(owner.client, "closure_commit", {
    p_business_id: businessId,
    p_request_id: extra.requestId ?? randomUUID(),
    p_start_date: start,
    p_end_date: end,
    p_reason: extra.reason ?? null,
    p_message: extra.message ?? null,
    p_decisions: decisions,
  });

const cancelAll = (p: ClosurePreview) =>
  p.appointments.map((a) => ({
    appointmentId: a.id,
    expectedVersion: a.version,
    moveTo: null,
  }));

const statusOf = async (ids: string[]) =>
  (
    await db.query<{
      id: string;
      status: string;
      starts_at: Date;
      version: number;
      cancellation_reason: string | null;
    }>(
      "select id, status, starts_at, version, cancellation_reason from public.appointments where id = any($1)",
      [ids],
    )
  ).rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

const closuresOf = async (businessId: string) =>
  (
    await db.query<{ starts_at: Date; ends_at: Date; reason: string | null }>(
      "select starts_at, ends_at, reason from public.availability_exceptions where business_id = $1 and kind = 'closed'",
      [businessId],
    )
  ).rows;

describe("closure_preview", () => {
  it("lists the confirmed appointments of the dates, with what she needs to tell each customer", async () => {
    const s = await salon();
    const day = dateInDays(12);
    const next = dateInDays(13);
    const a = await s.visit(s.lea, `${day}T08:00:00Z`);
    const b = await s.visit(s.zoe, `${next}T13:00:00Z`);
    await s.visit(s.nora, `${day}T10:00:00Z`, "cancelled");
    await s.visit(s.nora, `${dateInDays(14)}T08:00:00Z`);

    const p = await ok<ClosurePreview>(preview(s.business.id, day, next));
    expect(p.timeZone).toBe("Europe/Paris");
    expect(p.appointments.map((x) => x.id)).toEqual([a, b]);
    expect(p.appointments[0]).toMatchObject({
      version: 1,
      begun: false,
      serviceName: "Pose",
      durationMinutes: 60,
      localStartsAt: expect.stringMatching(new RegExp(`^${day}T09:00`)),
      client: {
        id: s.lea,
        firstName: "Léa",
        email: expect.stringContaining("lea-"),
      },
    });
    expect(p.appointments[1]!.client).toMatchObject({
      firstName: "Zoé",
      email: null,
      phone: "06 11 22 33 44",
    });
  });

  it("is refused to anyone else, for past dates and for reversed dates", async () => {
    const s = await salon();
    const day = dateInDays(12);
    expect(
      (
        await call(stranger.client, "closure_preview", {
          p_business_id: s.business.id,
          p_start_date: day,
          p_end_date: day,
        })
      ).error?.message,
    ).toBe("forbidden");
    expect(
      (await preview(s.business.id, dateInDays(-2), day)).error,
    ).toMatchObject({
      message: "invalid_input",
      hint: "startDate",
    });
    expect(
      (await preview(s.business.id, day, dateInDays(10))).error,
    ).toMatchObject({
      message: "invalid_input",
      hint: "endDate",
    });
  });

  it("closing today starts now: what is over is not touched", async () => {
    const s = await salon();
    const over = await s.visit(
      s.lea,
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
    );
    const today = (
      await db.query<{ d: string }>(
        "select private.local_date_of(now(), 'Europe/Paris')::text as d",
      )
    ).rows[0]!.d;
    const p = await ok<ClosurePreview>(preview(s.business.id, today, today));
    expect(Math.abs(Date.parse(p.startsAt) - Date.now())).toBeLessThan(60_000);
    expect(p.appointments.map((x) => x.id)).not.toContain(over);
  });
});

describe("closure_commit", () => {
  it("cancels, moves, closes and tells each customer, in the closure's words, once", async () => {
    const s = await salon();
    const day = dateInDays(15);
    const after = dateInDays(17);
    const lea = await s.visit(s.lea, `${day}T08:00:00Z`); // entered by the pro
    const nora = await s.visit(s.nora, `${day}T10:00:00Z`); // booked online
    const zoe = await s.visit(s.zoe, `${day}T13:00:00Z`); // no email
    await db.query(
      `insert into public.email_events (business_id, client_id, appointment_id, type, recipient_email, payload, dedupe_key)
       select business_id, client_id, id, 'booking_confirmation', client_email_snapshot, '{}', 'booking_confirmation:' || id
       from public.appointments where id = $1`,
      [nora],
    );

    const p = await ok<ClosurePreview>(preview(s.business.id, day, day));
    const decisions = [
      { appointmentId: lea, expectedVersion: 1, moveTo: null },
      { appointmentId: nora, expectedVersion: 1, moveTo: `${after}T10:00:00Z` },
      { appointmentId: zoe, expectedVersion: 1, moveTo: null },
    ];
    expect(p.appointments.map((x) => x.id).sort()).toEqual(
      [lea, nora, zoe].sort(),
    );
    const requestId = randomUUID();
    const message = "Je suis malade, désolée !\nJe vous recontacte vite.";
    const done = await ok<ClosureDone>(
      commit(s.business.id, day, day, decisions, {
        requestId,
        reason: "Maladie",
        message,
      }),
    );
    expect([...done.cancelled].sort()).toEqual([lea, zoe].sort());
    expect(done.moved).toEqual([nora]);
    expect(done.notified).toBe(2);

    const rows = await statusOf([lea, nora, zoe]);
    expect(rows.map((r) => r.status)).toEqual([
      "cancelled",
      "confirmed",
      "cancelled",
    ]);
    expect(rows[0]!.cancellation_reason).toBe("Maladie");
    expect(rows[1]!.starts_at.toISOString()).toBe(`${after}T10:00:00.000Z`);

    // The closure, the whole day in Paris.
    const [closure] = await closuresOf(s.business.id);
    expect(closure).toMatchObject({ reason: "Maladie" });
    expect(closure!.starts_at.toISOString()).toBe(
      new Date(`${dateInDays(14)}T23:00:00Z`).toISOString(),
    );

    // Emails: Léa (entered by the pro) is told too; Nora gets one change
    // notice, not a confirmation then a change; Zoé has no address.
    const { rows: emails } = await db.query<{
      appointment_id: string;
      type: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      "select appointment_id, type, status, payload from public.email_events where appointment_id = any($1) and status = 'pending'",
      [[lea, nora, zoe]],
    );
    const notices = emails.filter((e) => e.type !== "appointment_reminder");
    expect(notices.map((e) => [e.appointment_id, e.type]).sort()).toEqual(
      [
        [lea, "appointment_cancelled"],
        [nora, "appointment_changed"],
      ].sort(),
    );
    for (const notice of notices) {
      expect(notice.payload.closure).toEqual({ kind: "closure", message });
    }
    // Reminders: none left for the cancelled, one at the new time for Nora.
    const reminders = emails.filter((e) => e.type === "appointment_reminder");
    expect(reminders.map((e) => e.appointment_id)).toEqual([nora]);

    // A new booking cannot land in the closed day any more.
    expect(
      (
        await call(owner.client, "agenda_create_appointment", {
          p_business_id: s.business.id,
          p_service_id: s.service,
          p_starts_at: `${day}T08:00:00Z`,
          p_client_id: s.lea,
          p_request_id: randomUUID(),
        })
      ).error?.message,
    ).toBe("schedule_conflict");

    // Replay: the same answer, nothing done twice. Other content: refused.
    expect(
      await ok(
        commit(s.business.id, day, day, decisions, {
          requestId,
          reason: "Maladie",
          message,
        }),
      ),
    ).toEqual(done);
    expect(
      (
        await commit(s.business.id, day, day, decisions, {
          requestId,
          reason: "Autre",
          message,
        })
      ).error?.message,
    ).toBe("idempotency_conflict");
    expect(await closuresOf(s.business.id)).toHaveLength(1);

    // The worker reads the closure's words and the email says them.
    const claimed = await db.query<{ items: unknown[] }>(
      "select private.email_outbox_claim_at(now(), 20, 20, 60, $1) as items",
      [s.business.id],
    );
    const items = claimed.rows[0]!.items.map((item) =>
      claimedEmailSchema.parse(item),
    );
    const cancelled = items.find((i) => i.appointment.id === lea)!;
    expect(cancelled.notice).toEqual({ kind: "closure", message });
    const rendered = renderEmail(cancelled, { appUrl: "https://app.test" });
    expect(rendered.subject).toContain(
      "Fermeture exceptionnelle : rendez-vous annulé",
    );
    expect(rendered.text).toContain(
      "est exceptionnellement fermé à la date prévue",
    );
    expect(rendered.text).toContain(
      "Je suis malade, désolée !\nJe vous recontacte vite.",
    );
    expect(rendered.text).toContain(`/b/${s.business.slug}`);
    const reminder = items.find((i) => i.type === "appointment_reminder");
    expect(reminder?.notice ?? null).toBeNull();
  });

  it("does nothing when the agenda changed since the list was shown", async () => {
    const s = await salon();
    const day = dateInDays(20);
    const lea = await s.visit(s.lea, `${day}T08:00:00Z`);
    const p = await ok<ClosurePreview>(preview(s.business.id, day, day));

    // A booking meanwhile: the list is no longer the closure's.
    const late = await s.visit(s.nora, `${day}T12:00:00Z`);
    expect(
      (await commit(s.business.id, day, day, cancelAll(p))).error?.message,
    ).toBe("closure_stale");
    // Moved meanwhile (version 2): named.
    await db.query(
      "update public.appointments set internal_notes = 'x' where id = $1",
      [lea],
    );
    const refused = await commit(s.business.id, day, day, [
      { appointmentId: lea, expectedVersion: 1, moveTo: null },
      { appointmentId: late, expectedVersion: 1, moveTo: null },
    ]);
    expect(refused.error).toMatchObject({
      message: "closure_stale",
      details: lea,
    });

    expect((await statusOf([lea, late])).map((r) => r.status)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    expect(await closuresOf(s.business.id)).toEqual([]);
  });

  it("refuses a move into the closure, into the past or onto a taken time, and does nothing", async () => {
    const s = await salon();
    const day = dateInDays(22);
    const lea = await s.visit(s.lea, `${day}T08:00:00Z`);
    const nora = await s.visit(s.nora, `${day}T10:00:00Z`);
    const taken = `${dateInDays(24)}T08:00:00Z`;
    await s.visit(s.zoe, taken);
    const move = (to: string) => [
      { appointmentId: lea, expectedVersion: 1, moveTo: null },
      { appointmentId: nora, expectedVersion: 1, moveTo: to },
    ];

    expect(
      (await commit(s.business.id, day, day, move(`${day}T15:00:00Z`))).error,
    ).toMatchObject({
      message: "invalid_input",
      hint: "moveTo",
      details: nora,
    });
    expect(
      (
        await commit(
          s.business.id,
          day,
          day,
          move(new Date(Date.now() - 3_600_000).toISOString()),
        )
      ).error,
    ).toMatchObject({ message: "invalid_input", details: nora });
    expect(
      (await commit(s.business.id, day, day, move(taken))).error,
    ).toMatchObject({
      message: "closure_conflict",
      details: nora,
    });

    expect(
      (await statusOf([lea, nora])).map((r) => [r.status, r.version]),
    ).toEqual([
      ["confirmed", 1],
      ["confirmed", 1],
    ]);
    expect(await closuresOf(s.business.id)).toEqual([]);
  });

  it("refuses a link in her words, and does nothing", async () => {
    const s = await salon();
    const day = dateInDays(28);
    const lea = await s.visit(s.lea, `${day}T08:00:00Z`);
    for (const message of [
      "Reprenez rendez-vous sur https://ailleurs.test",
      "Voir monsalon.fr",
      "www.exemple",
    ]) {
      expect(
        (
          await commit(
            s.business.id,
            day,
            day,
            [{ appointmentId: lea, expectedVersion: 1, moveTo: null }],
            { message },
          )
        ).error,
      ).toMatchObject({ message: "invalid_input", hint: "message" });
    }
    expect((await statusOf([lea]))[0]!.status).toBe("confirmed");
    expect(await closuresOf(s.business.id)).toEqual([]);
  });

  it("closes dates with no appointment too, and is the owner's and admins' only", async () => {
    const s = await salon();
    const day = dateInDays(26);
    expect(
      (
        await call(stranger.client, "closure_commit", {
          p_business_id: s.business.id,
          p_request_id: randomUUID(),
          p_start_date: day,
          p_end_date: day,
          p_reason: null,
          p_message: null,
          p_decisions: [],
        })
      ).error?.message,
    ).toBe("forbidden");
    const done = await ok<ClosureDone>(
      commit(s.business.id, day, dateInDays(27), []),
    );
    expect(done).toMatchObject({ cancelled: [], moved: [], notified: 0 });
    expect(await closuresOf(s.business.id)).toHaveLength(1);
  });
});
