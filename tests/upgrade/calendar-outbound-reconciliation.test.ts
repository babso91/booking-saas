import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade of a populated database from the outbound core (20261010090000)
// to backfill and reconciliation (20261011090000): existing mirrors keep
// their state and nothing becomes due; the migration itself enrolls no
// appointment (the backfill does, later, bounded, future ones only).

const OUTBOUND_CORE = "20261010090000";
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

let businessId: string;
const ids: Record<"unmirrored" | "ended" | "cancelled" | "mirrored", string> = {
  unmirrored: "",
  ended: "",
  cancelled: "",
  mirrored: "",
};

const inDays = (days: number, hour: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

beforeAll(async () => {
  resetTo(OUTBOUND_CORE);
  // Data at the schema of the outbound core.
  const owner = await createProfessional("upgrade-outbound");
  const business = await createBusiness(owner.userId, { timezone: "UTC" });
  businessId = business.id;
  const service = await createService(businessId, {
    name: "Coupe",
    durationMinutes: 60,
  });
  const client = await createClientRecord(businessId, "c@client.test", "Léa");
  const appointment = (days: number, hour: number, status?: "cancelled") =>
    insertAppointment({
      businessId,
      clientId: client,
      serviceId: service,
      startsAt: inDays(days, hour),
      endsAt: inDays(days, hour + 1),
      status,
    });

  // Before outbound existed for this business: never enrolled.
  ids.unmirrored = await appointment(5, 9);
  ids.ended = await appointment(-5, 9);
  ids.cancelled = await appointment(6, 9, "cancelled");

  const { rows: connection } = await db.query<{ id: string }>(
    `insert into public.calendar_connections (business_id, provider, provider_account_id, account_email, scopes)
     values ($1, 'google', $2, 'x@gmail.test', $3) returning id`,
    [businessId, `sub-${randomUUID()}`, [WRITE_SCOPE]],
  );
  await db.query(
    `insert into private.calendar_outbound
       (business_id, connection_id, provider_account_id, status, provider_calendar_id, enabled_at)
     select $1, c.id, c.provider_account_id, 'active', 'cal-dedicated', now()
     from public.calendar_connections c where c.id = $2`,
    [businessId, connection[0]!.id],
  );
  // Enrolled by the trigger, then applied by a worker.
  ids.mirrored = await appointment(7, 9);
  await db.query(
    `update private.appointment_calendar_mirrors
     set applied_revision = desired_revision, provider_calendar_id = 'cal-dedicated'
     where appointment_id = $1`,
    [ids.mirrored],
  );

  migrateUp();
});

async function mirrors() {
  const { rows } = await db.query(
    "select * from private.appointment_calendar_mirrors where business_id = $1 order by created_at",
    [businessId],
  );
  return rows as {
    appointment_id: string;
    desired_revision: string;
    applied_revision: string;
    repair_generation: string;
    repaired_generation: string;
    applied_at: Date | null;
    seen_scan: string | null;
  }[];
}

describe("upgrading a database with outbound mirrors", () => {
  it("keeps every mirror's state, nothing due, nothing enrolled by the migration", async () => {
    const rows = await mirrors();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appointment_id: ids.mirrored,
      desired_revision: "1",
      applied_revision: "1",
      repair_generation: "0",
      repaired_generation: "0",
      applied_at: null,
      seen_scan: null,
    });
    const { rows: status } = await db.query(
      "select private.outbound_status($1) as status",
      [businessId],
    );
    expect(status[0].status).toMatchObject({ pendingCount: 0, errorCount: 0 });
    const { rows: recon } = await db.query(
      "select count(*)::int as n from private.calendar_outbound_reconciliation",
    );
    expect(recon[0].n).toBe(0);
    const { rows: outbound } = await db.query(
      "select backfill_next_at from private.calendar_outbound where business_id = $1",
      [businessId],
    );
    expect(outbound[0].backfill_next_at).toBeNull();
  });

  it("indexes: due mirrors include repairs; the backfill reads not-cancelled appointments by end", async () => {
    const { rows } = await db.query<{ name: string; definition: string }>(
      `select indexname as name, indexdef as definition from pg_indexes
       where indexname in ('appointment_calendar_mirrors_due_idx', 'appointments_outbound_backfill_idx')
       order by 1`,
    );
    expect(rows.map((row) => row.name)).toEqual([
      "appointment_calendar_mirrors_due_idx",
      "appointments_outbound_backfill_idx",
    ]);
    expect(rows[0]!.definition).toMatch(
      /repair_generation > repaired_generation/,
    );
    expect(rows[1]!.definition).toMatch(/\(business_id, ends_at\)/);
  });

  it("the first backfill enrolls the future, never enrolled, not cancelled appointment only", async () => {
    const { rows } = await db.query(
      "select public.calendar_outbound_backfill(50, 100) as result",
    );
    expect(rows[0].result).toMatchObject({ enrolled: 1 });
    const enrolled = (await mirrors()).map((row) => row.appointment_id);
    expect(enrolled.sort()).toEqual([ids.mirrored, ids.unmirrored].sort());
    expect(enrolled).not.toContain(ids.ended);
    expect(enrolled).not.toContain(ids.cancelled);
  });

  it("the writer's former call still completes a mirror (repair generation defaults to none)", async () => {
    const { rows } = await db.query(
      "select public.calendar_outbound_claim_mirrors(10, $1, 10) as claims",
      [businessId],
    );
    const claims = rows[0].claims as {
      appointmentId: string;
      claimId: string;
      revision: number;
      repair: boolean;
    }[];
    expect(claims.map((claim) => claim.appointmentId)).toEqual([
      ids.unmirrored,
    ]);
    expect(claims[0]!.repair).toBe(false);
    const { rows: done } = await db.query(
      "select public.calendar_outbound_complete_mirror($1, $2, $3) as done",
      [claims[0]!.appointmentId, claims[0]!.claimId, claims[0]!.revision],
    );
    expect(done[0].done).toBe("applied");
    const row = (await mirrors()).find(
      (item) => item.appointment_id === ids.unmirrored,
    )!;
    expect(row.applied_revision).toBe("1");
    expect(row.applied_at).not.toBeNull();
  });

  it("reconciliation starts with a full scan of the current dedicated calendar", async () => {
    const { rows } = await db.query(
      "select public.calendar_outbound_claim_reconciliation('{}') as claim",
    );
    expect(rows[0].claim).toMatchObject({
      businessId,
      calendarId: "cal-dedicated",
      mode: "full",
      syncToken: null,
      pageToken: null,
    });
  });
});
