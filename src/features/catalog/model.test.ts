import { describe, expect, it } from "vitest";

import { quote, type PublicCatalogService } from "./model";

// The display mirror of private.quote_options; the integration suite checks
// it against the database for every combination of a real service.

const service: PublicCatalogService = {
  id: "s",
  name: "Pose",
  description: null,
  durationMinutes: 60,
  priceCents: 6000,
  options: [
    {
      id: "longueur",
      question: "Longueur",
      required: true,
      choices: [
        {
          id: "naturelle",
          label: "Naturelle",
          priceDeltaCents: 0,
          durationDeltaMinutes: 0,
        },
        {
          id: "volume",
          label: "Volume",
          priceDeltaCents: 1500,
          durationDeltaMinutes: 30,
        },
      ],
    },
    {
      id: "depose",
      question: "Dépose ?",
      required: false,
      choices: [
        {
          id: "oui",
          label: "Oui",
          priceDeltaCents: 1000,
          durationDeltaMinutes: 15,
        },
      ],
    },
  ],
};

describe("quote", () => {
  it("adds the answers chosen to the service", () => {
    expect(quote(service, ["volume", "oui"])).toEqual({
      ok: true,
      priceCents: 8500,
      durationMinutes: 105,
    });
    expect(quote(service, ["oui", "naturelle"])).toEqual({
      ok: true,
      priceCents: 7000,
      durationMinutes: 75,
    });
  });

  it("an optional group without an answer adds nothing", () => {
    expect(quote(service, ["naturelle"])).toEqual({
      ok: true,
      priceCents: 6000,
      durationMinutes: 60,
    });
  });

  it("a service without options is its own price, whatever is sent", () => {
    const plain = { ...service, options: [] };
    expect(quote(plain, [])).toEqual({
      ok: true,
      priceCents: 6000,
      durationMinutes: 60,
    });
    expect(quote(plain, ["volume"])).toEqual({
      ok: false,
      reason: "option_choice_unavailable",
    });
  });

  it("refuses what the server refuses", () => {
    expect(quote(service, [])).toEqual({
      ok: false,
      reason: "options_required",
    });
    expect(quote(service, ["oui"])).toEqual({
      ok: false,
      reason: "options_required",
    });
    expect(quote(service, ["naturelle", "volume"])).toEqual({
      ok: false,
      reason: "invalid_options",
    });
    expect(quote(service, ["volume", "volume"])).toEqual({
      ok: false,
      reason: "invalid_options",
    });
    expect(quote(service, ["inconnue"])).toEqual({
      ok: false,
      reason: "option_choice_unavailable",
    });
  });
});
