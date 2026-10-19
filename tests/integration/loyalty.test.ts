import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { setAppointmentStatusAction } from "@/features/agenda/actions/agenda";
import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { listClientTimelineAction } from "@/features/crm/actions/crm";
import {
  adjustPointsAction,
  cancelRedemptionAction,
  configureLoyaltyProgramAction,
  createRewardAction,
  fulfilRedemptionAction,
  getClientLoyaltyAction,
  getLoyaltyProgramAction,
  listClientLoyaltyLedgerAction,
  listClientRedemptionsAction,
  listLoyaltyBalancesAction,
  listRewardsAction,
  redeemRewardAction,
  reverseAdjustmentAction,
  setLoyaltyServiceRuleAction,
  updateRewardAction,
} from "@/features/loyalty/actions/loyalty";
import type { RewardDto } from "@/features/loyalty/types";
import type { ActionResult, AppErrorCode } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  anonClient,
  bookingClient,
  bookingRequest,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  insertAppointment,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
} from "./support/transactions";

// Loyalty engine V1 against the real stack (20261020090000_loyalty_engine).
// The Server Actions are called as the UI will call them; only the
// cookie-based Supabase client is replaced by a client signed in as the test
// professional (or anonymous). Concurrency is exercised with real
// transactions interleaved deterministically.

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

function failure<T>(result: ActionResult<T>, code: AppErrorCode) {
  expect(result).toMatchObject({ ok: false, error: { code } });
  return result.ok ? undefined : result.error;
}

type Shop = {
  owner: Professional;
  business: TestBusiness;
  /** 45,50 € */
  coupe: string;
  /** 80,00 € */
  couleur: string;
  client: string;
};

/** Hours ago, as an ISO instant (a started appointment can be completed). */
function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

let slot = 0;

/** A confirmed appointment in the past (one free hour each time). */
async function pastAppointment(
  shop: Shop,
  service: string,
  client = shop.client,
) {
  slot += 2;
  return insertAppointment({
    businessId: shop.business.id,
    clientId: client,
    serviceId: service,
    startsAt: hoursAgo(slot + 1),
    endsAt: hoursAgo(slot),
  });
}

async function version(appointmentId: string) {
  const { rows } = await db.query<{ version: number }>(
    "select version from public.appointments where id = $1",
    [appointmentId],
  );
  return rows[0]!.version;
}

/** The agenda's status change: the trusted business-side event. */
async function setStatus(
  appointmentId: string,
  status: "completed" | "confirmed" | "cancelled" | "no_show",
) {
  return setAppointmentStatusAction({
    appointmentId,
    expectedVersion: await version(appointmentId),
    status,
  });
}

async function complete(appointmentId: string) {
  return ok(await setStatus(appointmentId, "completed"));
}

async function entries(clientId: string) {
  const { rows } = await db.query<{
    id: string;
    type: string;
    points_delta: number;
    appointment_id: string | null;
    award_generation: number | null;
    reverses_event_id: string | null;
  }>(
    `select id, type, points_delta, appointment_id, award_generation, reverses_event_id
     from public.loyalty_events where client_id = $1 order by ledger_seq`,
    [clientId],
  );
  return rows;
}

async function balance(clientId: string) {
  const { rows } = await db.query<{ balance: string }>(
    "select coalesce(sum(points_delta), 0) as balance from public.loyalty_events where client_id = $1",
    [clientId],
  );
  return Number(rows[0]!.balance);
}

async function program(
  shop: Shop,
  settings: {
    active?: boolean;
    accrualMode?: "appointment" | "spend";
    pointsPerCompletedAppointment?: number;
    pointsPerEuro?: string | null;
  },
) {
  as(shop.owner);
  const current = ok(await getLoyaltyProgramAction());
  return ok(
    await configureLoyaltyProgramAction({
      expectedVersion: current.version,
      active: settings.active ?? true,
      accrualMode: settings.accrualMode ?? "appointment",
      pointsPerCompletedAppointment:
        settings.pointsPerCompletedAppointment ?? 10,
      pointsPerEuro: settings.pointsPerEuro ?? null,
    }),
  );
}

async function newShop(label = "fidelite"): Promise<Shop> {
  const owner = await createProfessional(label);
  const business = await createBusiness(owner.userId);
  await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
  const coupe = await createService(business.id, {
    name: "Coupe",
    priceCents: 4550,
  });
  const couleur = await createService(business.id, {
    name: "Couleur",
    priceCents: 8000,
  });
  const client = await createClientRecord(
    business.id,
    `lea-${randomUUID().slice(0, 8)}@x.test`,
    "Léa",
  );
  const shop = { owner, business, coupe, couleur, client };
  await program(shop, { active: true, pointsPerCompletedAppointment: 10 });
  return shop;
}

async function reward(
  shop: Shop,
  fields: Partial<{
    name: string;
    pointsRequired: number;
    rewardType: "percentage_discount" | "fixed_discount" | "free_service";
    rewardValue: number | null;
    serviceId: string | null;
    active: boolean;
  }> = {},
): Promise<RewardDto> {
  as(shop.owner);
  return ok(
    await createRewardAction({
      requestId: randomUUID(),
      name: fields.name ?? "Remise 5 €",
      description: null,
      pointsRequired: fields.pointsRequired ?? 10,
      rewardType: fields.rewardType ?? "fixed_discount",
      rewardValue: fields.rewardValue === undefined ? 500 : fields.rewardValue,
      serviceId: fields.serviceId ?? null,
      active: fields.active ?? true,
    }),
  );
}

/** Credits points through the trusted path: completed appointments. */
async function earn(shop: Shop, times: number, client = shop.client) {
  as(shop.owner);
  for (let i = 0; i < times; i += 1) {
    await complete(await pastAppointment(shop, shop.coupe, client));
  }
}

// ---------------------------------------------------------------------------

