import { describe, expect, it } from "vitest";

import {
  directionsHref,
  emptyPractical,
  hourLabel,
  practicalItems,
  telHref,
  usualWeek,
  type UsualHours,
} from "./practical";

const week: UsualHours[] = [
  { weekday: 1, startsAt: "14:00", endsAt: "19:00" },
  { weekday: 1, startsAt: "09:00", endsAt: "12:30" },
  { weekday: 6, startsAt: "10:00", endsAt: "17:00" },
];

describe("usualWeek", () => {
  it("lists Monday first, several ranges a day in order, closed days", () => {
    const days = usualWeek(week);
    expect(days[0]).toEqual({
      day: "Lundi",
      ranges: "9 h – 12 h 30, 14 h – 19 h",
    });
    expect(days[1]).toEqual({ day: "Mardi", ranges: "Fermé" });
    expect(days[5]).toEqual({ day: "Samedi", ranges: "10 h – 17 h" });
    expect(days[6]).toEqual({ day: "Dimanche", ranges: "Fermé" });
  });

  it("writes hours the French way", () => {
    expect(hourLabel("09:00")).toBe("9 h");
    expect(hourLabel("12:30")).toBe("12 h 30");
  });
});

describe("practicalItems", () => {
  it("shows nothing for a version published before the block", () => {
    expect(
      practicalItems({
        practical: undefined,
        hours: week,
        cancellationPolicy: null,
      }),
    ).toEqual([]);
  });

  it("keeps the cancellation terms she already publishes", () => {
    const items = practicalItems({
      practical: undefined,
      hours: week,
      cancellationPolicy: "Annulation gratuite jusqu’à 24 h avant.",
    });
    expect(items.map((item) => item.label)).toEqual(["Annulation"]);
  });

  it("her WhatsApp joins her contact when it is an international number (point 4)", () => {
    const contact = (whatsapp: string) =>
      practicalItems({
        practical: { ...emptyPractical, whatsapp },
        hours: null,
        cancellationPolicy: null,
      }).at(-1);
    expect(contact("+33 6 12 34 56 78")).toEqual({
      kind: "contact",
      label: "Contact",
      phone: null,
      email: null,
      whatsapp: "+33 6 12 34 56 78",
    });
    expect(contact("06 12 34 56 78")).toBeUndefined();
  });

  it("her conditions follow her cancellation terms (point 6)", () => {
    const items = practicalItems({
      practical: {
        ...emptyPractical,
        lateness: "Au-delà de 15 minutes, la prestation peut être écourtée.",
        noShow: " ",
        companions: "Les enfants ne peuvent pas être accueillis.",
      },
      hours: null,
      cancellationPolicy: "Annulation gratuite jusqu’à 24 h avant.",
    });
    expect(items.map((item) => item.label)).toEqual([
      "Annulation",
      "Retard",
      "Accompagnants",
    ]);
  });

  it("shows only what she filled in, in a client's order", () => {
    const items = practicalItems({
      practical: {
        ...emptyPractical,
        address: "12 rue Mercière, 69002 Lyon",
        access: "  ",
        instructions: "Venir démaquillée.",
        phone: "06 12 34 56 78",
      },
      hours: week,
      cancellationPolicy: null,
    });
    expect(items.map((item) => item.label)).toEqual([
      "Adresse",
      "Horaires habituels",
      "Avant de venir",
      "Contact",
    ]);
    expect(items.at(-1)).toEqual({
      kind: "contact",
      label: "Contact",
      phone: "06 12 34 56 78",
      email: null,
      whatsapp: null,
    });
  });

  it("hides her hours when she asks, or when her schedule has none", () => {
    const labels = (showHours: boolean, hours: UsualHours[] | null) =>
      practicalItems({
        practical: { ...emptyPractical, showHours },
        hours,
        cancellationPolicy: null,
      }).map((item) => item.label);
    expect(labels(false, week)).toEqual([]);
    expect(labels(true, [])).toEqual([]);
    expect(labels(true, null)).toEqual([]);
    expect(labels(true, week)).toEqual(["Horaires habituels"]);
  });
});

describe("links", () => {
  it("dials the digits of her number", () => {
    expect(telHref("+33 6 12 34 56 78")).toBe("tel:+33612345678");
  });

  it("asks for directions to her address", () => {
    expect(directionsHref("12 rue Mercière, Lyon")).toBe(
      "https://www.google.com/maps/search/?api=1&query=12%20rue%20Merci%C3%A8re%2C%20Lyon",
    );
  });
});
