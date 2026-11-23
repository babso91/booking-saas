import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { createPublicBookingSchema } from "@/features/appointments/schemas/public-booking";
import { runEmailOutbox } from "@/features/notifications/data/worker";
import { MemoryTransport } from "@/features/notifications/transport/memory";
import { publishSite, saveSiteDraft } from "@/features/sites/data/sites";
import { sampleSiteConfig } from "@/features/sites/site-fixture";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  bookingClient,
  createBusiness,
  createProfessional,
  createService,
  dateInDays,
  everyDay,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Point 153 (Higani backlog): her customers' emails carry her published
// "Infos pratiques" (how to get in, what to bring, how to pay), the words
// she wrote once in her studio. Her draft is never read; an unreadable
// site never holds an email back. Real PostgreSQL, the real worker, an
// in-memory transport.

const FROM = "Higani <reservations@example.test>";
const APP_URL = "http://localhost:3000";

let owner: Professional;

const practical = {
  address: "12 rue des Lilas, 69003 Lyon",
  area: "",
  access: "Interphone « Mila », 2e étage.",
  instructions: "Venez sans mascara.\nPrévoyez 10 minutes de plus.",
  payment: "Carte ou espèces.",
  accessibility: "",
  phone: "",
  email: "",
  showHours: true,
};

beforeAll(async () => {
  owner = await createProfessional("email-practical");
});

async function studio(label: string) {
  const business = await createBusiness(owner.userId, {
    name: `Studio ${label}`,
    settings: {
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 60,
    },
  });
  const service = await createService(business.id, { name: "Volume mixte" });
  await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
  return { business, service };
}

const writer = (business: TestBusiness) => ({
  service: bookingClient(),
  businessId: business.id,
  actor: owner.userId,
});

async function book(business: TestBusiness, service: string) {
  return createPublicBooking(
    bookingClient(),
    createPublicBookingSchema.parse({
      slug: business.slug,
      serviceId: service,
      startsAt: zonedLocalToUtc(
        `${dateInDays(3)}T10:30`,
        business.timezone,
      ).toISOString(),
      firstName: "Léa",
      email: `lea-${randomUUID().slice(0, 6)}@example.test`,
      requestId: randomUUID(),
    }),
    randomIp(),
  );
}

function send(
  business: TestBusiness,
  transport: MemoryTransport,
  readPractical?: () => Promise<never>,
) {
  return runEmailOutbox(
    {
      admin: bookingClient(),
      transport,
      from: FROM,
      appUrl: APP_URL,
      ...(readPractical ? { practical: readPractical } : {}),
    },
    { businessId: business.id },
  );
}

describe("point 153: her Infos pratiques in her customers' emails", () => {
  it("the confirmation carries what she published, never her draft", async () => {
    const { business, service } = await studio("Mila");
    await saveSiteDraft(writer(business), {
      expectedRevision: 0,
      config: sampleSiteConfig({ practical }),
    });
    await publishSite(writer(business), 1);
    // Changed since, not published: her customers do not read it yet.
    await saveSiteDraft(writer(business), {
      expectedRevision: 1,
      config: sampleSiteConfig({
        practical: { ...practical, access: "BROUILLON code 0000" },
      }),
    });

    await book(business, service);
    const transport = new MemoryTransport();
    expect(await send(business, transport)).toMatchObject({ sent: 1 });
    const [message] = transport.sent;
    expect(message!.text).toContain("Adresse : 12 rue des Lilas, 69003 Lyon");
    expect(message!.text).toContain(
      [
        "Infos pratiques",
        "Accès : Interphone « Mila », 2e étage.",
        "Avant de venir :",
        "Venez sans mascara.",
        "Prévoyez 10 minutes de plus.",
        "Paiement : Carte ou espèces.",
      ].join("\n"),
    );
    expect(message!.html).toContain("<strong>Infos pratiques</strong>");
    expect(message!.text).not.toContain("BROUILLON");
    expect(message!.html).not.toContain("BROUILLON");
  });

  it("without a published site, the email is as before", async () => {
    const { business, service } = await studio("Nora");
    await book(business, service);
    const transport = new MemoryTransport();
    expect(await send(business, transport)).toMatchObject({ sent: 1 });
    expect(transport.sent[0]!.text).not.toContain("Infos pratiques");
  });

  it("an unreadable site never holds the email back", async () => {
    const { business, service } = await studio("Inès");
    await saveSiteDraft(writer(business), {
      expectedRevision: 0,
      config: sampleSiteConfig({ practical }),
    });
    await publishSite(writer(business), 1);
    await book(business, service);
    const transport = new MemoryTransport();
    const result = await send(business, transport, async () => {
      throw new Error("site unreadable");
    });
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(transport.sent[0]!.text).toContain(
      "Votre rendez-vous est confirmé.",
    );
    expect(transport.sent[0]!.text).not.toContain("Infos pratiques");
  });
});