describe("program configuration", () => {
  it("a business without a program reads an inactive default and creates it from version 0", async () => {
    const owner = await createProfessional("prog");
    const business = await createBusiness(owner.userId);
    await db.query(
      "delete from public.loyalty_programs where business_id = $1",
      [business.id],
    );
    as(owner);

    expect(ok(await getLoyaltyProgramAction())).toEqual({
      active: false,
      accrualMode: "appointment",
      pointsPerCompletedAppointment: 1,
      pointsPerEuro: null,
      version: 0,
      serviceRules: [],
    });

    const created = ok(
      await configureLoyaltyProgramAction({
        expectedVersion: 0,
        active: true,
        accrualMode: "spend",
        pointsPerCompletedAppointment: 1,
        pointsPerEuro: "2.5",
      }),
    );
    expect(created).toMatchObject({
      active: true,
      accrualMode: "spend",
      pointsPerEuro: "2.5",
      version: 1,
    });

    // A second "create" from the same stale read is refused.
    failure(
      await configureLoyaltyProgramAction({
        expectedVersion: 0,
        active: false,
        accrualMode: "appointment",
        pointsPerCompletedAppointment: 3,
      }),
      "stale_loyalty_program",
    );
  });

  it("is versioned: a stale save is refused, a retried save succeeds", async () => {
    const shop = await newShop();
    as(shop.owner);
    const read = ok(await getLoyaltyProgramAction());

    const saved = ok(
      await configureLoyaltyProgramAction({
        expectedVersion: read.version,
        active: true,
        accrualMode: "appointment",
        pointsPerCompletedAppointment: 7,
      }),
    );
    expect(saved.version).toBe(read.version + 1);

    // The same values again, from the old read (a lost answer): success.
    expect(
      ok(
        await configureLoyaltyProgramAction({
          expectedVersion: read.version,
          active: true,
          accrualMode: "appointment",
          pointsPerCompletedAppointment: 7,
        }),
      ).version,
    ).toBe(saved.version);

    // Other values from the old read: refused, nothing written.
    failure(
      await configureLoyaltyProgramAction({
        expectedVersion: read.version,
        active: false,
        accrualMode: "appointment",
        pointsPerCompletedAppointment: 7,
      }),
      "stale_loyalty_program",
    );
    expect(ok(await getLoyaltyProgramAction())).toMatchObject({
      active: true,
      pointsPerCompletedAppointment: 7,
    });
  });

  it("validates every field, in the Server Action and in PostgreSQL", async () => {
    const shop = await newShop();
    as(shop.owner);
    const { version: v } = ok(await getLoyaltyProgramAction());

    for (const input of [
      { accrualMode: "spend", pointsPerEuro: null },
      { accrualMode: "spend", pointsPerEuro: "0.001" },
      { accrualMode: "spend", pointsPerEuro: "100.5" },
      { accrualMode: "spend", pointsPerEuro: "1e2" },
      { accrualMode: "appointment", pointsPerEuro: "1" },
      { accrualMode: "appointment", pointsPerCompletedAppointment: 0 },
      { accrualMode: "appointment", pointsPerCompletedAppointment: 1.5 },
    ]) {
      failure(
        await configureLoyaltyProgramAction({
          expectedVersion: v,
          active: true,
          pointsPerCompletedAppointment: 1,
          ...input,
        }),
        "validation_error",
      );
    }

    // The database refuses what the action would never send.
    for (const [mode, perAppointment, perEuro] of [
      ["spend", 1, 0.00001],
      ["spend", 1, 101],
      ["appointment", 1, 2],
      ["appointment", 10001, null],
    ] as const) {
      const { error } = await shop.owner.client.rpc(
        "loyalty_configure_program",
        {
          p_business_id: shop.business.id,
          p_expected_version: v,
          p_active: true,
          p_accrual_mode: mode,
          p_points_per_completed_appointment: perAppointment,
          p_points_per_euro: perEuro as number,
        },
      );
      expect(error?.message).toBe("invalid_input");
    }
  });

  it("service rules: set, change, remove; only for this business's services", async () => {
    const shop = await newShop();
    const other = await newShop("autre");
    as(shop.owner);

    ok(
      await setLoyaltyServiceRuleAction({
        serviceId: shop.couleur,
        points: 25,
      }),
    );
    ok(await setLoyaltyServiceRuleAction({ serviceId: shop.coupe, points: 0 }));
    ok(
      await setLoyaltyServiceRuleAction({
        serviceId: shop.couleur,
        points: 30,
      }),
    );
    expect(ok(await getLoyaltyProgramAction()).serviceRules).toEqual(
      expect.arrayContaining([
        { serviceId: shop.couleur, points: 30 },
        { serviceId: shop.coupe, points: 0 },
      ]),
    );

    ok(
      await setLoyaltyServiceRuleAction({
        serviceId: shop.coupe,
        points: null,
      }),
    );
    expect(ok(await getLoyaltyProgramAction()).serviceRules).toEqual([
      { serviceId: shop.couleur, points: 30 },
    ]);

    failure(
      await setLoyaltyServiceRuleAction({ serviceId: other.coupe, points: 5 }),
      "service_not_found",
    );
    failure(
      await setLoyaltyServiceRuleAction({
        serviceId: shop.coupe,
        points: 10_001,
      }),
      "validation_error",
    );
  });

  it("onboarding creates an inactive program: earning is opt-in", async () => {
    const owner = await createProfessional("optin");
    const { error } = await owner.client.rpc("complete_onboarding", {
      p_first_name: "Camille",
      p_last_name: "B",
      p_business_name: "Studio opt-in",
      p_slug: `optin-${randomUUID().slice(0, 8)}`,
    });
    expect(error).toBeNull();
    const { rows } = await db.query(
      `select l.active from public.loyalty_programs l
       join public.businesses b on b.id = l.business_id where b.created_by = $1`,
      [owner.userId],
    );
    expect(rows).toEqual([{ active: false }]);
  });
});

// ---------------------------------------------------------------------------

