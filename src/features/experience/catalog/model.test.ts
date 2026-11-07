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
