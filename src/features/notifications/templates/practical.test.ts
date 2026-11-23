import { describe, expect, it } from "vitest";

import type { ClaimedEmail } from "../schemas/claimed-email";
import { practicalLines, practicalOf } from "./practical";
import { renderEmail } from "./render";

// Point 153: her published "Infos pratiques" in her customers' emails.

const APP_URL = "https://booking.example.test";

function email(
  type: ClaimedEmail["type"] = "booking_confirmation",
): ClaimedEmail {
  return {
    id: "8a6f3e52-6a0e-4c1f-9d8e-0f6b2c1d3e4f",
    claimId: "0b2c7d3e-1f4a-4b5c-8d6e-7f8a9b0c1d2e",
    businessId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    type,
    attempt: 1,
    recipient: "lea@example.test",
    business: {
      name: "Studio Mila",
      slug: "studio-mila",
      contactEmail: "contact@studio-mila.test",
      phone: null,
      location: "Lyon",
      timezone: "Europe/Paris",
    },
    message: null,
    appointment: {
      id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
      version: 1,
      status: "confirmed",
      startsAt: "2026-10-24T08:30:00.000Z",
      endsAt: "2026-10-24T10:00:00.000Z",
      localStartsAt: "2026-10-24T10:30",
      localEndsAt: "2026-10-24T12:00",
      serviceName: "Volume mixte",
      durationMinutes: 90,
      priceCents: 8500,
      currency: "EUR",
      clientFirstName: "Léa",
    },
  };
}

const published = {
  universe: "mila",
  practical: {
    address: "12 rue des Lilas\n69003 Lyon",
    area: "",
    access: "Interphone « Mila », 2e étage.",
    instructions: "Venez sans mascara.\n\nPrévoyez 10 minutes <de> plus.",
    payment: "",
    accessibility: "   ",
    phone: "",
    email: "",
    showHours: true,
  },
};

describe("practicalOf", () => {
  it("keeps what she filled in, line by line, and her precise address", () => {
    expect(practicalOf(published)).toEqual({
      address: "12 rue des Lilas, 69003 Lyon",
      items: [
        { label: "Accès", lines: ["Interphone « Mila », 2e étage."] },
        {
          label: "Avant de venir",
          lines: ["Venez sans mascara.", "Prévoyez 10 minutes <de> plus."],
        },
      ],
    });
  });

  it("says nothing when her site says nothing, or cannot be read", () => {
    expect(practicalOf({ universe: "mila" })).toBeNull();
    expect(
      practicalOf({ practical: { access: "", instructions: " " } }),
    ).toBeNull();
    expect(practicalOf({ practical: "not an object" })).toBeNull();
    expect(practicalOf(null)).toBeNull();
    expect(
      practicalOf({ practical: { access: 12, payment: "Espèces" } }),
    ).toEqual({
      address: null,
      items: [{ label: "Paiement", lines: ["Espèces"] }],
    });
  });

  it("drops control characters and keeps 8 lines at most", () => {
    expect(practicalLines("a\u0007b c")).toEqual(["a b c"]);
    expect(
      practicalLines(Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n")),
    ).toHaveLength(8);
  });
});

describe("renderEmail with her Infos pratiques", () => {
  it("adds them to a confirmation, escaped in HTML, her precise address first", () => {
    const rendered = renderEmail(email(), {
      appUrl: APP_URL,
      practical: practicalOf(published),
    });
    expect(rendered.text).toContain("Adresse : 12 rue des Lilas, 69003 Lyon");
    expect(rendered.text).not.toContain("Adresse : Lyon");
    expect(rendered.text).toContain(
      [
        "Infos pratiques",
        "Accès : Interphone « Mila », 2e étage.",
        "Avant de venir :",
        "Venez sans mascara.",
        "Prévoyez 10 minutes <de> plus.",
      ].join("\n"),
    );
    expect(rendered.html).toContain("<strong>Infos pratiques</strong>");
    expect(rendered.html).toContain(
      "Venez sans mascara.<br>Prévoyez 10 minutes &lt;de&gt; plus.",
    );
    expect(rendered.html).not.toContain("<de>");
  });

  it("in a reminder and a change too, never in a cancellation", () => {
    const practical = practicalOf(published);
    for (const type of [
      "appointment_reminder",
      "appointment_changed",
    ] as const) {
      expect(
        renderEmail(email(type), { appUrl: APP_URL, practical }).text,
      ).toContain("Infos pratiques");
    }
    const cancelled = renderEmail(email("appointment_cancelled"), {
      appUrl: APP_URL,
      practical,
    });
    expect(cancelled.text).not.toContain("Infos pratiques");
    expect(cancelled.text).not.toContain("Interphone");
    expect(cancelled.html).not.toContain("Interphone");
  });

  it("without them, the email is the one she had", () => {
    expect(renderEmail(email(), { appUrl: APP_URL, practical: null })).toEqual(
      renderEmail(email(), { appUrl: APP_URL }),
    );
    expect(renderEmail(email(), { appUrl: APP_URL }).text).toContain(
      "Adresse : Lyon",
    );
  });
});