describe("earning", () => {
  let shop: Shop;

  beforeAll(async () => {
    shop = await newShop();
  });

  it("a public booking alone never awards points, even once its time has passed", async () => {
    const day = dateInDays(5);
    const booking = await createPublicBooking(
      bookingClient(),
      bookingRequest({
        slug: shop.business.slug,
        serviceId: shop.coupe,
        startsAt: `${day}T10:00:00.000Z`,
        firstName: "Inès",
        email: `ines-${randomUUID().slice(0, 6)}@x.test`,
      }),
      randomIp(),
    );
    const { rows } = await db.query<{ client_id: string }>(
      "select client_id from public.appointments where id = $1",
      [booking.appointmentId],
    );
    const customer = rows[0]!.client_id;
    expect(await entries(customer)).toEqual([]);

    // The appointment's time passes; it is still only booked.
    await db.query(
      `update public.appointments
       set starts_at = $2, ends_at = $3 where id = $1`,
      [booking.appointmentId, hoursAgo(3000), hoursAgo(2999)],
    );
    expect(await entries(customer)).toEqual([]);

    // Only the professional's completion awards.
    as(shop.owner);
    await complete(booking.appointmentId);
    expect(await entries(customer)).toMatchObject([
      { type: "appointment_completed", points_delta: 10 },
    ]);
  });

  it("cancelled and no-show appointments earn nothing", async () => {
    const client = await createClientRecord(
      shop.business.id,
      `c-${randomUUID()}@x.test`,
    );
    as(shop.owner);
    ok(
      await setStatus(
        await pastAppointment(shop, shop.coupe, client),
        "cancelled",
      ),
    );
    ok(
      await setStatus(
        await pastAppointment(shop, shop.coupe, client),
        "no_show",
      ),
    );
    expect(await entries(client)).toEqual([]);
  });

  it("a no-show corrected to completed earns once", async () => {
    const client = await createClientRecord(
      shop.business.id,
      `n-${randomUUID()}@x.test`,
    );
    as(shop.owner);
    const appointment = await pastAppointment(shop, shop.coupe, client);
    ok(await setStatus(appointment, "no_show"));
    await complete(appointment);
    expect(await entries(client)).toMatchObject([
      { type: "appointment_completed", points_delta: 10, award_generation: 1 },
    ]);
  });

  it("a duplicate completion (double submit, retry) awards once", async () => {
    const client = await createClientRecord(
      shop.business.id,
      `d-${randomUUID()}@x.test`,
    );
    as(shop.owner);
    const appointment = await pastAppointment(shop, shop.coupe, client);
    const v = await version(appointment);
    for (let i = 0; i < 3; i += 1) {
      ok(
        await setAppointmentStatusAction({
          appointmentId: appointment,
          expectedVersion: v,
          status: "completed",
        }),
      );
    }
    expect(await entries(client)).toHaveLength(1);
    expect(await balance(client)).toBe(10);
  });

  it("concurrent completions of one appointment award once", async () => {
    const client = await createClientRecord(
      shop.business.id,
      `k-${randomUUID()}@x.test`,
    );
    const appointment = await pastAppointment(shop, shop.coupe, client);
    const v = await version(appointment);
    const first = await openTransaction({
      role: "authenticated",
      userId: shop.owner.userId,
    });
    const second = await openTransaction({
      role: "authenticated",
      userId: shop.owner.userId,
    });
    const call = `select public.agenda_set_appointment_status($1, $2, $3, 'completed')`;
    await first.connection.query(call, [shop.business.id, appointment, v]);
    const pending = outcome(
      second.connection.query(call, [shop.business.id, appointment, v]),
    );
    await waitUntilBlocked(second.pid);
    await closeTransaction(first, "commit");
    expect(await pending).toBe("ok");
    await closeTransaction(second, "commit");
    expect(await entries(client)).toHaveLength(1);

    // And through the API, many at once.
    const other = await createClientRecord(
      shop.business.id,
      `m-${randomUUID()}@x.test`,
    );
    const many = await pastAppointment(shop, shop.coupe, other);
    const mv = await version(many);
    as(shop.owner);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        setAppointmentStatusAction({
          appointmentId: many,
          expectedVersion: mv,
          status: "completed",
        }),
      ),
    );
    expect(await entries(other)).toHaveLength(1);
  });

  it("uses the appointment's price snapshot, not the service's current price (spend mode, exact)", async () => {
    const spend = await newShop("spend");
    await program(spend, { accrualMode: "spend", pointsPerEuro: "1.5" });
    const appointment = await pastAppointment(spend, spend.coupe);
    // The service becomes more expensive after the booking.
    await db.query(
      "update public.services set price_cents = 99900 where id = $1",
      [spend.coupe],
    );
    as(spend.owner);
    await complete(appointment);
    // floor(4550 × 1.5 / 100) = floor(68.25) = 68
    const [award] = await entries(spend.client);
    expect(award).toMatchObject({ points_delta: 68 });
    const { rows } = await db.query(
      "select details from public.loyalty_events where id = $1",
      [award!.id],
    );
    expect(rows[0].details).toMatchObject({
      accrualMode: "spend",
      pointsPerEuro: "1.5000",
      priceCents: 4550,
      currency: "EUR",
    });
  });

  it("no floating point: 0.1 point per euro on 30 € is exactly 3", async () => {
    const spend = await newShop("float");
    await program(spend, { accrualMode: "spend", pointsPerEuro: "0.1" });
    const service = await createService(spend.business.id, {
      priceCents: 3000,
    });
    as(spend.owner);
    await complete(await pastAppointment(spend, service));
    expect(await entries(spend.client)).toMatchObject([{ points_delta: 3 }]);
  });

  it("service rules override the program; 0 earns nothing", async () => {
    const ruled = await newShop("rules");
    as(ruled.owner);
    ok(
      await setLoyaltyServiceRuleAction({
        serviceId: ruled.couleur,
        points: 25,
      }),
    );
    ok(
      await setLoyaltyServiceRuleAction({ serviceId: ruled.coupe, points: 0 }),
    );
    await complete(await pastAppointment(ruled, ruled.couleur));
    await complete(await pastAppointment(ruled, ruled.coupe));
    expect(await entries(ruled.client)).toMatchObject([{ points_delta: 25 }]);
  });

  it("an inactive program earns nothing, and activation is not retroactive", async () => {
    const off = await newShop("off");
    await program(off, { active: false });
    as(off.owner);
    const before = await pastAppointment(off, off.coupe);
    await complete(before);
    expect(await entries(off.client)).toEqual([]);

    await program(off, { active: true });
    // A later completion earns; the earlier one is not revisited.
    await complete(await pastAppointment(off, off.coupe));
    expect(await entries(off.client)).toHaveLength(1);
  });

  it("reopening reverses with a compensating entry; completing again awards a new generation", async () => {
    const client = await createClientRecord(
      shop.business.id,
      `r-${randomUUID()}@x.test`,
    );
    as(shop.owner);
    const appointment = await pastAppointment(shop, shop.coupe, client);
    await complete(appointment);
    ok(await setStatus(appointment, "confirmed"));
    expect(await balance(client)).toBe(0);

    // Another service before completing again: the new snapshot counts.
    await db.query(
      "insert into public.loyalty_service_rules (business_id, service_id, points) values ($1, $2, 40)",
      [shop.business.id, shop.couleur],
    );
    as(shop.owner);
    const { updateAppointmentAction } =
      await import("@/features/agenda/actions/agenda");
    ok(
      await updateAppointmentAction({
        appointmentId: appointment,
        expectedVersion: await version(appointment),
        serviceId: shop.couleur,
        clientId: client,
      }),
    );
    await complete(appointment);

    const ledger = await entries(client);
    expect(ledger).toMatchObject([
      { type: "appointment_completed", points_delta: 10, award_generation: 1 },
      {
        type: "correction",
        points_delta: -10,
        reverses_event_id: ledger[0]!.id,
      },
      { type: "appointment_completed", points_delta: 40, award_generation: 2 },
    ]);
    expect(await balance(client)).toBe(40);
    await db.query(
      "delete from public.loyalty_service_rules where business_id = $1",
      [shop.business.id],
    );
  });

  it("a reversal is recorded even when the points were already spent (balance goes negative, honestly)", async () => {
    const client = await createClientRecord(
      shop.business.id,
      `s-${randomUUID()}@x.test`,
    );
    const gift = await reward(shop, { pointsRequired: 10 });
    as(shop.owner);
    const appointment = await pastAppointment(shop, shop.coupe, client);
    await complete(appointment);
    ok(
      await redeemRewardAction({
        clientId: client,
        rewardId: gift.id,
        requestId: randomUUID(),
      }),
    );
    ok(await setStatus(appointment, "confirmed"));

    expect(await balance(client)).toBe(-10);
    expect(ok(await getClientLoyaltyAction({ clientId: client })).balance).toBe(
      -10,
    );
    // Nothing more can be spent until the balance is positive again.
    failure(
      await redeemRewardAction({
        clientId: client,
        rewardId: gift.id,
        requestId: randomUUID(),
      }),
      "insufficient_points",
    );
    failure(
      await adjustPointsAction({
        clientId: client,
        requestId: randomUUID(),
        pointsDelta: -1,
        reason: "Test",
      }),
      "insufficient_points",
    );
  });

  it("a completed appointment with standing points keeps its customer, service and price", async () => {
    const client = await createClientRecord(
      shop.business.id,
      `f-${randomUUID()}@x.test`,
    );
    const other = await createClientRecord(
      shop.business.id,
      `g-${randomUUID()}@x.test`,
    );
    as(shop.owner);
    const appointment = await pastAppointment(shop, shop.coupe, client);
    await complete(appointment);

    for (const set of [
      ["client_id = $2", other],
      ["price_cents_snapshot = $2", 1],
      ["service_id = $2", shop.couleur],
    ] as const) {
      await expect(
        db.query(`update public.appointments set ${set[0]} where id = $1`, [
          appointment,
          set[1],
        ]),
      ).rejects.toThrow("appointment_not_editable");
    }
    expect(await entries(other)).toEqual([]);
  });

  it("CRM timeline shows the award and its reversal (regression)", async () => {
    const client = await createClientRecord(
      shop.business.id,
      `t-${randomUUID()}@x.test`,
    );
    as(shop.owner);
    const appointment = await pastAppointment(shop, shop.coupe, client);
    await complete(appointment);
    ok(await setStatus(appointment, "confirmed"));
    const timeline = ok(await listClientTimelineAction({ clientId: client }));
    const deltas = timeline.events.flatMap((event) =>
      event.kind === "loyalty" ? [event.entry.pointsDelta] : [],
    );
    expect(deltas.sort((x, y) => x - y)).toEqual([-10, 10]);
  });
});

