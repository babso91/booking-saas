import { describe, expect, it } from "vitest";

import {
  checkService,
  draftFromService,
  durationLabel,
  parsePriceCents,
  priceInput,
  serviceChanges,
  serviceFieldErrors,
} from "./service-form";

const service = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Rehaussement de cils",
  description: null,
  durationMinutes: 75,
  priceCents: 6500,
  active: true,
  displayOrder: 0,
  version: 1,
};

describe("service form", () => {
  it("reads prices as exact cents, without floating point", () => {
    expect(parsePriceCents("45")).toBe(4500);
    expect(parsePriceCents("45,5")).toBe(4550);
    expect(parsePriceCents("45.05")).toBe(4505);
    expect(parsePriceCents(" 1 234,56 € ")).toBe(123456);
    expect(parsePriceCents("0")).toBe(0);
    // 0.1 + 0.2 territory stays exact.
    expect(parsePriceCents("0,29")).toBe(29);
    for (const invalid of ["", "-5", "4,555", "abc", "45,", ",5", "1e3"]) {
      expect(parsePriceCents(invalid)).toBeNull();
    }
    expect(priceInput(4550)).toBe("45,50");
    expect(priceInput(4500)).toBe("45");
  });

  it("labels durations as people say them", () => {
    expect(durationLabel(45)).toBe("45 min");
    expect(durationLabel(60)).toBe("1 h");
    expect(durationLabel(75)).toBe("1 h 15");
    expect(durationLabel(125)).toBe("2 h 05");
  });

  it("checks what the backend refuses (name, 5 to 720 minutes, price), in words", () => {
    expect(
      checkService({ name: "  ", description: "", duration: "3", price: "x" }),
    ).toEqual({
      ok: false,
      errors: {
        name: "Donne un nom à la prestation.",
        duration: "Indique une durée en minutes (5 minimum).",
        price: "Indique un prix, par exemple 45 ou 45,50.",
      },
    });
    expect(
      checkService({ name: "a", description: "", duration: "721", price: "1" }),
    ).toMatchObject({
      ok: false,
      errors: { duration: "Durée limitée à 12 heures." },
    });
    expect(
      checkService({
        name: "a",
        description: "",
        duration: "60",
        price: "100001",
      }),
    ).toMatchObject({ ok: false, errors: { price: "Prix trop élevé." } });
    expect(
      checkService({
        name: " Pose cil à cil ",
        description: "  ",
        duration: "120",
        price: "110",
      }),
    ).toEqual({
      ok: true,
      command: {
        name: "Pose cil à cil",
        description: null,
        durationMinutes: 120,
        priceCents: 11000,
      },
    });
  });

  it("an edit sends only what changed", () => {
    const draft = { ...draftFromService(service), price: "70" };
    const checked = checkService(draft);
    if (!checked.ok) throw new Error("valid");
    expect(serviceChanges(service, checked.command)).toEqual({
      priceCents: 7000,
    });
    const same = checkService(draftFromService(service));
    if (!same.ok) throw new Error("valid");
    expect(serviceChanges(service, same.command)).toEqual({});
  });

  it("names the refused fields of a write, never with the backend's text", () => {
    expect(
      serviceFieldErrors({
        "changes.durationMinutes": ["backend"],
        priceCents: ["backend"],
        unknown: ["backend"],
      }),
    ).toEqual({
      duration: "Durée entre 5 minutes et 12 heures.",
      price: "Vérifie le prix.",
    });
  });
});
