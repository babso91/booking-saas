import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade from the transactional emails (20261019090000) to the loyalty
// engine (20261020090000), with a populated database: a business whose
// program was created active by onboarding but never used, and a business
// with legacy ledger history (an award without generation, a manual
// adjustment, a redemption written by an earlier tool). Nothing existing is
// rewritten or lost; balances are unchanged; the legacy history keeps
// working with the new rules.

const BEFORE = "20261019090000";

let unused: TestBusiness;
let used: TestBusiness;
let customer: string;
let completedAppointment: string;
let reward: string;
let fixedReward: string;
let freeReward: string;
let redemption: string;
let ledgerBefore: string;
let rewardsBefore: string;

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

/** Every column the ledger had before the upgrade. */
async function ledgerHash() {
  const { rows } = await db.query(
    `select md5(string_agg(
       (e.id, e.business_id, e.client_id, e.appointment_id, e.type, e.points_delta,
        e.reason, e.idempotency_key, e.created_by, e.created_at)::text,
       '|' order by e.id)) as hash
     from public.loyalty_events e where e.business_id = $1`,
    [used.id],
  );
  return rows[0].hash as string;
}

async function rewardsHash() {
  const { rows } = await db.query(
    `select md5(string_agg(
       (w.id, w.name, w.description, w.points_required, w.reward_type, w.reward_value, w.active)::text,
       '|' order by w.id)) as hash
     from public.rewards w where w.business_id = $1`,
    [used.id],
  );
  return rows[0].hash as string;
}

async function balance() {
  const { rows } = await db.query(
    "select sum(points_delta)::int as balance from public.loyalty_events where client_id = $1",
    [customer],
  );
  return rows[0].balance as number;
}