// ---------------------------------------------------------------------------

describe("ledger integrity", () => {
  it("entries are immutable and cannot be deleted, even by a privileged role", async () => {
    const shop = await newShop();
    as(shop.owner);
    await earn(shop, 1);
    const [entry] = await entries(shop.client);

    await expect(
      db.query(
        "update public.loyalty_events set points_delta = 999 where id = $1",
        [entry!.id],
      ),
    ).rejects.toThrow("loyalty_ledger_immutable");
    await expect(
      db.query("delete from public.loyalty_events where id = $1", [entry!.id]),
    ).rejects.toThrow("loyalty_ledger_immutable");
    expect(await balance(shop.client)).toBe(10);
  });

  it("a reversal must exactly compensate its target, once", async () => {
    const shop = await newShop();
    const other = await createClientRecord(
      shop.business.id,
      `o-${randomUUID()}@x.test`,
    );
    as(shop.owner);
    await earn(shop, 1);
    const [entry] = await entries(shop.client);
    const insert = (client: string, delta: number, key: string) =>
      db.query(
        `insert into public.loyalty_events
           (business_id, client_id, type, points_delta, reason, idempotency_key, reverses_event_id)
         values ($1, $2, 'correction', $3, 'x', $4, $5)`,
        [shop.business.id, client, delta, key, entry!.id],
      );

    await expect(insert(shop.client, -5, "a")).rejects.toThrow(
      "invalid_loyalty_reversal",
    );
    await expect(insert(other, -10, "b")).rejects.toThrow(
      "invalid_loyalty_reversal",
    );
    await insert(shop.client, -10, "c");
    await expect(insert(shop.client, -10, "d")).rejects.toThrow(
      "loyalty_events_reversal_once_idx",
    );
  });

  it("the balance view equals the sum of the ledger for every customer", async () => {
    const { rows } = await db.query(
      `select v.client_id
       from public.loyalty_balances v
       join (select client_id, sum(points_delta) as s from public.loyalty_events group by client_id) l
         on l.client_id = v.client_id
       where v.balance <> l.s`,
    );
    expect(rows).toEqual([]);
  });

  it("no appointment anywhere has two standing awards", async () => {
    const { rows } = await db.query(
      `select e.appointment_id
       from public.loyalty_events e
       where e.type = 'appointment_completed'
         and not exists (select 1 from public.loyalty_events r where r.reverses_event_id = e.id)
       group by e.appointment_id
       having count(*) > 1`,
    );
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("rewards", () => {
  it("creates the three kinds, idempotently, and validates their shape", async () => {
    const shop = await newShop();
    as(shop.owner);
    const requestId = randomUUID();
    const input = {
      requestId,
      name: "Soin offert",
      description: "Après 10 visites",
      pointsRequired: 100,
      rewardType: "free_service",
      rewardValue: null,
      serviceId: shop.coupe,
      active: true,
    };
    const created = ok(await createRewardAction(input));
    expect(created).toMatchObject({
      rewardType: "free_service",
      serviceId: shop.coupe,
      rewardValue: null,
      version: 1,
    });
    expect(ok(await createRewardAction(input)).id).toBe(created.id);
    failure(
      await createRewardAction({ ...input, pointsRequired: 50 }),
      "idempotency_conflict",
    );

    const fixed = await reward(shop, {
      rewardType: "fixed_discount",
      rewardValue: 1000,
    });
    expect(fixed).toMatchObject({ rewardValue: 1000, currency: "EUR" });
    const percent = await reward(shop, {
      rewardType: "percentage_discount",
      rewardValue: 15,
    });
    expect(percent).toMatchObject({ rewardValue: 15, currency: null });

    for (const bad of [
      { rewardType: "percentage_discount", rewardValue: 101 },
      { rewardType: "fixed_discount", rewardValue: null },
      { rewardType: "free_service", rewardValue: null, serviceId: null },
      { rewardType: "free_service", rewardValue: 100, serviceId: shop.coupe },
      { rewardType: "fixed_discount", rewardValue: 100, serviceId: shop.coupe },
      { pointsRequired: 0 },
    ]) {
      failure(
        await createRewardAction({ ...input, requestId: randomUUID(), ...bad }),
        "validation_error",
      );
    }
    expect(ok(await listRewardsAction())).toHaveLength(3);
  });

  it("updates are versioned and never change a reward already issued", async () => {
    const shop = await newShop();
    await earn(shop, 2);
    const gift = await reward(shop, {
      name: "Remise",
      pointsRequired: 10,
      rewardValue: 500,
    });
    as(shop.owner);
    const issued = ok(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: gift.id,
        requestId: randomUUID(),
      }),
    );

    const edit = {
      rewardId: gift.id,
      rewardType: "fixed_discount",
      expectedVersion: gift.version,
      name: "Remise XL",
      description: null,
      pointsRequired: 15,
      rewardValue: 900,
      serviceId: null,
      active: true,
    };
    const updated = ok(await updateRewardAction(edit));
    expect(updated).toMatchObject({
      name: "Remise XL",
      pointsRequired: 15,
      version: 2,
    });
    // Retry of the same edit: success. Another edit from the old read: refused.
    expect(ok(await updateRewardAction(edit)).version).toBe(2);
    failure(
      await updateRewardAction({ ...edit, name: "Autre" }),
      "stale_reward",
    );

    const [kept] = ok(
      await listClientRedemptionsAction({ clientId: shop.client }),
    );
    expect(kept).toMatchObject({
      id: issued.id,
      pointsSpent: 10,
      reward: {
        name: "Remise",
        value: 500,
        currency: "EUR",
        type: "fixed_discount",
      },
    });
  });

  it("members cannot write rewards, programs or rules directly", async () => {
    const shop = await newShop();
    const gift = await reward(shop, { pointsRequired: 10 });
    const client = shop.owner.client;

    await client
      .from("rewards")
      .update({ points_required: 1 })
      .eq("id", gift.id);
    await client.from("rewards").delete().eq("id", gift.id);
    const inserted = await client.from("rewards").insert({
      business_id: shop.business.id,
      name: "Pirate",
      points_required: 1,
      reward_type: "percentage_discount",
      reward_value: 100,
    });
    await client
      .from("loyalty_programs")
      .update({ points_per_completed_appointment: 9999 })
      .eq("business_id", shop.business.id);
    await client
      .from("loyalty_programs")
      .delete()
      .eq("business_id", shop.business.id);
    const rule = await client.from("loyalty_service_rules").insert({
      business_id: shop.business.id,
      service_id: shop.coupe,
      points: 9999,
    });

    expect(inserted.error?.code).toBe("42501");
    expect(rule.error?.code).toBe("42501");
    const { rows } = await db.query(
      `select (select points_required from public.rewards where id = $1) as points,
              (select count(*)::int from public.rewards where business_id = $2) as rewards,
              (select points_per_completed_appointment from public.loyalty_programs where business_id = $2) as per,
              (select count(*)::int from public.loyalty_service_rules where business_id = $2) as rules`,
      [gift.id, shop.business.id],
    );
    expect(rows[0]).toEqual({ points: 10, rewards: 1, per: 10, rules: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("redemption", () => {
  it("debits atomically, once per request, with the reward's snapshot", async () => {
    const shop = await newShop();
    await earn(shop, 3);
    const gift = await reward(shop, { name: "Remise 5 €", pointsRequired: 25 });
    as(shop.owner);
    const requestId = randomUUID();

    const first = ok(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: gift.id,
        requestId,
      }),
    );
    const retry = ok(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: gift.id,
        requestId,
      }),
    );
    expect(retry.id).toBe(first.id);
    expect(first).toMatchObject({
      status: "issued",
      pointsSpent: 25,
      reward: { name: "Remise 5 €", type: "fixed_discount", value: 500 },
    });
    expect(await balance(shop.client)).toBe(5);

    const other = await reward(shop, { name: "Autre", pointsRequired: 1 });
    failure(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: other.id,
        requestId,
      }),
      "idempotency_conflict",
    );

    const ledger = ok(
      await listClientLoyaltyLedgerAction({ clientId: shop.client }),
    );
    expect(ledger.entries[0]).toMatchObject({
      type: "reward_redeemed",
      pointsDelta: -25,
      balanceAfter: 5,
      redemption: { id: first.id, status: "issued", rewardName: "Remise 5 €" },
    });
  });

  it("insufficient balance: refused, nothing written", async () => {
    const shop = await newShop();
    await earn(shop, 1);
    const gift = await reward(shop, { pointsRequired: 11 });
    as(shop.owner);
    failure(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: gift.id,
        requestId: randomUUID(),
      }),
      "insufficient_points",
    );
    expect(await entries(shop.client)).toHaveLength(1);
    expect(
      ok(await listClientRedemptionsAction({ clientId: shop.client })),
    ).toEqual([]);
  });

  it("two concurrent redemptions cannot spend the same points (deterministic interleaving)", async () => {
    const shop = await newShop();
    await earn(shop, 1);
    const gift = await reward(shop, { pointsRequired: 10 });
    const another = await reward(shop, {
      name: "Autre",
      pointsRequired: 10,
      rewardValue: 300,
    });
    const first = await openTransaction({
      role: "authenticated",
      userId: shop.owner.userId,
    });
    const second = await openTransaction({
      role: "authenticated",
      userId: shop.owner.userId,
    });
    const call = "select public.loyalty_redeem_reward($1, $2, $3, $4)";

    await first.connection.query(call, [
      shop.business.id,
      shop.client,
      gift.id,
      randomUUID(),
    ]);
    const pending = outcome(
      second.connection.query(call, [
        shop.business.id,
        shop.client,
        another.id,
        randomUUID(),
      ]),
    );
    await waitUntilBlocked(second.pid);
    await closeTransaction(first, "commit");
    expect(await pending).toBe("insufficient_points");
    await closeTransaction(second, "rollback");

    expect(await balance(shop.client)).toBe(0);
  });

  it("many concurrent redemptions through the API: exactly as many as the balance allows", async () => {
    const shop = await newShop();
    await earn(shop, 3);
    const gift = await reward(shop, { pointsRequired: 10 });
    as(shop.owner);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        redeemRewardAction({
          clientId: shop.client,
          rewardId: gift.id,
          requestId: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(
      results.filter((r) => !r.ok).map((r) => !r.ok && r.error.code),
    ).toEqual(Array(5).fill("insufficient_points"));
    expect(await balance(shop.client)).toBe(0);
  });

  it("the same request sent concurrently issues one reward", async () => {
    const shop = await newShop();
    await earn(shop, 5);
    const gift = await reward(shop, { pointsRequired: 10 });
    as(shop.owner);
    const requestId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        redeemRewardAction({
          clientId: shop.client,
          rewardId: gift.id,
          requestId,
        }),
      ),
    );
    const ids = new Set(results.map((r) => ok(r).id));
    expect(ids.size).toBe(1);
    expect(await balance(shop.client)).toBe(40);
  });

  it("eligibility: program, reward state, deleted service, balance", async () => {
    const shop = await newShop();
    await earn(shop, 2);
    const cheap = await reward(shop, { name: "A", pointsRequired: 20 });
    const dear = await reward(shop, { name: "B", pointsRequired: 50 });
    const off = await reward(shop, {
      name: "C",
      pointsRequired: 1,
      active: false,
    });
    const lonely = await createService(shop.business.id, { name: "Éphémère" });
    const free = await reward(shop, {
      name: "D",
      pointsRequired: 5,
      rewardType: "free_service",
      rewardValue: null,
      serviceId: lonely,
    });
    await db.query("delete from public.services where id = $1", [lonely]);
    as(shop.owner);

    const summary = ok(await getClientLoyaltyAction({ clientId: shop.client }));
    const byId = Object.fromEntries(
      summary.rewards.map((r) => [r.rewardId, r]),
    );
    expect(summary).toMatchObject({ programActive: true, balance: 20 });
    expect(byId[cheap.id]).toMatchObject({ eligible: true, missingPoints: 0 });
    expect(byId[dear.id]).toMatchObject({ eligible: false, missingPoints: 30 });
    expect(byId[off.id]).toMatchObject({
      eligible: false,
      unavailableReason: "inactive",
    });
    expect(byId[free.id]).toMatchObject({
      eligible: false,
      unavailableReason: "service_missing",
    });

    failure(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: off.id,
        requestId: randomUUID(),
      }),
      "reward_unavailable",
    );
    failure(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: free.id,
        requestId: randomUUID(),
      }),
      "reward_unavailable",
    );

    await program(shop, { active: false });
    as(shop.owner);
    failure(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: cheap.id,
        requestId: randomUUID(),
      }),
      "loyalty_program_inactive",
    );
    expect(
      ok(await getClientLoyaltyAction({ clientId: shop.client })).rewards.every(
        (r) => !r.eligible && r.unavailableReason === "program_inactive",
      ),
    ).toBe(true);
  });

  it("cancel refunds once with a compensating entry; fulfilled is final", async () => {
    const shop = await newShop();
    await earn(shop, 3);
    const gift = await reward(shop, { pointsRequired: 10 });
    as(shop.owner);
    const redeem = () =>
      redeemRewardAction({
        clientId: shop.client,
        rewardId: gift.id,
        requestId: randomUUID(),
      });

    const toCancel = ok(await redeem());
    const cancelled = ok(
      await cancelRedemptionAction({
        redemptionId: toCancel.id,
        reason: "Erreur",
      }),
    );
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancellationReason: "Erreur",
    });
    ok(await cancelRedemptionAction({ redemptionId: toCancel.id }));
    expect(await balance(shop.client)).toBe(30);
    const refunds = (await entries(shop.client)).filter(
      (e) => e.reverses_event_id,
    );
    expect(refunds).toEqual([
      expect.objectContaining({
        points_delta: 10,
        reverses_event_id: cancelled.debitEntryId,
      }),
    ]);
    failure(
      await fulfilRedemptionAction({ redemptionId: toCancel.id }),
      "invalid_redemption_transition",
    );

    const toUse = ok(await redeem());
    const visit = await pastAppointment(shop, shop.coupe);
    const used = ok(
      await fulfilRedemptionAction({
        redemptionId: toUse.id,
        appointmentId: visit,
      }),
    );
    expect(used).toMatchObject({ status: "fulfilled", appointmentId: visit });
    ok(
      await fulfilRedemptionAction({
        redemptionId: toUse.id,
        appointmentId: visit,
      }),
    );
    failure(
      await cancelRedemptionAction({ redemptionId: toUse.id }),
      "invalid_redemption_transition",
    );
    expect(await balance(shop.client)).toBe(20);

    // Another customer's visit cannot be attached.
    const stranger = await createClientRecord(
      shop.business.id,
      `x-${randomUUID()}@x.test`,
    );
    const strangerVisit = await pastAppointment(shop, shop.coupe, stranger);
    const third = ok(await redeem());
    failure(
      await fulfilRedemptionAction({
        redemptionId: third.id,
        appointmentId: strangerVisit,
      }),
      "appointment_not_found",
    );
  });

  it("concurrent cancellations refund once", async () => {
    const shop = await newShop();
    await earn(shop, 1);
    const gift = await reward(shop, { pointsRequired: 10 });
    as(shop.owner);
    const issued = ok(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: gift.id,
        requestId: randomUUID(),
      }),
    );
    await Promise.all(
      Array.from({ length: 5 }, () =>
        cancelRedemptionAction({ redemptionId: issued.id }),
      ),
    );
    expect(await balance(shop.client)).toBe(10);
  });

  it("an issued reward's identity cannot be rewritten", async () => {
    const shop = await newShop();
    await earn(shop, 1);
    const gift = await reward(shop, { pointsRequired: 10 });
    as(shop.owner);
    const issued = ok(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: gift.id,
        requestId: randomUUID(),
      }),
    );
    await expect(
      db.query(
        "update public.reward_redemptions set points_spent = 1 where id = $1",
        [issued.id],
      ),
    ).rejects.toThrow("reward_redemption_immutable");
  });
});

