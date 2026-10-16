import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as postBooking } from "@/app/api/bookings/route";
import { GET as getAvailability } from "@/app/api/public/businesses/[slug]/availability/route";
import { GET as getBusiness } from "@/app/api/public/businesses/[slug]/route";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  createBusiness,
  createProfessional,
  createService,
  dateInDays,
  env,
  everyDay,
  randomIp,
  setWeeklyHours,
  type TestBusiness,
} from "./support/fixtures";

// Calls the Route Handlers directly (as Next.js does) against the local stack.
// The read routes use the publishable key only; POST /api/bookings calls the
// booking function as the service role (the function is not executable by
// the public roles) with the caller's address from the trusted proxy.

const DATE = dateInDays(9);

let business: TestBusiness;
let service: string;
let inactive: string;

// The trusted reverse proxy's secret (src/lib/client-identity.ts).
const PROXY_SECRET = "api-routes-proxy-secret-0123456789abcdef";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  process.env.BOOKING_PROXY_SECRET = PROXY_SECRET;

  const owner = await createProfessional("api");
  business = await createBusiness(owner.userId);
  service = await createService(business.id, { name: "Cil à cil" });
  inactive = await createService(business.id, {
    name: "Ancienne",
    active: false,
  });
  await setWeeklyHours(business.id, everyDay(["09:00", "12:00"]));
});

describe("GET /api/public/businesses/:slug", () => {
  it("returns the profile and active services", async () => {
    const response = await getBusiness(
      new NextRequest("http://localhost/api"),
      params(business.slug),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data.business.slug).toBe(business.slug);
    expect(body.data.services.map((s: { id: string }) => s.id)).toEqual([
      service,
    ]);
  });

  it("answers 404 for an unknown slug and 400 for a malformed one", async () => {
    const missing = await getBusiness(
      new NextRequest("http://localhost/api"),
      params("nobody"),
    );
    const malformed = await getBusiness(
      new NextRequest("http://localhost/api"),
      params("Not a slug!"),
    );

    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("business_not_found");
    expect(malformed.status).toBe(400);
  });
});

describe("GET /api/public/businesses/:slug/availability", () => {
  const url = (query: string) =>
    new NextRequest(`http://localhost/api/availability?${query}`);

  it("returns UTC slots with the business time zone", async () => {
    const response = await getAvailability(
      url(`serviceId=${service}&date=${DATE}`),
      params(business.slug),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.timezone).toBe("Europe/Paris");
    expect(body.data.slots[0]).toEqual({
      startsAt: zonedLocalToUtc(`${DATE}T09:00`, "Europe/Paris").toISOString(),
      endsAt: zonedLocalToUtc(`${DATE}T10:00`, "Europe/Paris").toISOString(),
      // Wall clocks read by PostgreSQL, the calendar authority.
      localStartsAt: `${DATE}T09:00`,
      localEndsAt: `${DATE}T10:00`,
    });
  });

  it("answers 404 for an inactive service and 400 for invalid parameters", async () => {
    const inactiveResponse = await getAvailability(
      url(`serviceId=${inactive}&date=${DATE}`),
      params(business.slug),
    );
    const invalid = await getAvailability(
      url(`serviceId=nope&date=2026-02-30`),
      params(business.slug),
    );

    expect(inactiveResponse.status).toBe(404);
    expect((await inactiveResponse.json()).error.code).toBe(
      "service_not_found",
    );
    expect(invalid.status).toBe(400);
    expect(
      Object.keys((await invalid.json()).error.fieldErrors).sort(),
    ).toEqual(["date", "serviceId"]);
  });
});

describe("POST /api/bookings", () => {
  const post = (body: unknown) =>
    postBooking(
      new Request("http://localhost/api/bookings", {
        method: "POST",
        // As the trusted proxy forwards it (the peer address and its secret).
        headers: {
          "x-booking-client-ip": randomIp(),
          "x-booking-proxy-secret": PROXY_SECRET,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  const validBody = () => ({
    slug: business.slug,
    serviceId: service,
    startsAt: zonedLocalToUtc(`${DATE}T10:00`, "Europe/Paris").toISOString(),
    firstName: "Léa",
    lastName: "",
    email: "lea@example.test",
    phone: "",
    requestId: randomUUID(),
  });

  it("creates a booking (201) then refuses the same slot (409)", async () => {
    const created = await post(validBody());
    const createdBody = await created.json();

    expect(created.status).toBe(201);
    expect(createdBody.data.booking).toMatchObject({
      serviceName: "Cil à cil",
      startsAt: validBody().startsAt,
      timezone: "Europe/Paris",
    });

    const conflict = await post({
      ...validBody(),
      email: "other@example.test",
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toEqual({
      code: "slot_unavailable",
      message: "Ce créneau n’est plus disponible. Merci d’en choisir un autre.",
    });
  });

  it("answers 400 with field errors for invalid input or JSON", async () => {
    const invalid = await post({ ...validBody(), firstName: " ", email: "x" });
    const notJson = await post("{oops");

    expect(invalid.status).toBe(400);
    expect(
      Object.keys((await invalid.json()).error.fieldErrors).sort(),
    ).toEqual(["email", "firstName"]);
    expect(notJson.status).toBe(400);
  });

  it("answers 404 for an inactive service", async () => {
    const response = await post({ ...validBody(), serviceId: inactive });

    expect(response.status).toBe(404);
  });
});
