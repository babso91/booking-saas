import { describe, expect, it } from "vitest";

import { startingAt } from "./model";

const choice = (id: string, price: number, minutes: number) => ({
  id,
  label: id,
  priceDeltaCents: price,
  durationDeltaMinutes: minutes,
});

describe("what a service costs and lasts at least, on her site", () => {
  it('without options: its own price and duration, never "dès"', () => {
    expect(
      startingAt({ priceCents: 6000, durationMinutes: 75, options: [] }),
    ).toEqual({
      priceCents: 6000,
      durationMinutes: 75,
      priceVaries: false,
      durationVaries: false,
    });
  });

  it('a required group adds its smallest answer; any answer that adds says "dès"', () => {
    expect(
      startingAt({
        priceCents: 6000,
        durationMinutes: 75,
        options: [
          {
            id: "length",
            question: "Longueur",
            required: true,
            choices: [choice("long", 2500, 30), choice("mid", 1000, 15)],
          },
          {
            id: "care",
            question: "Soin",
            required: false,
            choices: [choice("serum", 800, 0)],
          },
        ],
      }),
    ).toEqual({
      priceCents: 7000,
      durationMinutes: 90,
      priceVaries: true,
      durationVaries: true,
    });
  });

  it("an optional group adds nothing until chosen", () => {
    expect(
      startingAt({
        priceCents: 3500,
        durationMinutes: 30,
        options: [
          {
            id: "care",
            question: "Soin",
            required: false,
            choices: [choice("serum", 0, 10)],
          },
        ],
      }),
    ).toEqual({
      priceCents: 3500,
      durationMinutes: 30,
      priceVaries: false,
      durationVaries: true,
    });
  });
});

describe("prices in her catalogue's currency (Codex review of #50)", () => {
  it("showcaseOf gives every service its catalogue's currency", async () => {
    const { showcaseOf } = await import("./model");
    const service = {
      id: "s1",
      name: "Pose",
      description: null,
      durationMinutes: 60,
      priceCents: 4500,
      options: [],
    };
    const groups = showcaseOf({
      currency: "CHF",
      groups: [{ category: null, services: [service] }],
    });
    expect(groups[0]!.services[0]!.currency).toBe("CHF");
  });

  it("euros keep their format; another currency is said as such, never as euros", async () => {
    const { euros, price } = await import("../engine/engine");
    expect(euros(2500)).toBe("25 €");
    expect(euros(1250)).toBe("12,50 €");
    expect(price(0)).toBe("Offert");
    expect(price(2500, "EUR")).toBe("25 €");
    const chf = price(4500, "CHF");
    expect(chf).toMatch(/CHF/);
    expect(chf).not.toMatch(/€/);
    expect(euros(1250, "CHF")).toMatch(/12,50/);
  });
});