// ---------------------------------------------------------------------------

describe("manual adjustments", () => {
  it("credit and debit with a reason, idempotent, never below zero, reversible once", async () => {
    const shop = await newShop();
    as(shop.owner);
    const requestId = randomUUID();
    const credit = {
      clientId: shop.client,
      requestId,
      pointsDelta: 15,
      reason: "Geste commercial",
    };

    const { entryId } = ok(await adjustPointsAction(credit));
    expect(ok(await adjustPointsAction(credit)).entryId).toBe(entryId);
    failure(
      await adjustPointsAction({ ...credit, pointsDelta: 16 }),
      "idempotency_conflict",
    );
    failure(
      await adjustPointsAction({
        ...credit,
        requestId: randomUUID(),
        pointsDelta: -16,
      }),
      "insufficient_points",
    );
    ok(
      await adjustPointsAction({
        ...credit,
        requestId: randomUUID(),
        pointsDelta: -5,
      }),
    );
    expect(await balance(shop.client)).toBe(10);

    // The credit was partly spent: reversing it would overspend.
    failure(
      await reverseAdjustmentAction({ entryId, reason: "Erreur de saisie" }),
      "insufficient_points",
    );
    expect(await balance(shop.client)).toBe(10);

    // Reversible once nothing of it is spent.
    const small = ok(
      await adjustPointsAction({
        ...credit,
        requestId: randomUUID(),
        pointsDelta: 4,
      }),
    ).entryId;
    const reversal = ok(
      await reverseAdjustmentAction({ entryId: small, reason: "Doublon" }),
    );
    expect(ok(await reverseAdjustmentAction({ entryId: small })).entryId).toBe(
      reversal.entryId,
    );
    expect(await balance(shop.client)).toBe(10);

    failure(
      await adjustPointsAction({ ...credit, pointsDelta: 0 }),
      "validation_error",
    );
    failure(
      await adjustPointsAction({ ...credit, reason: "  " }),
      "validation_error",
    );
  });

  it("awards, redemptions and corrections are not reversible as adjustments", async () => {
    const shop = await newShop();
    await earn(shop, 1);
    const [award] = await entries(shop.client);
    as(shop.owner);
    failure(
      await reverseAdjustmentAction({ entryId: award!.id }),
      "loyalty_entry_not_reversible",
    );
    failure(
      await reverseAdjustmentAction({ entryId: randomUUID() }),
      "loyalty_entry_not_found",
    );
  });

  it("ledger pages: newest first, running balance, stable cursor", async () => {
    const shop = await newShop();
    await earn(shop, 3);
    as(shop.owner);
    const first = ok(
      await listClientLoyaltyLedgerAction({ clientId: shop.client, limit: 2 }),
    );
    expect(first.entries.map((e) => e.balanceAfter)).toEqual([30, 20]);
    expect(first.nextCursor).not.toBeNull();
    const second = ok(
      await listClientLoyaltyLedgerAction({
        clientId: shop.client,
        limit: 2,
        cursor: first.nextCursor!,
      }),
    );
    expect(second.entries.map((e) => e.balanceAfter)).toEqual([10]);
    expect(second.nextCursor).toBeNull();

    const balances = ok(
      await listLoyaltyBalancesAction({ clientIds: [shop.client] }),
    );
    expect(balances).toEqual([
      expect.objectContaining({
        clientId: shop.client,
        balance: 30,
        pointsCredited: 30,
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("security and tenant isolation", () => {
  let a: Shop;
  let b: Shop;
  let rewardA: RewardDto;
  let rewardB: RewardDto;
  let entryA: string;
  let redemptionA: string;

  beforeAll(async () => {
    a = await newShop("iso-a");
    b = await newShop("iso-b");
    await earn(a, 2);
    await earn(b, 2);
    rewardA = await reward(a, { pointsRequired: 5 });
    rewardB = await reward(b, { pointsRequired: 5 });
    as(a.owner);
    entryA = ok(
      await adjustPointsAction({
        clientId: a.client,
        requestId: randomUUID(),
        pointsDelta: 1,
        reason: "x",
      }),
    ).entryId;
    redemptionA = ok(
      await redeemRewardAction({
        clientId: a.client,
        rewardId: rewardA.id,
        requestId: randomUUID(),
      }),
    ).id;
  });

  it("anonymous callers reach nothing: no RPC, no table, no view, not even by email", async () => {
    const anon = anonClient();
    const calls = [
      anon.rpc("loyalty_client_summary", {
        p_business_id: a.business.id,
        p_client_id: a.client,
      }),
      anon.rpc("loyalty_client_ledger", {
        p_business_id: a.business.id,
        p_client_id: a.client,
      }),
      anon.rpc("loyalty_redeem_reward", {
        p_business_id: a.business.id,
        p_client_id: a.client,
        p_reward_id: rewardA.id,
        p_request_id: randomUUID(),
      }),
      anon.rpc("loyalty_adjust_points", {
        p_business_id: a.business.id,
        p_client_id: a.client,
        p_request_id: randomUUID(),
        p_points_delta: 100,
        p_reason: "x",
      }),
    ];
    for (const { error } of await Promise.all(calls)) {
      expect(error?.code).toBe("42501");
    }
    for (const table of [
      "loyalty_events",
      "loyalty_balances",
      "reward_redemptions",
      "rewards",
      "loyalty_programs",
      "loyalty_service_rules",
    ] as const) {
      const { data, error } = await (anon as unknown as SupabaseClient)
        .from(table)
        .select("*");
      expect(error?.code ?? (data?.length === 0 ? "empty" : "leak")).toMatch(
        /42501|empty/,
      );
    }

    as(null);
    failure(
      await getClientLoyaltyAction({ clientId: a.client }),
      "unauthenticated",
    );
    failure(
      await redeemRewardAction({
        clientId: a.client,
        rewardId: rewardA.id,
        requestId: randomUUID(),
      }),
      "unauthenticated",
    );
  });

  it("no SQL function exposes loyalty data by email or token", async () => {
    const { rows } = await db.query(
      `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (p.proname like 'loyalty%' or p.proname like '%reward%')
         and (pg_get_function_arguments(p.oid) ilike '%email%'
              or pg_get_function_arguments(p.oid) ilike '%token%'
              or has_function_privilege('anon', p.oid, 'execute'))`,
    );
    expect(rows).toEqual([]);
  });

  it("security definer functions pin their search_path; private helpers are not executable by API roles", async () => {
    const { rows: definers } = await db.query(
      `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')
         and (p.proname like 'loyalty%' or p.proname like '%redemption%')
         and p.prosecdef
         and not coalesce(p.proconfig, '{}') @> array['search_path=""']`,
    );
    expect(definers).toEqual([]);
    const { rows: exposed } = await db.query(
      `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private'
         and (p.proname like 'loyalty%' or p.proname like '%redemption%')
         and (has_function_privilege('authenticated', p.oid, 'execute')
              or has_function_privilege('anon', p.oid, 'execute'))`,
    );
    expect(exposed).toEqual([]);
  });

  it("another business's professional is forbidden on every write, for every id", async () => {
    const intruder = b.owner.client;
    const results = await Promise.all([
      intruder.rpc("loyalty_redeem_reward", {
        p_business_id: a.business.id,
        p_client_id: a.client,
        p_reward_id: rewardA.id,
        p_request_id: randomUUID(),
      }),
      intruder.rpc("loyalty_adjust_points", {
        p_business_id: a.business.id,
        p_client_id: a.client,
        p_request_id: randomUUID(),
        p_points_delta: 1000,
        p_reason: "x",
      }),
      intruder.rpc("loyalty_cancel_redemption", {
        p_business_id: a.business.id,
        p_redemption_id: redemptionA,
      }),
      intruder.rpc("loyalty_reverse_adjustment", {
        p_business_id: a.business.id,
        p_entry_id: entryA,
      }),
      intruder.rpc("loyalty_configure_program", {
        p_business_id: a.business.id,
        p_expected_version: 1,
        p_active: false,
        p_accrual_mode: "appointment",
        p_points_per_completed_appointment: 1,
      }),
      intruder.rpc("loyalty_client_summary", {
        p_business_id: a.business.id,
        p_client_id: a.client,
      }),
      intruder.rpc("loyalty_client_ledger", {
        p_business_id: a.business.id,
        p_client_id: a.client,
      }),
    ]);
    for (const { error } of results) {
      expect(error?.message).toBe("forbidden");
    }
  });

  it("its own business id with another tenant's rows: not found, nothing written", async () => {
    as(b.owner);
    const before = await balance(a.client);
    failure(
      await adjustPointsAction({
        clientId: a.client,
        requestId: randomUUID(),
        pointsDelta: 50,
        reason: "x",
      }),
      "client_not_found",
    );
    failure(
      await redeemRewardAction({
        clientId: a.client,
        rewardId: rewardB.id,
        requestId: randomUUID(),
      }),
      "client_not_found",
    );
    failure(
      await redeemRewardAction({
        clientId: b.client,
        rewardId: rewardA.id,
        requestId: randomUUID(),
      }),
      "reward_not_found",
    );
    failure(
      await cancelRedemptionAction({ redemptionId: redemptionA }),
      "redemption_not_found",
    );
    failure(
      await fulfilRedemptionAction({ redemptionId: redemptionA }),
      "redemption_not_found",
    );
    failure(
      await reverseAdjustmentAction({ entryId: entryA }),
      "loyalty_entry_not_found",
    );
    failure(
      await getClientLoyaltyAction({ clientId: a.client }),
      "client_not_found",
    );
    failure(
      await listClientLoyaltyLedgerAction({ clientId: a.client }),
      "client_not_found",
    );
    failure(
      await updateRewardAction({
        rewardId: rewardA.id,
        rewardType: "fixed_discount",
        expectedVersion: 1,
        name: "x",
        description: null,
        pointsRequired: 1,
        rewardValue: 1,
        serviceId: null,
        active: true,
      }),
      "reward_not_found",
    );
    expect(await balance(a.client)).toBe(before);
  });

  it("RLS: another business's ledger, balances, redemptions, rewards and rules are invisible", async () => {
    const intruder = b.owner.client;
    for (const [table, column] of [
      ["loyalty_events", "business_id"],
      ["loyalty_balances", "business_id"],
      ["reward_redemptions", "business_id"],
      ["rewards", "business_id"],
      ["loyalty_programs", "business_id"],
      ["loyalty_service_rules", "business_id"],
    ] as const) {
      const { data, error } = await (intruder as unknown as SupabaseClient)
        .from(table)
        .select("*")
        .eq(column, a.business.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    as(b.owner);
    expect(
      ok(await listLoyaltyBalancesAction({ clientIds: [a.client] })),
    ).toEqual([]);
  });

  it("a professional cannot write the ledger or redemptions directly, even for their own business", async () => {
    const client = a.owner.client;
    const before = await balance(a.client);
    const insert = await client.from("loyalty_events").insert({
      business_id: a.business.id,
      client_id: a.client,
      type: "manual_adjustment",
      points_delta: 1_000_000,
      reason: "x",
      idempotency_key: randomUUID(),
    });
    const redemption = await client.from("reward_redemptions").insert({
      business_id: a.business.id,
      reward_id: rewardA.id,
      client_id: a.client,
      loyalty_event_id: entryA,
      points_spent: 1,
      reward_name_snapshot: "x",
      reward_type_snapshot: "free_service",
    });
    await client
      .from("loyalty_events")
      .delete()
      .eq("business_id", a.business.id);
    await client
      .from("reward_redemptions")
      .update({ status: "cancelled" })
      .eq("id", redemptionA);

    expect(insert.error?.code).toBe("42501");
    expect(redemption.error?.code).toBe("42501");
    expect(await balance(a.client)).toBe(before);
    const { rows } = await db.query(
      "select status from public.reward_redemptions where id = $1",
      [redemptionA],
    );
    expect(rows[0].status).toBe("issued");
  });

  it("completion by another business's professional cannot credit this business's customer", async () => {
    const appointment = await pastAppointment(a, a.coupe);
    const v = await version(appointment);
    const { error } = await b.owner.client.rpc(
      "agenda_set_appointment_status",
      {
        p_business_id: a.business.id,
        p_appointment_id: appointment,
        p_expected_version: v,
        p_status: "completed",
      },
    );
    expect(error?.message).toBe("forbidden");
    const own = await b.owner.client.rpc("agenda_set_appointment_status", {
      p_business_id: b.business.id,
      p_appointment_id: appointment,
      p_expected_version: v,
      p_status: "completed",
    });
    expect(own.error?.message).toBe("appointment_not_found");
    const { rows } = await db.query(
      "select count(*)::int as n from public.loyalty_events where appointment_id = $1",
      [appointment],
    );
    expect(rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("self-audit regressions", () => {
  it("deleting a member's account keeps the ledger and clears its authorship", async () => {
    const shop = await newShop("member");
    const admin = await createProfessional("admin");
    await db.query(
      `insert into public.business_members (business_id, user_id, role)
       values ($1, $2, 'admin')`,
      [shop.business.id, admin.userId],
    );
    as(admin);
    await complete(await pastAppointment(shop, shop.coupe));
    ok(
      await adjustPointsAction({
        clientId: shop.client,
        requestId: randomUUID(),
        pointsDelta: 3,
        reason: "Bienvenue",
      }),
    );
    const before = await entries(shop.client);

    await db.query("delete from auth.users where id = $1", [admin.userId]);

    const { rows } = await db.query(
      "select count(*)::int as n, count(created_by)::int as authored from public.loyalty_events where client_id = $1",
      [shop.client],
    );
    expect(rows[0]).toEqual({ n: before.length, authored: 0 });
    expect(await balance(shop.client)).toBe(13);
  });

  it("the same request id reused at once for two customers is an idempotency conflict, not an error", async () => {
    const shop = await newShop();
    const other = await createClientRecord(
      shop.business.id,
      `y-${randomUUID()}@x.test`,
    );
    await earn(shop, 1);
    await earn(shop, 1, other);
    const gift = await reward(shop, { pointsRequired: 10 });
    const requestId = randomUUID();
    const first = await openTransaction({
      role: "authenticated",
      userId: shop.owner.userId,
    });
    const second = await openTransaction({
      role: "authenticated",
      userId: shop.owner.userId,
    });
    const call = "select public.loyalty_redeem_reward($1, $2, $3, $4)";

    await first.connection.query(call, [
      shop.business.id,
      shop.client,
      gift.id,
      requestId,
    ]);
    const pending = outcome(
      second.connection.query(call, [
        shop.business.id,
        other,
        gift.id,
        requestId,
      ]),
    );
    await waitUntilBlocked(second.pid);
    await closeTransaction(first, "commit");
    expect(await pending).toBe("idempotency_conflict");
    await closeTransaction(second, "rollback");
    expect(await balance(other)).toBe(10);
  });

  it("a redemption racing a deactivation waits for it, then is refused", async () => {
    const shop = await newShop();
    await earn(shop, 1);
    const gift = await reward(shop, { pointsRequired: 10 });
    const config = await openTransaction({
      role: "authenticated",
      userId: shop.owner.userId,
    });
    const redeem = await openTransaction({
      role: "authenticated",
      userId: shop.owner.userId,
    });
    const { rows } = await db.query(
      "select version from public.loyalty_programs where business_id = $1",
      [shop.business.id],
    );
    await config.connection.query(
      "select public.loyalty_configure_program($1, $2, false, 'appointment', 10)",
      [shop.business.id, rows[0].version],
    );
    const pending = outcome(
      redeem.connection.query(
        "select public.loyalty_redeem_reward($1, $2, $3, $4)",
        [shop.business.id, shop.client, gift.id, randomUUID()],
      ),
    );
    await waitUntilBlocked(redeem.pid);
    await closeTransaction(config, "commit");
    expect(await pending).toBe("loyalty_program_inactive");
    await closeTransaction(redeem, "rollback");
    expect(await balance(shop.client)).toBe(10);
  });

  it("deleting a whole business removes its ledger; nothing else can", async () => {
    const shop = await newShop("gone");
    await earn(shop, 1);
    const gift = await reward(shop, { pointsRequired: 10 });
    as(shop.owner);
    ok(
      await redeemRewardAction({
        clientId: shop.client,
        rewardId: gift.id,
        requestId: randomUUID(),
      }),
    );
    await db.query("delete from public.businesses where id = $1", [
      shop.business.id,
    ]);
    const { rows } = await db.query(
      "select count(*)::int as n from public.loyalty_events where business_id = $1",
      [shop.business.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("an extreme legacy rate cannot break the completion of an appointment", async () => {
    const shop = await newShop("rate");
    // Legacy data: a direct write allowed before this migration (the range
    // check is NOT VALID, so such a row can still exist).
    await db.query(
      "alter table public.loyalty_programs drop constraint loyalty_programs_points_per_euro_range",
    );
    try {
      await db.query(
        `update public.loyalty_programs
         set accrual_mode = 'spend', points_per_euro = 999999.9999
         where business_id = $1`,
        [shop.business.id],
      );
    } finally {
      await db.query(
        `alter table public.loyalty_programs add constraint loyalty_programs_points_per_euro_range
           check (points_per_euro is null or points_per_euro between 0.01 and 100) not valid`,
      );
    }
    const expensive = await createService(shop.business.id, {
      priceCents: 50_000_000,
    });
    as(shop.owner);
    await complete(await pastAppointment(shop, expensive));
    expect(await entries(shop.client)).toMatchObject([
      { points_delta: 1_000_000 },
    ]);
  });
});