describe("upgrade to the loyalty engine", () => {
  beforeAll(async () => {
    resetTo(BEFORE);

    const owner = await createProfessional("loyalty-upgrade");
    unused = await createBusiness(owner.userId);
    used = await createBusiness(owner.userId);
    // As onboarding created them before: active, 1 point per appointment.
    // The unused one was then edited directly (allowed before) beyond the
    // bounds this migration introduces.
    await db.query(
      "insert into public.loyalty_programs (business_id) values ($1), ($2)",
      [unused.id, used.id],
    );
    await db.query(
      `update public.loyalty_programs
       set points_per_completed_appointment = 50000
       where business_id = $1`,
      [unused.id],
    );

    const service = await createService(used.id, { priceCents: 5000 });
    customer = await createClientRecord(used.id, "legacy@x.test", "Ancienne");
    completedAppointment = await insertAppointment({
      businessId: used.id,
      clientId: customer,
      serviceId: service,
      startsAt: hoursAgo(50),
      endsAt: hoursAgo(49),
      status: "completed",
    });

    const { rows: award } = await db.query<{ id: string }>(
      `insert into public.loyalty_events
         (business_id, client_id, appointment_id, type, points_delta, reason, idempotency_key)
       values ($1, $2, $3, 'appointment_completed', 12, 'Rendez-vous', 'legacy-award')
       returning id`,
      [used.id, customer, completedAppointment],
    );
    expect(award).toHaveLength(1);
    // Written after the award but dated before it: the ledger order is
    // the order of the facts.
    await db.query(
      `insert into public.loyalty_events
         (business_id, client_id, type, points_delta, reason, idempotency_key, created_at)
       values ($1, $2, 'manual_adjustment', 20, 'Bienvenue', 'legacy-gift', now() - interval '60 days')`,
      [used.id, customer],
    );
    const { rows: rewardRows } = await db.query<{ id: string }>(
      `insert into public.rewards (business_id, name, points_required, reward_type, reward_value)
       values ($1, 'Remise historique', 10, 'percentage_discount', 10)
       returning id`,
      [used.id],
    );
    reward = rewardRows[0]!.id;
    const { rows: legacyRewards } = await db.query<{ id: string }>(
      `insert into public.rewards (business_id, name, points_required, reward_type, reward_value)
       values ($1, 'Bon de 5 €', 5, 'fixed_discount', 500),
              ($1, 'Soin offert', 5, 'free_service', null)
       returning id`,
      [used.id],
    );
    [fixedReward, freeReward] = legacyRewards.map((row) => row.id) as [
      string,
      string,
    ];
    const { rows: debit } = await db.query<{ id: string }>(
      `insert into public.loyalty_events
         (business_id, client_id, type, points_delta, reason, idempotency_key)
       values ($1, $2, 'reward_redeemed', -10, 'Remise', 'legacy-redeem')
       returning id`,
      [used.id, customer],
    );
    const { rows: redemptionRows } = await db.query<{ id: string }>(
      `insert into public.reward_redemptions
         (business_id, reward_id, client_id, loyalty_event_id, points_spent)
       values ($1, $2, $3, $4, 10)
       returning id`,
      [used.id, reward, customer, debit[0]!.id],
    );
    redemption = redemptionRows[0]!.id;

    ledgerBefore = await ledgerHash();
    rewardsBefore = await rewardsHash();
    expect(await balance()).toBe(22);

    migrateUp();
  });

  it("keeps every existing ledger entry, reward and balance as it was", async () => {
    expect(await ledgerHash()).toBe(ledgerBefore);
    expect(await rewardsHash()).toBe(rewardsBefore);
    expect(await balance()).toBe(22);
  });

  it("a never-used program becomes inactive (opt-in); a used one is kept", async () => {
    const { rows } = await db.query(
      `select business_id, active, version from public.loyalty_programs
       where business_id = any($1) order by business_id = $2`,
      [[unused.id, used.id], used.id],
    );
    expect(rows).toEqual([
      { business_id: unused.id, active: false, version: 2 },
      { business_id: used.id, active: true, version: 1 },
    ]);
  });

  it("legacy entries are classified: the award is generation 1, the redemption fulfilled with its snapshot", async () => {
    const { rows: awards } = await db.query(
      `select award_generation, details from public.loyalty_events
       where appointment_id = $1`,
      [completedAppointment],
    );
    expect(awards).toEqual([{ award_generation: 1, details: {} }]);

    const { rows } = await db.query(
      `select status, fulfilled_at = redeemed_at as fulfilled_then,
              reward_name_snapshot, reward_type_snapshot, reward_value_snapshot
       from public.reward_redemptions where id = $1`,
      [redemption],
    );
    expect(rows).toEqual([
      {
        status: "fulfilled",
        fulfilled_then: true,
        reward_name_snapshot: "Remise historique",
        reward_type_snapshot: "percentage_discount",
        reward_value_snapshot: 10,
      },
    ]);
  });

  it("a legacy award is reversed by a reopen and awarded again, once, by a new completion", async () => {
    await db.query(
      "update public.appointments set status = 'confirmed', completed_at = null where id = $1",
      [completedAppointment],
    );
    await db.query(
      "update public.appointments set status = 'completed', completed_at = now() where id = $1",
      [completedAppointment],
    );
    const { rows } = await db.query(
      `select type, points_delta, award_generation
       from public.loyalty_events where appointment_id = $1 order by ledger_seq`,
      [completedAppointment],
    );
    expect(rows).toEqual([
      { type: "appointment_completed", points_delta: 12, award_generation: 1 },
      { type: "correction", points_delta: -12, award_generation: null },
      // The program as configured now: 1 point per completed appointment.
      { type: "appointment_completed", points_delta: 1, award_generation: 2 },
    ]);
    expect(await balance()).toBe(11);
  });

  it("legacy ledger rows are now immutable", async () => {
    await expect(
      db.query(
        "update public.loyalty_events set points_delta = 1000 where business_id = $1",
        [used.id],
      ),
    ).rejects.toThrow("loyalty_ledger_immutable");
  });

  it("orders the legacy ledger by date: running balances never go through a false state", async () => {
    const { rows } = await db.query(
      `select reason, sum(points_delta) over (order by ledger_seq)::int as running
       from public.loyalty_events where client_id = $1 order by ledger_seq limit 3`,
      [customer],
    );
    expect(rows).toEqual([
      { reason: "Bienvenue", running: 20 },
      { reason: "Rendez-vous", running: 32 },
      { reason: "Remise", running: 22 },
    ]);
    // New entries come after every legacy one.
    const { rows: max } = await db.query(
      `select (select max(ledger_seq) from public.loyalty_events where idempotency_key like 'legacy%')
            < (select min(ledger_seq) from public.loyalty_events where idempotency_key like 'appointment:%') as after`,
    );
    expect(max[0].after).toBe(true);
  });

  it("legacy rewards stay usable: a fixed discount gets the business currency; a free service without service says so", async () => {
    const { rows } = await db.query(
      "select id, currency, service_id from public.rewards where id = any($1) order by name",
      [[fixedReward, freeReward]],
    );
    expect(rows).toEqual([
      { id: fixedReward, currency: "EUR", service_id: null },
      { id: freeReward, currency: null, service_id: null },
    ]);
  });

  it("an out-of-bounds legacy program did not block the upgrade, and is kept as it was", async () => {
    const { rows } = await db.query(
      "select active, points_per_completed_appointment from public.loyalty_programs where business_id = $1",
      [unused.id],
    );
    expect(rows).toEqual([
      { active: false, points_per_completed_appointment: 50000 },
    ]);
  });
});
