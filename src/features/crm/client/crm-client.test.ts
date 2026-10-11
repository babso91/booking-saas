import { describe, expect, it } from "vitest";

import {
  appointmentEvent,
  at,
  emailEvent,
  loyaltyEvent,
} from "../../../../tests/support/crm-fixtures";
import {
  appointmentStatusCopy,
  emailStatusLabels,
  emailTitles,
  filterLabels,
  loyaltyTitles,
  pointsLabel,
  sortLabels,
} from "./copy";
import {
  appendUnique,
  directoryHref,
  parseDirectoryQuery,
} from "./directory-state";
import {
  agendaDayHref,
  dateWithYear,
  dayAndTime,
  dayMonthYear,
  initials,
  monthAndYear,
  timeLabel,
} from "./format";
import { contactAtTheTime, groupTimeline } from "./timeline";

describe("dates come from the business wall clock, never the device", () => {
  it("formats from `local` only", () => {
    // `at` deliberately says another day: only `local` is read.
    const instant = {
      at: "2026-10-24T23:30:00Z",
      local: "2026-10-24T14:30",
      occurrence: null,
    };
    expect(dayAndTime(instant)).toBe("sam. 24 oct. · 14:30");
    expect(dayMonthYear(instant)).toBe("24 octobre 2026");
    expect(monthAndYear(at("2025-03-21T10:00"))).toBe("mars 2025");
    expect(dateWithYear(at("2026-10-02T14:30"), "2026")).toBe("2 oct.");
    expect(dateWithYear(at("2025-07-02T14:30"), "2026")).toBe("2 juil. 2025");
  });

  it("says which 02:30 in the repeated autumn hour", () => {
    expect(timeLabel(at("2026-10-25T02:30", "first"))).toBe(
      "02:30 (heure d’été)",
    );
    expect(timeLabel(at("2026-10-25T02:30", "second"))).toBe(
      "02:30 (heure d’hiver)",
    );
  });

  it("links to the agenda day of the business-local date", () => {
    expect(agendaDayHref(at("2026-10-24T23:30"))).toBe("/app?date=2026-10-24");
  });

  it("initials of the current record", () => {
    expect(initials("Emma", "Laurent")).toBe("EL");
    expect(initials("élodie", null)).toBe("É");
    expect(initials(" ", null)).toBe("?");
  });
});

describe("directory address", () => {
  it("reads only known values, defaults otherwise", () => {
    expect(parseDirectoryQuery({})).toEqual({
      query: "",
      filter: "all",
      sort: "name",
    });
    expect(
      parseDirectoryQuery({
        q: "Emma",
        filter: "upcoming",
        sort: "last_visit",
      }),
    ).toEqual({ query: "Emma", filter: "upcoming", sort: "last_visit" });
    expect(
      parseDirectoryQuery({ q: ["a", "b"], filter: "vip", sort: "revenue" }),
    ).toEqual({ query: "a", filter: "all", sort: "name" });
    expect(parseDirectoryQuery({ q: "x".repeat(150) }).query).toHaveLength(100);
  });

  it("writes defaults out, encodes the rest", () => {
    expect(directoryHref({ query: "", filter: "all", sort: "name" })).toBe(
      "/app/clients",
    );
    expect(
      directoryHref({ query: "Léa P", filter: "visited", sort: "most_visits" }),
    ).toBe("/app/clients?q=L%C3%A9a+P&filter=visited&sort=most_visits");
    expect(directoryHref({ query: "   ", filter: "all", sort: "name" })).toBe(
      "/app/clients",
    );
  });

  it("a row seen again on a later page is shown once", () => {
    const shown = [{ id: "a" }, { id: "b" }];
    expect(appendUnique(shown, [{ id: "b" }, { id: "c" }])).toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
  });
});

describe("timeline grouping", () => {
  it("groups by local day, keeps the server order, and breaks on years", () => {
    const events = [
      appointmentEvent({ start: "2026-10-02T14:30", end: "2026-10-02T15:30" }),
      loyaltyEvent({ local: "2026-10-02T10:00" }),
      emailEvent({ local: "2026-09-29T18:00" }),
      appointmentEvent({ start: "2025-12-31T23:30", end: "2026-01-01T00:30" }),
    ];
    const years = groupTimeline(events);
    expect(years.map((year) => year.year)).toEqual(["2026", "2025"]);
    expect(years[0]!.days.map((day) => day.date)).toEqual([
      "2026-10-02",
      "2026-09-29",
    ]);
    expect(years[0]!.days[0]!.events.map((event) => event.kind)).toEqual([
      "appointment",
      "loyalty",
    ]);
    expect(years[1]!.days[0]!.date).toBe("2025-12-31");
  });

  it("shows the contact of the time only where it differs from the record", () => {
    const current = {
      firstName: "Emma",
      lastName: "Laurent",
      email: "emma.laurent@exemple.fr",
      phone: "06 12 34 56 78",
    };
    expect(contactAtTheTime({ ...current }, current)).toBeNull();
    expect(
      contactAtTheTime(
        {
          firstName: "Emma",
          lastName: "L.",
          email: "emma.l@exemple.fr",
          phone: null,
        },
        current,
      ),
    ).toBe("Emma L. · emma.l@exemple.fr");
  });
});

describe("copy", () => {
  const JARGON =
    /chiffre d’affaires|chiffre d'affaires|encaiss|payé|revenu|délivré|reçu|scheduled|pending|completed|no_show|null|undefined/i;

  it("every label is plain French", () => {
    const all = [
      ...Object.values(filterLabels),
      ...Object.values(sortLabels),
      ...Object.values(appointmentStatusCopy).map((value) => value.label),
      ...Object.values(loyaltyTitles),
      ...Object.values(emailTitles),
      ...Object.values(emailStatusLabels),
    ];
    for (const label of all) expect(label, label).not.toMatch(JARGON);
  });

  it("a scheduled email is never presented as sent", () => {
    expect(emailStatusLabels.scheduled).toBe("Programmé · pas encore envoyé");
    expect(emailStatusLabels.sent).toBe("Envoyé");
  });

  it("a past confirmed appointment is waiting for its status, never a visit", () => {
    expect(appointmentStatusCopy.confirmed).toEqual({
      label: "Statut à indiquer",
      tone: "pending",
    });
  });

  it("points with a real minus sign", () => {
    expect(pointsLabel(10)).toBe("+10 points");
    expect(pointsLabel(-100)).toBe("−100 points");
    expect(pointsLabel(1)).toBe("+1 point");
  });
});
