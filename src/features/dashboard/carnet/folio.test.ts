import { describe, expect, it } from "vitest";

import { agenda, appointment } from "../../../../tests/support/agenda-fixtures";
import { todayModel } from "../client/today-model";
import {
  folioOf,
  frTime,
  isoWeek,
  ledeOf,
  pageOf,
  weekMonths,
  weekSpan,
} from "./folio";

const DAY = "2026-09-29";
const lede = (appointments: ReturnType<typeof appointment>[], at: string) =>
  ledeOf(
    todayModel(
      agenda("2026-09-28", "2026-10-05", { appointments }),
      DAY,
      Date.parse(at),
    ),
  )
    .map((part) => part.text)
    .join("");

describe("a planner's dates", () => {
  it.each([
    ["2026-01-01", 1],
    ["2026-12-28", 53],
    ["2027-01-03", 53],
    ["2027-01-04", 1],
    ["2024-12-30", 1],
    ["2026-10-27", 44],
  ])("%s is in ISO week %i", (date, week) => {
    expect(isoWeek(date)).toBe(week);
  });

  it("counts pages from 1 January, leap years and DST days alike", () => {
    expect(pageOf("2026-01-01")).toBe(1);
    expect(pageOf("2026-03-29")).toBe(88);
    expect(pageOf("2026-10-25")).toBe(298);
    expect(pageOf("2024-12-31")).toBe(366);
    expect(folioOf("2026-10-27")).toBe("Sem. 44 · p. 300");
  });

  it("says a week across a month and across a year", () => {
    const within = ["2026-11-02", "2026-11-08"];
    expect(weekMonths(within)).toBe("Novembre");
    expect(weekSpan(within)).toBe("2 – 8 novembre 2026");

    const months = ["2026-10-26", "2026-11-01"];
    expect(weekMonths(months)).toBe("Octobre – novembre");
    expect(weekSpan(months)).toBe("26 octobre – 1 novembre 2026");

    const years = ["2026-12-28", "2027-01-03"];
    expect(weekMonths(years)).toBe("Décembre – janvier");
    expect(weekSpan(years)).toBe("28 décembre 2026 – 3 janvier 2027");
  });

  it("writes an hour as she would", () => {
    expect(frTime("09:00")).toBe("9 h");
    expect(frTime("14:05")).toBe("14 h 05");
  });
});

describe("the day's sentence", () => {
  const camille = appointment({ local: `${DAY}T10:00` });

  it("says only what her agenda knows", () => {
    const said = lede([camille], `${DAY}T06:00:00Z`);
    expect(said).toMatch(/^Un rendez.vous\. Prochain : Camille à 10 h\./);
    expect(said).toMatch(/Tu finis à 11 h 15\.$/);
    expect(said).not.toMatch(/€|première|visite/);
  });

  it("a slot begun is a slot, not a service known to have started", () => {
    expect(lede([camille], `${DAY}T08:30:00Z`)).toContain(
      "Créneau de Camille en cours, fin prévue à 11 h 15.",
    );
  });

  it("marks what was booked online", () => {
    const online = appointment({ local: `${DAY}T14:00`, source: "public" });
    const parts = ledeOf(
      todayModel(
        agenda("2026-09-28", "2026-10-05", {
          appointments: [camille, online],
        }),
        DAY,
        Date.parse(`${DAY}T06:00:00Z`),
      ),
    );
    expect(parts.find((part) => part.marked)?.text).toBe("un pris en ligne");
  });

  it("two at once: said as two", () => {
    const other = appointment({ local: `${DAY}T10:15` });
    expect(lede([camille, other], `${DAY}T08:30:00Z`)).toContain(
      "Deux créneaux en cours.",
    );
  });

  it("a visit across midnight ends tomorrow", () => {
    const night = appointment({ local: `${DAY}T23:30` });
    expect(lede([night], `${DAY}T06:00:00Z`)).toContain("Tu finis demain à");
  });

  it("behind her, and an empty day", () => {
    expect(lede([camille], `${DAY}T18:00:00Z`)).toContain(
      "Il est derrière toi.",
    );
    expect(lede([], `${DAY}T06:00:00Z`)).not.toMatch(/\d/);
  });
});
