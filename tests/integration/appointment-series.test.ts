import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type {
  SeriesCommitted,
  SeriesPreview,
} from "@/features/appointment-series/data";
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

// Series (docs/APPOINTMENT_SERIES_CONTRACT.md) through PostgREST with the
// owner's real session. Paris civil time; the DST dates are computed from
// today so the test never ages.

type Rpc = {
  data: unknown;
  error: { message: string; details?: string } | null;
};

async function call(
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Rpc> {
  const { data, error } = await (
    client.rpc as unknown as (f: string, a: object) => Promise<Rpc>
  )(fn, args);
  return { data, error };
}
async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Last Sunday of `month` (1-12) of the first year where it is ≥ 20 days ahead. */
function nextLastSunday(month: number): string {
  const now = new Date();
  for (let year = now.getUTCFullYear(); ; year += 1) {
    const last = new Date(Date.UTC(year, month, 0));
    last.setUTCDate(last.getUTCDate() - last.getUTCDay());
    if (last.getTime() - now.getTime() > 20 * 86_400_000) {
      return last.toISOString().slice(0, 10);
    }
  }
}
const shiftDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

let owner: Professional;
let business: TestBusiness;
let service: string;
let clientId: string;
let week = 0;

/** A Tuesday at least four weeks ahead, a fresh week each call. */
function freshTuesday() {
  week += 4;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 28 + week * 7);
  d.setUTCDate(d.getUTCDate() + ((2 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const preview = (
  firstLocalStart: string,
  end: { count?: number; until?: string },
  every = 1,
) =>
  call(owner.client, "preview_appointment_series", {
    p_business_id: business.id,
    p_client_id: clientId,
    p_service_id: service,
    p_option_choice_ids: [],
    p_first_local_start: firstLocalStart,
    p_repeat_every_weeks: every,
    p_count: end.count ?? null,
    p_until_local_date: end.until ?? null,
  });

const commit = (
  previewVersion: string,
  selected: { key: string; startsAt: string }[],
  requestId = randomUUID(),
) =>
  call(owner.client, "commit_appointment_series", {
    p_business_id: business.id,
    p_request_id: requestId,
    p_preview_version: previewVersion,
    p_selected: selected,
  });

const all = (p: SeriesPreview) =>
  p.occurrences.map((o) => ({ key: o.key, startsAt: o.utcCandidates[0]! }));

beforeAll(async () => {
  owner = await createProfessional("series");
  business = await createBusiness(owner.userId, { timezone: "Europe/Paris" });
  service = await createService(business.id, {
    name: "Pose",
    durationMinutes: 60,
    priceCents: 5000,
  });
  clientId = await createClientRecord(
    business.id,
    `serie-${randomUUID().slice(0, 8)}@client.test`,
    "Léa",
  );
});

describe("preview", () => {
  it("keeps the wall clock, quotes once, and caps a series at 12", async () => {
    const tuesday = freshTuesday();
    const p = await ok<SeriesPreview>(
      preview(`${tuesday}T10:00:00`, { count: 3 }, 2),
    );
    expect(p.timeZone).toBe("Europe/Paris");
    expect(p.quote).toEqual({
      serviceName: "Pose",
      durationMinutes: 60,
      priceCents: 5000,
    });
    expect(p.occurrences.map((o) => o.requestedLocalStart)).toEqual([
      `${tuesday}T10:00:00`,
      `${shiftDays(tuesday, 14)}T10:00:00`,
      `${shiftDays(tuesday, 28)}T10:00:00`,
    ]);
    expect(p.occurrences.every((o) => o.state === "available")).toBe(true);

    expect(
      (await preview(`${tuesday}T10:00:00`, { count: 13 })).error?.message,
    ).toBe("too_many_occurrences");
    expect(
      (
        await preview(`${tuesday}T10:00:00`, {
          until: shiftDays(tuesday, 7 * 20),
        })
      ).error?.message,
    ).toBe("too_many_occurrences");
  });

  it("asks for a choice in the repeated autumn hour and proposes an hour later in spring", async () => {
    const autumn = nextLastSunday(10);
    const a = await ok<SeriesPreview>(
      preview(`${shiftDays(autumn, -7)}T02:30:00`, { count: 2 }),
    );
    const repeated = a.occurrences[1]!;
    expect(repeated.state).toBe("ambiguous");
    expect(
      repeated.utcCandidates.map((t) => new Date(t).toISOString()),
    ).toEqual([`${autumn}T00:30:00.000Z`, `${autumn}T01:30:00.000Z`]);

    const spring = nextLastSunday(3);
    const s = await ok<SeriesPreview>(
      preview(`${shiftDays(spring, -7)}T02:30:00`, { count: 2 }),
    );
    const skipped = s.occurrences[1]!;
    expect(skipped.state).toBe("nonexistent");
    expect(skipped.utcCandidates.map((t) => new Date(t).toISOString())).toEqual(
      [`${spring}T01:30:00.000Z`],
    );
  });

  it("shows a taken date as a conflict", async () => {
    const tuesday = freshTuesday();
    await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: `${shiftDays(tuesday, 7)}T09:30:00.000Z`,
      endsAt: `${shiftDays(tuesday, 7)}T10:30:00.000Z`,
    });
    const p = await ok<SeriesPreview>(
      preview(`${tuesday}T10:00:00`, { count: 3 }),
    );
    expect(p.occurrences.map((o) => o.state)).toEqual([
      "available",
      "conflict",
      "available",
    ]);
  });
});

describe("commit", () => {
  it("creates every selected date or none, once per requestId", async () => {
    const autumn = nextLastSunday(10);
    const p = await ok<SeriesPreview>(
      preview(`${shiftDays(autumn, -7)}T02:30:00`, { count: 2 }),
    );
    const selected = [
      { key: "o1", startsAt: p.occurrences[0]!.utcCandidates[0]! },
      { key: "o2", startsAt: p.occurrences[1]!.utcCandidates[1]! },
    ];
    const requestId = randomUUID();
    const done = await ok<SeriesCommitted>(
      commit(p.previewVersion, selected, requestId),
    );
    expect(done.appointmentIds).toHaveLength(2);
    expect(await ok(commit(p.previewVersion, selected, requestId))).toEqual(
      done,
    );
    expect(
      (await commit(p.previewVersion, selected.slice(0, 1), requestId)).error
        ?.message,
    ).toBe("idempotency_conflict");

    const { rows } = await db.query(
      "select starts_at, series_id, version, price_cents_snapshot from public.appointments where id = any($1) order by starts_at",
      [done.appointmentIds],
    );
    expect(rows.map((r) => r.series_id)).toEqual([
      done.seriesId,
      done.seriesId,
    ]);
    expect(rows.map((r) => r.version)).toEqual([1, 1]);
    expect(new Date(rows[1].starts_at).toISOString()).toBe(
      `${autumn}T01:30:00.000Z`,
    );

    // An occurrence is an ordinary appointment: cancelling one leaves the other.
    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [done.appointmentIds[0]],
    );
    const after = await db.query(
      "select status from public.appointments where id = $1",
      [done.appointmentIds[1]],
    );
    expect(after.rows[0].status).toBe("confirmed");
  });

  it("creates nothing when a date was taken meanwhile, and names it", async () => {
    const tuesday = freshTuesday();
    const p = await ok<SeriesPreview>(
      preview(`${tuesday}T14:00:00`, { count: 3 }),
    );
    await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: p.occurrences[2]!.utcCandidates[0]!,
      endsAt: new Date(
        new Date(p.occurrences[2]!.utcCandidates[0]!).getTime() + 3_600_000,
      ).toISOString(),
    });
    const refused = await commit(p.previewVersion, all(p));
    expect(refused.error).toMatchObject({
      message: "calendar_conflict",
      details: "o3",
    });
    const { rows } = await db.query(
      "select count(*)::int as n from private.appointment_series where business_id = $1 and rule ->> 'firstLocalStart' = $2",
      [business.id, `${tuesday}T14:00:00`],
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses a changed price, an unknown preview, and a time the preview did not offer", async () => {
    const tuesday = freshTuesday();
    const p = await ok<SeriesPreview>(
      preview(`${tuesday}T16:00:00`, { count: 2 }),
    );

    expect((await commit(randomUUID(), all(p))).error?.message).toBe(
      "series_stale",
    );
    expect(
      (
        await commit(p.previewVersion, [
          { key: "o1", startsAt: `${tuesday}T08:00:00.000Z` },
        ])
      ).error?.message,
    ).toBe("series_stale");

    await db.query(
      "update public.services set price_cents = 5500 where id = $1",
      [service],
    );
    try {
      expect((await commit(p.previewVersion, all(p))).error?.message).toBe(
        "quote_changed",
      );
    } finally {
      await db.query(
        "update public.services set price_cents = 5000 where id = $1",
        [service],
      );
    }
  });
});

