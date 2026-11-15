import { createHash, randomBytes, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  bookingClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  insertAppointment,
  setWeeklyHours,
  updateSettings,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Waiting list (docs/WAITLIST_CONTRACT.md) through PostgREST as the routes
// call it (service role), the owner with her real session.

type Rpc = { data: unknown; error: { message: string } | null };
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
const refusal = async (promise: Promise<Rpc>) => (await promise).error?.message;

const token = () => randomBytes(32).toString("hex");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const ip = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

type Offer = {
  id: string;
  version: number;
  state: string;
  startsAt: string;
  quoteRevision: string;
  requestActive: boolean;
};
type Matched = {
  offerId: string;
  token: string;
  email: string;
  startsAt: string;
};

let owner: Professional;
let business: TestBusiness;
let service: string;
// Offer tests use days no joining test touches (FIFO would hand them to older requests).
let day = 10;

beforeAll(async () => {
  owner = await createProfessional("waitlist");
  business = await createBusiness(owner.userId, { timezone: "UTC" });
  await updateSettings(business.id, {
    slot_interval_minutes: 30,
    buffer_minutes: 0,
    minimum_booking_notice_minutes: 0,
    maximum_booking_advance_days: 60,
  } as never);
  await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
  service = await createService(business.id, {
    name: "Pose",
    durationMinutes: 60,
    priceCents: 5000,
  });
  await ok(
    call(owner.client, "set_waitlist_enabled", {
      p_business_id: business.id,
      p_enabled: true,
    }),
  );
});

/** A confirmed request for one window of `localDate`; its email. */
async function joined(localDate: string, startMinute = 600, endMinute = 660) {
  const email = `attente-${randomUUID().slice(0, 8)}@client.test`;
  const confirm = token();
  await ok(
    call(bookingClient(), "waitlist_create_request", {
      p_slug: business.slug,
      p_service_id: service,
      p_option_choice_ids: [],
      p_windows: [{ localDate, startMinute, endMinute }],
      p_any_time: false,
      p_first_name: "Léa",
      p_email: email,
      p_request_id: randomUUID(),
      p_client_ip: ip(),
      p_confirm_token_hash: hash(confirm),
    }),
  );
  await ok(
    call(bookingClient(), "waitlist_confirm_request", {
      p_token_hash: hash(confirm),
    }),
  );
  return email;
}

/** An appointment that occupies [start, start + 1h); cancelling it frees the time. */
async function occupy(startsAt: string) {
  const clientId = await createClientRecord(
    business.id,
    `occupe-${randomUUID().slice(0, 8)}@client.test`,
  );
  return insertAppointment({
    businessId: business.id,
    clientId,
    serviceId: service,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 3_600_000).toISOString(),
  });
}

const match = () =>
  ok<{ signals: number; offers: Matched[] }>(
    call(bookingClient(), "waitlist_match", { p_budget: 50 }),
  );
const mine = (offers: Matched[], email: string) =>
  offers.filter((o) => o.email === email);
const readOffer = (offer: Matched, tokenValue = offer.token) =>
  call(bookingClient(), "waitlist_offer", {
    p_offer_id: offer.offerId,
    p_token_hash: hash(tokenValue),
  });
const claim = (offer: Matched, read: Offer, requestId = randomUUID()) =>
  call(bookingClient(), "waitlist_claim", {
    p_offer_id: offer.offerId,
    p_token_hash: hash(offer.token),
    p_request_id: requestId,
    p_expected_version: read.version,
    p_expected_quote_revision: read.quoteRevision,
    p_client_ip: ip(),
  });

describe("joining", () => {
  it("records a pending request, replays it, confirms it once, and refuses bad windows", async () => {
    const date = dateInDays(4);
    const confirm = token();
    const args = {
      p_slug: business.slug,
      p_service_id: service,
      p_option_choice_ids: [],
      p_windows: [{ localDate: date, startMinute: 0, endMinute: 720 }],
      p_any_time: false,
      p_first_name: "Inès",
      p_email: `ines-${randomUUID().slice(0, 8)}@client.test`,
      p_request_id: randomUUID(),
      p_client_ip: ip(),
      p_confirm_token_hash: hash(confirm),
    };
    const first = await ok<{ state: string; replayed: boolean }>(
      call(bookingClient(), "waitlist_create_request", args),
    );
    expect(first).toMatchObject({
      state: "pending_confirmation",
      replayed: false,
    });
    expect(
      await ok(call(bookingClient(), "waitlist_create_request", args)),
    ).toMatchObject({ replayed: true });
    expect(
      await refusal(
        call(bookingClient(), "waitlist_create_request", {
          ...args,
          p_first_name: "Autre",
        }),
      ),
    ).toBe("idempotency_conflict");
    expect(
      await ok(
        call(bookingClient(), "waitlist_confirm_request", {
          p_token_hash: hash(confirm),
        }),
      ),
    ).toMatchObject({
      state: "active",
    });
    expect(
      await ok(
        call(bookingClient(), "waitlist_confirm_request", {
          p_token_hash: hash(confirm),
        }),
      ),
    ).toMatchObject({
      state: "active",
    });
    expect(
      await refusal(
        call(bookingClient(), "waitlist_confirm_request", {
          p_token_hash: hash(token()),
        }),
      ),
    ).toBe("waitlist_request_not_found");

    const bad = [
      [{ localDate: dateInDays(30), startMinute: 0, endMinute: 60 }],
      [{ localDate: date, startMinute: 600, endMinute: 600 }],
      [],
    ];
    for (const windows of bad) {
      expect(
        await refusal(
          call(bookingClient(), "waitlist_create_request", {
            ...args,
            p_request_id: randomUUID(),
            p_windows: windows,
            p_confirm_token_hash: hash(token()),
          }),
        ),
      ).toBe("invalid_input");
    }
  });

  it("is closed until the business opens it, and limits one address", async () => {
    const other = await createProfessional("waitlist-closed");
    const closed = await createBusiness(other.userId, { timezone: "UTC" });
    const closedService = await createService(closed.id);
    expect(
      await refusal(
        call(bookingClient(), "waitlist_create_request", {
          p_slug: closed.slug,
          p_service_id: closedService,
          p_option_choice_ids: [],
          p_windows: [],
          p_any_time: true,
          p_first_name: "Léa",
          p_email: "lea@client.test",
          p_request_id: randomUUID(),
          p_client_ip: ip(),
          p_confirm_token_hash: hash(token()),
        }),
      ),
    ).toBe("waitlist_unavailable");

    const email = `limite-${randomUUID().slice(0, 8)}@client.test`;
    const ask = () =>
      call(bookingClient(), "waitlist_create_request", {
        p_slug: business.slug,
        p_service_id: service,
        p_option_choice_ids: [],
        p_windows: [],
        p_any_time: true,
        p_first_name: "Léa",
        p_email: email,
        p_request_id: randomUUID(),
        p_client_ip: ip(),
        p_confirm_token_hash: hash(token()),
      });
    for (let i = 0; i < 3; i += 1) await ok(ask());
    expect(await refusal(ask())).toBe("rate_limited");
  });
});

