import { describe, expect, it } from "vitest";

import {
  parseDeviceCache,
  parseLegacyAppearanceCookie,
  serializeDeviceCache,
} from "./device-cache";
import { defaultAppearancePreferences } from "./model";

const owner = "a".repeat(32);
const other = "b".repeat(32);
const cached = {
  appearance: {
    style: "ecrin" as const,
    ambiance: "sauge" as const,
    mode: "system" as const,
    accent: "#2F6F5E",
    motion: "discrete" as const,
  },
  version: 12,
};

describe("device cache", () => {
  it("reads back what it wrote, for its owner only", () => {
    const value = serializeDeviceCache(owner, cached);
    expect(value).toBe(`1.${owner}.12.ecrin.sauge.system.discrete.2F6F5E`);
    expect(parseDeviceCache(value, owner)).toEqual(cached);
    expect(parseDeviceCache(value, other)).toBeNull();
  });

  it("no accent is '-'", () => {
    const none = { appearance: defaultAppearancePreferences, version: 0 };
    expect(parseDeviceCache(serializeDeviceCache(owner, none), owner)).toEqual(
      none,
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["another format", `2.${owner}.12.ecrin.sauge.system.discrete.2F6F5E`],
    ["a field missing", `1.${owner}.12.ecrin.sauge.system.discrete`],
    ["a field too many", `1.${owner}.12.ecrin.sauge.system.discrete.2F6F5E.x`],
    ["an unknown style", `1.${owner}.12.aurore.sauge.system.discrete.2F6F5E`],
    ["a prototype key", `1.${owner}.12.ecrin.constructor.system.discrete.-`],
    ["a bad accent", `1.${owner}.12.ecrin.sauge.system.discrete.2F6F5`],
    ["a bad version", `1.${owner}.-1.ecrin.sauge.system.discrete.-`],
    [
      "a version with leading zero",
      `1.${owner}.012.ecrin.sauge.system.discrete.-`,
    ],
    ["a huge value", `1.${owner}.${"9".repeat(300)}`],
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