// Point 99: after the series, the professional changes it from her agenda,
// one date at a time, through the same functions as any appointment.
describe("changing a series from the agenda", () => {
  type Row = {
    id: string;
    starts_at: Date;
    status: string;
    version: number;
    series_id: string | null;
  };
  const rowsOf = async (ids: string[]) =>
    (
      await db.query<Row>(
        "select id, starts_at, status, version, series_id from public.appointments where id = any($1)",
        [ids],
      )
    ).rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  type Email = {
    id: string;
    appointment_id: string;
    type: string;
    status: string;
    scheduled_for: Date | null;
    starts_at: string;
  };
  const emailsOf = async (ids: string[]) =>
    (
      await db.query<Email>(
        "select id, appointment_id, type, status, scheduled_for, payload ->> 'starts_at' as starts_at from public.email_events where appointment_id = any($1)",
        [ids],
      )
    ).rows;

  it("moves one date and cancels another, and leaves the rest of the series as it was", async () => {
    const tuesday = freshTuesday();
    const p = await ok<SeriesPreview>(
      preview(`${tuesday}T10:00:00`, { count: 4 }),
    );
    const done = await ok<SeriesCommitted>(commit(p.previewVersion, all(p)));
    const ids = done.appointmentIds;
    expect(ids).toHaveLength(4);
    const [first, second, third, fourth] = ids as [
      string,
      string,
      string,
      string,
    ];

    // One reminder per date, each before its own date; nothing else.
    const queued = await emailsOf(ids);
    expect(queued.map((e) => [e.appointment_id, e.type, e.status])).toEqual(
      expect.arrayContaining(
        ids.map((id) => [id, "appointment_reminder", "pending"]),
      ),
    );
    expect(queued).toHaveLength(4);
    const before = await rowsOf(ids);

    // The second date, a day later (same time), from the agenda.
    const moved = new Date(before[1]!.starts_at.getTime() + 86_400_000);
    await ok(
      call(owner.client, "agenda_update_appointment", {
        p_business_id: business.id,
        p_appointment_id: second,
        p_expected_version: 1,
        p_service_id: service,
        p_client_id: clientId,
        p_starts_at: moved.toISOString(),
      }),
    );
    // The third, cancelled.
    await ok(
      call(owner.client, "agenda_set_appointment_status", {
        p_business_id: business.id,
        p_appointment_id: third,
        p_expected_version: 1,
        p_status: "cancelled",
      }),
    );

    const after = await rowsOf(ids);
    // Untouched: the first and the fourth, to the version.
    expect(after[0]).toEqual(before[0]);
    expect(after[3]).toEqual(before[3]);
    // Changed, and still part of the series.
    expect(after[1]).toMatchObject({
      status: "confirmed",
      version: 2,
      series_id: done.seriesId,
    });
    expect(after[1]!.starts_at.toISOString()).toBe(moved.toISOString());
    expect(after[2]).toMatchObject({
      status: "cancelled",
      series_id: done.seriesId,
    });

    // Reminders follow each date: the first and fourth keep theirs, the
    // moved one gets a new one for its new time, the cancelled one none.
    // She hears of nothing else: the professional entered these dates and
    // nothing has been sent about them yet.
    const emails = await emailsOf(ids);
    const pending = (id: string) =>
      emails.filter(
        (e) =>
          e.appointment_id === id &&
          e.type === "appointment_reminder" &&
          e.status === "pending",
      );
    const kept = (id: string) => queued.find((e) => e.appointment_id === id);
    expect(pending(first)).toEqual([kept(first)]);
    expect(pending(fourth)).toEqual([kept(fourth)]);
    expect(pending(second)).toHaveLength(1);
    expect(new Date(pending(second)[0]!.starts_at).toISOString()).toBe(
      moved.toISOString(),
    );
    expect(pending(third)).toEqual([]);
    expect(emails.filter((e) => e.type !== "appointment_reminder")).toEqual([]);

    // The dates freed in the agenda are free again; the others are not.
    const again = await ok<SeriesPreview>(
      preview(`${tuesday}T10:00:00`, { count: 4 }),
    );
    expect(again.occurrences.map((o) => o.state)).toEqual([
      "conflict",
      "available",
      "available",
      "conflict",
    ]);
  });

  it("is the owner's and admins': a practitioner cannot repeat an appointment", async () => {
    const member = await ok<TeamMemberDto>(
      call(owner.client, "create_staff_member", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_display_name: "Inès",
        p_bookable: true,
        p_service_ids: [service],
      }),
    );
    const ines = await createProfessional("series-practitioner");
    const token = generateTeamInviteToken();
    await ok(
      call(owner.client, "send_team_invitation", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_staff_id: member.id,
        p_expected_revision: member.revision,
        p_email: ines.email,
        p_role: "practitioner",
        p_token_hash: hashTeamInviteToken(token),
      }),
    );
    await ok(
      call(ines.client, "accept_team_invitation", {
        p_token_hash: hashTeamInviteToken(token),
      }),
    );

    const tuesday = freshTuesday();
    const asInes = await call(ines.client, "preview_appointment_series", {
      p_business_id: business.id,
      p_client_id: clientId,
      p_service_id: service,
      p_option_choice_ids: [],
      p_first_local_start: `${tuesday}T10:00:00`,
      p_repeat_every_weeks: 1,
      p_count: 2,
      p_until_local_date: null,
    });
    expect(asInes.error?.message).toBe("forbidden");

    // Nor confirm one the owner previewed.
    const p = await ok<SeriesPreview>(
      preview(`${tuesday}T10:00:00`, { count: 2 }),
    );
    const committed = await call(ines.client, "commit_appointment_series", {
      p_business_id: business.id,
      p_request_id: randomUUID(),
      p_preview_version: p.previewVersion,
      p_selected: all(p),
    });
    expect(committed.error?.message).toBe("forbidden");
    const { rows } = await db.query(
      "select count(*)::int as n from public.appointments where business_id = $1 and starts_at = any($2)",
      [business.id, all(p).map((o) => o.startsAt)],
    );
    expect(rows[0].n).toBe(0);
  });
});
