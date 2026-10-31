import { describe, expect, it } from "vitest";

import {
  appearancePreferencesSchema,
  changesBetween,
  defaultAppearancePreferences,
  fromDatabaseRow,
  importDeviceAppearanceSchema,
  renderableAppearance,
  savePreferencesSchema,
  toDatabaseChanges,
} from "./model";

describe("preferences model", () => {
  it("has the defaults Studio 1 renders without a cookie", () => {
    // src/features/appearance/appearance.ts (#28): defaultAppearance.
    expect(defaultAppearancePreferences).toEqual({
      style: "classique",
      ambiance: "atelier",
      mode: "light",
      accent: null,
      motion: "standard",
    });
  });

  it("accepts every value of Studio 1's engine, and the styles to come", () => {
    for (const style of ["classique", "studio", "ecrin", "carnet"] as const) {
      for (const ambiance of ["atelier", "lin", "sauge"] as const) {
        for (const mode of ["light", "dark", "system"] as const) {
          for (const motion of ["standard", "discrete", "none"] as const) {
            const value = { style, ambiance, mode, motion, accent: "#97493A" };
            expect(appearancePreferencesSchema.parse(value)).toEqual(value);
          }
        }
      }
    }
  });

  it("stores an accent in capitals, whatever case she typed", () => {
    expect(
      savePreferencesSchema.parse({
        expectedVersion: 2,
        changes: { accent: "#97493a" },
      }),
    ).toEqual({ expectedVersion: 2, changes: { accent: "#97493A" } });
  });

  it.each([
    ["no change", { expectedVersion: 0, changes: {} }],
    ["an unknown field", { expectedVersion: 0, changes: { theme: "dark" } }],
    [
      "a business id",
      { expectedVersion: 0, changes: { style: "studio" }, businessId: "x" },
    ],
    [
      "a user id in the changes",
      { expectedVersion: 0, changes: { userId: "x" } },
    ],
    [
      "a negative version",
      { expectedVersion: -1, changes: { style: "studio" } },
    ],
    [
      "a fractional version",
      { expectedVersion: 1.5, changes: { style: "studio" } },
    ],
    [
      "a version as text",
      { expectedVersion: "1", changes: { style: "studio" } },
    ],
    ["an unknown style", { expectedVersion: 0, changes: { style: "minimal" } }],
    ["a short accent", { expectedVersion: 0, changes: { accent: "#FFF" } }],
    ["a named colour", { expectedVersion: 0, changes: { accent: "red" } }],
    [
      "CSS in an accent",
      { expectedVersion: 0, changes: { accent: "#000000;x" } },
    ],
    [
      "a prototype key",
      JSON.parse(
        '{"expectedVersion":0,"changes":{"__proto__":{"style":"studio"}}}',
      ),
    ],
  ])("refuses %s", (_label, input) => {
    expect(savePreferencesSchema.safeParse(input).success).toBe(false);
  });

  it("an import carries a whole appearance, nothing else", () => {
    expect(
      importDeviceAppearanceSchema.safeParse({
        appearance: { ...defaultAppearancePreferences, style: "studio" },
      }).success,
    ).toBe(true);
    expect(
      importDeviceAppearanceSchema.safeParse({
        appearance: { style: "studio" },
      }).success,
    ).toBe(false);
  });

  it("names the database's fields in a patch, and only the changed ones", () => {
    expect(toDatabaseChanges({ mode: "dark", accent: null })).toEqual({
      color_mode: "dark",
      accent: null,
    });
    expect(
      changesBetween(defaultAppearancePreferences, {
        ...defaultAppearancePreferences,
        motion: "none",
      }),
    ).toEqual({ motion: "none" });
  });

  it("a row with a value this build does not know reads as the default for that field", () => {
    expect(
      fromDatabaseRow({
        style: "aurore",
        ambiance: "lin",
        color_mode: "dark",
        accent: "not-a-colour",
        motion: "turbo",
        version: 7,
      }),
    ).toEqual({
      appearance: {
        style: "classique",
        ambiance: "lin",
        mode: "dark",
        accent: null,
        motion: "standard",
      },
      version: 7,
    });
  });

  it("a style not shipped yet renders as Classique, without its accent; her account is not changed", () => {
    const ecrin = {
      ...defaultAppearancePreferences,
      style: "ecrin" as const,
      accent: "#2F6F5E",
      mode: "dark" as const,
    };
    expect(
      renderableAppearance(ecrin, ["classique", "studio"] as const),
    ).toEqual({
      ...ecrin,
      style: "classique",
      accent: null,
    });
    expect(
      renderableAppearance(ecrin, ["classique", "studio", "ecrin"] as const),
    ).toEqual(ecrin);
  });
});