describe("offers", () => {
  it("offers a freed time to the oldest request only, then books it once", async () => {
    day += 1;
    const date = dateInDays(day);
    const appointment = await occupy(`${date}T10:00:00.000Z`);
    const first = await joined(date);
    const second = await joined(date);

    expect(mine((await match()).offers, first)).toHaveLength(0);
    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [appointment],
    );
    const offers = (await match()).offers;
    expect(mine(offers, second)).toHaveLength(0);
    const [offer] = mine(offers, first);
    expect(new Date(offer!.startsAt).toISOString()).toBe(
      `${date}T10:00:00.000Z`,
    );

    expect(await refusal(readOffer(offer!, token()))).toBe(
      "waitlist_offer_not_found",
    );
    const read = await ok<Offer>(readOffer(offer!));
    expect(read).toMatchObject({
      state: "offered",
      version: 1,
      requestActive: true,
    });

    const requestId = randomUUID();
    const booked = await ok<{ offer: Offer; appointmentId: string }>(
      claim(offer!, read, requestId),
    );
    expect(booked.offer.state).toBe("booked");
    expect(
      await ok<{ offer: Offer }>(claim(offer!, read, requestId)),
    ).toMatchObject({ offer: { state: "booked" } });
    const { rows } = await db.query(
      "select status, starts_at from public.appointments where id = $1",
      [booked.appointmentId],
    );
    expect(rows[0].status).toBe("confirmed");
    expect(new Date(rows[0].starts_at).toISOString()).toBe(
      `${date}T10:00:00.000Z`,
    );
  });

  it("marks the offer unavailable when someone books the time first, and keeps her request", async () => {
    day += 1;
    const date = dateInDays(day);
    const appointment = await occupy(`${date}T10:00:00.000Z`);
    const email = await joined(date);
    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [appointment],
    );
    const [offer] = mine((await match()).offers, email);
    const read = await ok<Offer>(readOffer(offer!));

    await occupy(`${date}T10:00:00.000Z`);
    const lost = await ok<{ error: string; offer: Offer }>(claim(offer!, read));
    expect(lost).toMatchObject({
      error: "offer_unavailable",
      offer: { state: "unavailable", requestActive: true },
    });
    expect((await ok<Offer>(readOffer(offer!))).state).toBe("unavailable");
  });

  it("refuses an expired offer and a changed price", async () => {
    day += 1;
    const date = dateInDays(day);
    const a = await occupy(`${date}T10:00:00.000Z`);
    const b = await occupy(`${date}T14:00:00.000Z`);
    const late = await joined(date, 600, 660);
    const priced = await joined(date, 840, 900);
    await db.query(
      "update public.appointments set status = 'cancelled' where id = any($1)",
      [[a, b]],
    );
    const offers = (await match()).offers;
    const [lateOffer] = mine(offers, late);
    const [pricedOffer] = mine(offers, priced);

    const lateRead = await ok<Offer>(readOffer(lateOffer!));
    await db.query(
      "update private.waitlist_offers set expires_at = now() - interval '1 minute' where id = $1",
      [lateOffer!.offerId],
    );
    expect(await refusal(claim(lateOffer!, lateRead))).toBe("offer_expired");

    const pricedRead = await ok<Offer>(readOffer(pricedOffer!));
    await db.query(
      "update public.services set price_cents = 5500 where id = $1",
      [service],
    );
    try {
      expect(await refusal(claim(pricedOffer!, pricedRead))).toBe(
        "quote_changed",
      );
    } finally {
      await db.query(
        "update public.services set price_cents = 5000 where id = $1",
        [service],
      );
    }
  });

  it("never lets two workers take the same signal", async () => {
    day += 1;
    const date = dateInDays(day);
    const appointment = await occupy(`${date}T10:00:00.000Z`);
    const email = await joined(date);
    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [appointment],
    );
    const [x, y] = await Promise.all([match(), match()]);
    expect(mine(x.offers, email).length + mine(y.offers, email).length).toBe(1);
  });
});
