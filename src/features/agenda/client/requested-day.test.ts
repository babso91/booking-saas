import { describe, expect, it } from "vitest";

import { requestedAppointment, requestedDay } from "./requested-day";

describe("requestedDay (?date= of the agenda)", () => {
  it.each([
    ["2026-10-24", "2026-10-24"],
    ["2024-02-29", "2024-02-29"],
    ["2026-02-30", undefined],
    ["2026-13-01", undefined],
    ["24/10/2026", undefined],
    ["2026-10-24T10:00", undefined],
    ["", undefined],
  ])("%s → %s", (value, expected) => {
    expect(requestedDay(value)).toBe(expected);
  });

  it("ignores anything that is not one string", () => {
    expect(requestedDay(undefined)).toBeUndefined();
    expect(requestedDay(["2026-10-24", "2026-10-25"])).toBeUndefined();
  });
});

describe("requestedAppointment (?rdv= of the agenda)", () => {
  it.each([
    [
      "0f1e2d3c-4b5a-4968-8776-655443322110",
      "0f1e2d3c-4b5a-4968-8776-655443322110",
    ],
    [
      "0F1E2D3C-4B5A-4968-8776-655443322110",
      "0f1e2d3c-4b5a-4968-8776-655443322110",
    ],
    ["0f1e2d3c-4b5a-4968-8776-65544332211", undefined],
    ["0f1e2d3c4b5a49688776655443322110", undefined],
    ["../../app/clients", undefined],
    ["", undefined],
  ])("%s → %s", (value, expected) => {
    expect(requestedAppointment(value)).toBe(expected);
  });

  it("ignores anything that is not one string", () => {
    expect(requestedAppointment(undefined)).toBeUndefined();
    expect(
      requestedAppointment([
        "0f1e2d3c-4b5a-4968-8776-655443322110",
        "0f1e2d3c-4b5a-4968-8776-655443322111",
      ]),
    ).toBeUndefined();
  });
});
