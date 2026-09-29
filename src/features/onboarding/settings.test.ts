import { describe, expect, it } from "vitest";

import {
  bufferOptions,
  defaultBookingSettings,
  formatHorizon,
  formatNotice,
  horizonOptions,
  noticeOptions,
  summarizeBookingSettings,
  timezoneOptions,
} from "./settings";

describe("booking settings options", () => {
  it.each([
    ["notice", noticeOptions, 0, 10080],
    ["horizon", horizonOptions, 1, 365],
    ["buffer", bufferOptions, 0, 240],
  ] as const)(
    "%s options stay within the CHECK constraint",
    (_, options, min, max) => {
      for (const { value } of options) {
        expect(value).toBeGreaterThanOrEqual(min);
        expect(value).toBeLessThanOrEqual(max);
      }
    },
  );

  it("offer the defaults as selectable options", () => {
    expect(noticeOptions.map((o) => o.value)).toContain(
      defaultBookingSettings.minimumBookingNoticeMinutes,
    );
    expect(horizonOptions.map((o) => o.value)).toContain(
      defaultBookingSettings.maximumBookingAdvanceDays,
    );
    expect(bufferOptions.map((o) => o.value)).toContain(
      defaultBookingSettings.bufferMinutes,
    );
  });
});

describe("human formatting", () => {
  it("formats the minimum notice", () => {
    expect(formatNotice(0)).toBe("jusqu’à la dernière minute");
    expect(formatNotice(30)).toBe("jusqu’à 30 min avant");
    expect(formatNotice(120)).toBe("jusqu’à 2 h avant");
    expect(formatNotice(1440)).toBe("jusqu’à la veille");
    expect(formatNotice(2880)).toBe("jusqu’à 2 jours avant");
  });

  it("formats the booking horizon", () => {
    expect(formatHorizon(14)).toBe("2 semaines à l’avance");
    expect(formatHorizon(90)).toBe("3 mois à l’avance");
    expect(formatHorizon(45)).toBe("45 jours à l’avance");
  });

  it("summarizes the settings in one sentence", () => {
    expect(
      summarizeBookingSettings({
        minimumBookingNoticeMinutes: 120,
        maximumBookingAdvanceDays: 90,
        bufferMinutes: 0,
      }),
    ).toBe(
      "Tes clientes pourront réserver 3 mois à l’avance, jusqu’à 2 h avant, sans pause entre deux rendez-vous.",
    );
  });
});

describe("timezoneOptions", () => {
  it("adds a valid browser zone that is not in the list", () => {
    expect(timezoneOptions("Asia/Tokyo")[0]).toEqual({
      value: "Asia/Tokyo",
      label: "Tokyo",
    });
  });

  it("ignores invalid zones", () => {
    expect(
      timezoneOptions("Nowhere/Land").some((o) => o.value === "Nowhere/Land"),
    ).toBe(false);
  });
});
