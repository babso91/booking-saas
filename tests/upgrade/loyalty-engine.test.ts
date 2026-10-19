import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
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
let owner: Professional;
let longText: string;
let hugePoints: string;
let longAndHuge: string;
let oddPercent: string;
let longFree: string;
let freeService: string;
let unawardedAppointment: string;
let legacyRedemptionsBefore: string;
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

/** Every column redemptions had before the upgrade. */
async function redemptionsHash() {
  const { rows } = await db.query(
    `select md5(string_agg(
       (r.id, r.business_id, r.reward_id, r.client_id, r.appointment_id,
        r.loyalty_event_id, r.points_spent, r.redeemed_at, r.created_by)::text,
       '|' order by r.id)) as hash
     from public.reward_redemptions r where r.business_id = $1`,
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

    owner = await createProfessional("loyalty-upgrade");
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
    // Values the previous schema accepted beyond the new bounds, and fixed
    // discounts without currency (the migration backfills it).
    freeService = await createService(used.id, { name: "Soin éphémère" });
    const { rows: outOfBounds } = await db.query<{ id: string }>(
      `insert into public.rewards
         (business_id, name, description, points_required, reward_type, reward_value)
       values ($1, 'Long texte', repeat('é', 1001), 10, 'fixed_discount', 700),
              ($1, 'Énorme', null, 2000000, 'fixed_discount', 900),
              ($1, 'Les deux', repeat('x', 1500), 3000000, 'fixed_discount', 20000000),
              ($1, 'Pourcentage', null, 10, 'percentage_discount', 150)
       returning id`,
      [used.id],
    );
    [longText, hugePoints, longAndHuge, oddPercent] = outOfBounds.map(
      (row) => row.id,
    ) as [string, string, string, string];
    const { rows: free } = await db.query<{ id: string }>(
      `insert into public.rewards
         (business_id, name, description, points_required, reward_type, reward_value)
       values ($1, 'Soin long', repeat('s', 1200), 5, 'free_service', null)
       returning id`,
      [used.id],
    );
    longFree = free[0]!.id;
    // A completion recorded without any award (program state unknowable).
    unawardedAppointment = await insertAppointment({
      businessId: used.id,
      clientId: customer,
      serviceId: service,
      startsAt: hoursAgo(80),
      endsAt: hoursAgo(79),
      status: "completed",
    });

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

    // A redemption of an out-of-bounds reward, too.
    const { rows: hugeDebit } = await db.query<{ id: string }>(
      `insert into public.loyalty_events
         (business_id, client_id, type, points_delta, reason, idempotency_key)
       values ($1, $2, 'manual_adjustment', 2000000, 'Cadeau', 'legacy-huge-gift'),
              ($1, $2, 'reward_redeemed', -2000000, 'Énorme', 'legacy-huge-redeem')
       returning id`,
      [used.id, customer],
    );
    await db.query(
      `insert into public.reward_redemptions
         (business_id, reward_id, client_id, loyalty_event_id, points_spent)
       values ($1, $2, $3, $4, 2000000)`,
      [used.id, hugePoints, customer, hugeDebit[1]!.id],
    );
    legacyRedemptionsBefore = await redemptionsHash();

    ledgerBefore = await ledgerHash();
    rewardsBefore = await rewardsHash();
    expect(await balance()).toBe(22);

    migrateUp();
  });

  it("keeps every existing ledger entry, reward and balance as it was", async () => {
    expect(await ledgerHash()).toBe(ledgerBefore);
    expect(await rewardsHash()).toBe(rewardsBefore);
    expect(await redemptionsHash()).toBe(legacyRedemptionsBefore);
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

  it("out-of-bounds legacy rewards survive whole: long descriptions, huge points, both; fixed ones get their currency", async () => {
    const { rows } = await db.query(
      `select id, char_length(description) as length, points_required, reward_value, currency
       from public.rewards where id = any($1) order by points_required, id`,
      [[longText, hugePoints, longAndHuge, oddPercent]],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: longText,
          length: 1001,
          points_required: 10,
          reward_value: 700,
          currency: "EUR",
        },
        {
          id: hugePoints,
          length: null,
          points_required: 2000000,
          reward_value: 900,
          currency: "EUR",
        },
        {
          id: longAndHuge,
          length: 1500,
          points_required: 3000000,
          reward_value: 20000000,
          currency: "EUR",
        },
        {
          id: oddPercent,
          length: null,
          points_required: 10,
          reward_value: 150,
          currency: null,
        },
      ]),
    );
    const { rows: redeemed } = await db.query(
      `select r.reward_id, r.points_spent, r.status, r.reward_name_snapshot
       from public.reward_redemptions r where r.reward_id = $1`,
      [hugePoints],
    );
    expect(redeemed).toEqual([
      {
        reward_id: hugePoints,
        points_spent: 2000000,
        status: "fulfilled",
        reward_name_snapshot: "Énorme",
      },
    ]);
  });

  it("a grandfathered reward can be edited keeping its historical values; a new out-of-bounds value is refused; normalising works", async () => {
    const { rows } = await db.query(
      "select name, description, points_required, reward_value, version from public.rewards where id = $1",
      [longAndHuge],
    );
    const legacy = rows[0];
    const edit = (fields: Record<string, unknown>, version: number) =>
      owner.client.rpc("loyalty_update_reward", {
        p_business_id: used.id,
        p_reward_id: longAndHuge,
        p_expected_version: version,
        p_name: legacy.name,
        p_description: legacy.description,
        p_points_required: legacy.points_required,
        p_reward_value: legacy.reward_value,
        p_service_id: null as unknown as string,
        p_active: true,
        ...fields,
      });

    // Deactivate, keeping every historical value.
    const kept = await edit({ p_active: false }, legacy.version);
    expect(kept.error).toBeNull();
    const after = await db.query(
      "select description, points_required, reward_value, active, version from public.rewards where id = $1",
      [longAndHuge],
    );
    expect(after.rows[0]).toEqual({
      description: legacy.description,
      points_required: 3000000,
      reward_value: 20000000,
      active: false,
      version: kept.data,
    });

    // A different out-of-bounds value: refused, field by field.
    for (const [fields, hint] of [
      [{ p_description: "y".repeat(1001) }, "description"],
      [{ p_points_required: 3000001 }, "pointsRequired"],
      [{ p_reward_value: 20000001 }, "rewardValue"],
    ] as const) {
      const refused = await edit(fields, kept.data!);
      expect(refused.error).toMatchObject({ message: "invalid_input", hint });
    }

    // Normalised: accepted, and bounded from then on.
    const normalised = await edit(
      { p_description: "Court", p_points_required: 500, p_reward_value: 1000 },
      kept.data!,
    );
    expect(normalised.error).toBeNull();
    const back = await edit(
      {
        p_description: legacy.description,
        p_points_required: 500,
        p_reward_value: 1000,
      },
      normalised.data!,
    );
    expect(back.error).toMatchObject({
      message: "invalid_input",
      hint: "description",
    });
  });

  it("deleting the service of a grandfathered free-service reward still works (its foreign key action)", async () => {
    await db.query("update public.rewards set service_id = $2 where id = $1", [
      longFree,
      freeService,
    ]);
    await db.query("delete from public.services where id = $1", [freeService]);
    const { rows } = await db.query(
      "select service_id, char_length(description) as length from public.rewards where id = $1",
      [longFree],
    );
    expect(rows).toEqual([{ service_id: null, length: 1200 }]);
  });

  it("an appointment completed before the upgrade without points is never awarded retroactively", async () => {
    await db.query(
      "update public.appointments set status = 'confirmed', completed_at = null where id = $1",
      [unawardedAppointment],
    );
    await db.query(
      "update public.appointments set status = 'completed', completed_at = now() where id = $1",
      [unawardedAppointment],
    );
    const { rows } = await db.query(
      "select count(*)::int as n from public.loyalty_events where appointment_id = $1",
      [unawardedAppointment],
    );
    expect(rows[0].n).toBe(0);
    // Manual credit stays possible.
    const credit = await owner.client.rpc("loyalty_adjust_points", {
      p_business_id: used.id,
      p_client_id: customer,
      p_request_id: randomUUID(),
      p_points_delta: 1,
      p_reason: "Visite historique",
    });
    expect(credit.error).toBeNull();
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
