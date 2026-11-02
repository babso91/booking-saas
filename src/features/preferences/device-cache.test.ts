import { describe, expect, it } from "vitest";

import {
  parseDeviceCache,
  parseLegacyAppearanceCookie,
  serializeDeviceCache,
} from "./device-cache";
import { defaultAppearancePreferences } from "./model";

const owner = "a".repeat(32);
const other = "b".repeat(32);
const M = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const cached = {
  membershipId: M,
  preferences: {
    appearance: {
      style: "ecrin" as const,
      ambiance: "sauge" as const,
      mode: "system" as const,
      accent: "#2F6F5E",
      motion: "discrete" as const,
    },
    incarnation: R,
    version: 12,
  },
};
const tail = "ecrin.sauge.system.discrete.2F6F5E";

describe("device cache", () => {
  it("reads back what it wrote, for its owner only", () => {
    const value = serializeDeviceCache(owner, cached);
    expect(value).toBe(`2.${owner}.${M}.${R}.12.${tail}`);
    expect(parseDeviceCache(value, owner)).toEqual(cached);
    expect(parseDeviceCache(value, other)).toBeNull();
  });

  it("no row: no incarnation ('-'), version 0; no accent is '-'", () => {
    const none = {
      membershipId: M,
      preferences: {
        appearance: defaultAppearancePreferences,
        incarnation: null,
        version: 0,
      },
    };
    expect(parseDeviceCache(serializeDeviceCache(owner, none), owner)).toEqual(
      none,
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["of format 1 (before incarnations)", `1.${owner}.12.${tail}`],
    ["of an unknown format", `3.${owner}.${M}.${R}.12.${tail}`],
    ["a field missing", `2.${owner}.${M}.${R}.12.ecrin.sauge.system.discrete`],
    ["a field too many", `2.${owner}.${M}.${R}.12.${tail}.x`],
    ["a bad membership", `2.${owner}.not-a-uuid.${R}.12.${tail}`],
    ["a bad incarnation", `2.${owner}.${M}.xyz.12.${tail}`],
    ["an incarnation at version 0", `2.${owner}.${M}.${R}.0.${tail}`],
    ["no incarnation at version 3", `2.${owner}.${M}.-.3.${tail}`],
    [
      "an unknown style",
      `2.${owner}.${M}.${R}.12.aurore.sauge.system.discrete.-`,
    ],
    [
      "a prototype key",
      `2.${owner}.${M}.${R}.12.ecrin.constructor.system.discrete.-`,
    ],
    [
      "a bad accent",
      `2.${owner}.${M}.${R}.12.ecrin.sauge.system.discrete.2F6F5`,
    ],
    ["a bad version", `2.${owner}.${M}.${R}.-1.${tail}`],
    ["a version with leading zero", `2.${owner}.${M}.${R}.012.${tail}`],
    ["a huge value", `2.${owner}.${"9".repeat(400)}`],
  ])("ignores a cache that is %s", (_label, raw) => {
    expect(parseDeviceCache(raw, owner)).toBeNull();
  });
});

describe("Studio 1's device cookie (dash_appearance)", () => {
  it("reads its five-field values", () => {
    expect(parseLegacyAppearanceCookie("lin.dark.none.97493a.studio")).toEqual({
      style: "studio",
      ambiance: "lin",
      mode: "dark",
      accent: "#97493A",
      motion: "none",
    });
  });

  it("reads its four-field values (before styles) as Classique", () => {
    expect(parseLegacyAppearanceCookie("atelier.system.standard.-")).toEqual({
      ...defaultAppearancePreferences,
      mode: "system",
    });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["three fields", "atelier.light.standard"],
    ["six fields", "atelier.light.standard.-.studio.x"],
    ["an unknown ambiance", "jungle.light.standard.-.studio"],
    ["a prototype key", "__proto__.light.standard.-.studio"],
    ["an unknown style", "atelier.light.standard.-.minimal"],
    ["a bad accent", "atelier.light.standard.zzzzzz.studio"],
    ["an accent with #", "atelier.light.standard.#97493a.studio"],
    ["script", "atelier.light.standard.-.<script>"],
  ])("offers nothing for a cookie that is %s", (_label, raw) => {
    expect(parseLegacyAppearanceCookie(raw)).toBeNull();
  });
});
