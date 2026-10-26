import { describe, expect, it } from "vitest";

import type { ClaimedEmail } from "../schemas/claimed-email";
import {
  escapeHtml,
  formatDuration,
  formatLocalDate,
  formatLocalTime,
  renderEmail,
  singleLine,
} from "./render";

const APP_URL = "https://booking.example.test";

function email(overrides: Partial<ClaimedEmail> = {}): ClaimedEmail {
  return {
    id: "8a6f3e52-6a0e-4c1f-9d8e-0f6b2c1d3e4f",
    claimId: "0b2c7d3e-1f4a-4b5c-8d6e-7f8a9b0c1d2e",
    businessId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    type: "booking_confirmation",
    attempt: 1,
    recipient: "lea@example.test",
    business: {
      name: "Studio Mila",
      slug: "studio-mila",
      contactEmail: "contact@studio-mila.test",
      phone: "01 23 45 67 89",
      location: "12 rue des Lilas, Lyon",
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
    ...overrides,
  };
}

describe("formatting", () => {
  it("formats the business wall clock without any time zone conversion", () => {
    expect(formatLocalDate("2026-10-24T10:30")).toBe("samedi 24 octobre 2026");
    expect(formatLocalDate("2027-03-01T00:15")).toBe("lundi 1 mars 2027");
    expect(formatLocalTime("2026-10-24T10:30")).toBe("10 h 30");
    expect(formatLocalTime("2026-10-24T09:00")).toBe("9 h");
    expect(formatLocalTime("2026-10-24T00:05")).toBe("0 h 05");
  });

  it("names every month in French, accents included, and the integration tests' date pattern accepts each", () => {
    // `\w` is ASCII only, even with the u flag: it never matches the é of
    // février or décembre, nor the û of août. The integration tests'
    // pattern uses \p{L} (any letter) and must accept every month.
    const pattern = /^\p{L}+ \d{1,2} \p{L}+ \d{4}$/u;
    const months = [
      ["2027-01-15T10:00", "vendredi 15 janvier 2027"],
      ["2027-02-15T10:00", "lundi 15 février 2027"],
      ["2027-03-15T10:00", "lundi 15 mars 2027"],
      ["2027-04-15T10:00", "jeudi 15 avril 2027"],
      ["2027-05-15T10:00", "samedi 15 mai 2027"],
      ["2027-06-15T10:00", "mardi 15 juin 2027"],
      ["2027-07-15T10:00", "jeudi 15 juillet 2027"],
      ["2027-08-15T10:00", "dimanche 15 août 2027"],
      ["2027-09-15T10:00", "mercredi 15 septembre 2027"],
      ["2027-10-15T10:00", "vendredi 15 octobre 2027"],
      ["2027-11-15T10:00", "lundi 15 novembre 2027"],
      ["2027-12-15T10:00", "mercredi 15 décembre 2027"],
    ] as const;
    for (const [local, expected] of months) {
      const formatted = formatLocalDate(local);
      expect(formatted).toBe(expected);
      expect(formatted, formatted).toMatch(pattern);
    }
    // The ASCII-only pattern the tests used before fails on accented months.
    const ascii = /^\w+ \d{1,2} \w+ \d{4}$/u;
    expect(
      months.filter(([local]) => !ascii.test(formatLocalDate(local))).length,
    ).toBe(3);
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(90)).toBe("1 h 30");
    expect(formatDuration(125)).toBe("2 h 05");
  });

  it("keeps a value on one line and escapes markup", () => {
    expect(singleLine("Studio\r\nBcc: x@y.z fin")).toBe(
      "Studio Bcc: x@y.z fin",
    );
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("renderEmail", () => {
  it("a confirmation gives every detail of the appointment", () => {
    const { subject, text, html } = renderEmail(email(), { appUrl: APP_URL });
    expect(subject).toBe("Rendez-vous confirmé – Studio Mila");
    expect(text).toContain("Bonjour Léa,");
    expect(text).toContain("Établissement : Studio Mila");
    expect(text).toContain("Prestation : Volume mixte");
    expect(text).toContain("Date : samedi 24 octobre 2026 à 10 h 30");
    expect(text).toContain("Durée : 1 h 30");
    expect(text).toMatch(/Prix : 85,00\s€/u);
    expect(text).toContain("Adresse : 12 rue des Lilas, Lyon");
    expect(text).toContain("(Europe/Paris)");
    expect(text).toContain(
      "Pour modifier ou annuler, contactez Studio Mila par téléphone au 01 23 45 67 89 ou en répondant à cet email.",
    );
    expect(text).toContain(`${APP_URL}/b/studio-mila`);
    expect(html).toContain("Volume mixte");
    expect(html).toContain(`href="${APP_URL}/b/studio-mila"`);
    // Never a promise the product cannot keep (no cancellation link exists).
    expect(text).not.toMatch(/cliquez|lien d.annulation/iu);
  });

  it("each type has its own subject and lead", () => {
    const subjects = (
      [
        "booking_confirmation",
        "appointment_reminder",
        "appointment_changed",
        "appointment_cancelled",
      ] as const
    ).map((type) => renderEmail(email({ type }), { appUrl: APP_URL }).subject);
    expect(subjects).toEqual([
      "Rendez-vous confirmé – Studio Mila",
      "Rappel de votre rendez-vous – Studio Mila",
      "Rendez-vous modifié – Studio Mila",
      "Rendez-vous annulé – Studio Mila",
    ]);
  });

  it("a cancellation gives no price nor address, and offers to book again", () => {
    const { text } = renderEmail(email({ type: "appointment_cancelled" }), {
      appUrl: APP_URL,
    });
    expect(text).toContain("Votre rendez-vous a été annulé");
    expect(text).not.toContain("Prix");
    expect(text).not.toContain("Adresse");
    expect(text).toContain(
      `Pour reprendre rendez-vous : ${APP_URL}/b/studio-mila`,
    );
  });

  it("works without first name, phone nor address", () => {
    const base = email();
    const { text } = renderEmail(
      {
        ...base,
        business: { ...base.business, phone: null, location: null },
        appointment: { ...base.appointment, clientFirstName: null },
      },
      { appUrl: APP_URL },
    );
    expect(text.startsWith("Bonjour,\n")).toBe(true);
    expect(text).not.toContain("Adresse");
    expect(text).toContain(
      "Pour modifier ou annuler, contactez Studio Mila en répondant à cet email.",
    );
  });

  it("business data never injects headers nor markup", () => {
    const base = email();
    const { subject, html } = renderEmail(
      {
        ...base,
        business: {
          ...base.business,
          name: 'Studio <script>alert("x")</script>\r\nBcc: v@x.test',
          slug: "a/../b?c",
        },
        appointment: {
          ...base.appointment,
          serviceName: "<img src=x onerror=alert(1)>",
        },
      },
      { appUrl: APP_URL },
    );
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain(`${APP_URL}/b/a%2F..%2Fb%3Fc`);
  });
});
