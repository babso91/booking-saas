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

const CONTEXT = {
  businessId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
};
const ROW = "33333333-3333-4333-8333-333333333333";
const at = (version: number) => ({
  incarnation: version === 0 ? null : ROW,
  version,
});
/** A save input, with `expected` given as a version (0: no row). */
const save = (version: unknown, changes: unknown, extra: object = {}) => ({
  context: CONTEXT,
  expected:
    typeof version === "number" && Number.isInteger(version) && version >= 0
      ? at(version)
      : { incarnation: ROW, version },
  changes,
  ...extra,
});

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
    expect(savePreferencesSchema.parse(save(2, { accent: "#97493a" }))).toEqual(
      save(2, { accent: "#97493A" }),
    );
  });

  it.each([
    ["no change", save(0, {})],
    ["an unknown field", save(0, { theme: "dark" })],
    ["a business id", save(0, { style: "studio" }, { businessId: "x" })],
    ["a user id in the changes", save(0, { userId: "x" })],
    ["a negative version", save(-1, { style: "studio" })],
    ["a fractional version", save(1.5, { style: "studio" })],
    ["a version as text", save("1", { style: "studio" })],
    ["an unknown style", save(0, { style: "minimal" })],
    ["a short accent", save(0, { accent: "#FFF" })],
    ["a named colour", save(0, { accent: "red" })],
    ["CSS in an accent", save(0, { accent: "#000000;x" })],
    [
      "a prototype key",
      save(0, JSON.parse('{"__proto__":{"style":"studio"}}')),
    ],
  ])("refuses %s", (_label, input) => {
    expect(savePreferencesSchema.safeParse(input).success).toBe(false);
  });

  it("an import carries a whole appearance, nothing else", () => {
    expect(
      importDeviceAppearanceSchema.safeParse({
        context: CONTEXT,
        appearance: { ...defaultAppearancePreferences, style: "studio" },
      }).success,
    ).toBe(true);
    expect(
      importDeviceAppearanceSchema.safeParse({
        context: CONTEXT,
        appearance: { style: "studio" },
      }).success,
    ).toBe(false);
    expect(
      importDeviceAppearanceSchema.safeParse({
        appearance: { ...defaultAppearancePreferences, style: "studio" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["no context", { expected: at(0), changes: { style: "studio" } }],
    [
      "a context without membership",
      save(
        0,
        { style: "studio" },
        { context: { businessId: CONTEXT.businessId } },
      ),
    ],
    [
      "a context with a user id",
      save(0, { style: "studio" }, { context: { ...CONTEXT, userId: ROW } }),
    ],
    [
      "a row id with version 0",
      {
        context: CONTEXT,
        expected: { incarnation: ROW, version: 0 },
        changes: { style: "studio" },
      },
    ],
    [
      "no row id with version 3",
      {
        context: CONTEXT,
        expected: { incarnation: null, version: 3 },
        changes: { style: "studio" },
      },
    ],
    [
      "a row id that is not a uuid",
      {
        context: CONTEXT,
        expected: { incarnation: "x", version: 1 },
        changes: { style: "studio" },
      },
    ],
  ])("refuses a save with %s", (_label, input) => {
    expect(savePreferencesSchema.safeParse(input).success).toBe(false);
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
        incarnation: ROW,
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
      incarnation: ROW,
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
