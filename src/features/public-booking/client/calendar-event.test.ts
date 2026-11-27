import { describe, expect, it } from "vitest";

import { calendarFile, googleCalendarHref } from "./calendar-event";

const event = {
  id: "a1b2c3",
  title: "Rehaussement de cils · Studio Mila",
  startsAt: "2026-11-28T09:30:00.000Z",
  endsAt: "2026-11-28T10:30:00Z",
  location: "12 rue des Lilas, Paris",
  details: "Venir sans maquillage;\nsonner au 2e",
};

describe("her appointment in her calendar (Higani 79)", () => {
  it("writes a calendar file with the booking's UTC times", () => {
    const file = calendarFile(event, new Date("2026-11-27T20:00:00Z"));
    expect(file).toContain("UID:a1b2c3@higani\r\n");
    expect(file).toContain("DTSTAMP:20261127T200000Z\r\n");
    expect(file).toContain("DTSTART:20261128T093000Z\r\n");
    expect(file).toContain("DTEND:20261128T103000Z\r\n");
    expect(file).toContain("LOCATION:12 rue des Lilas\\, Paris\r\n");
    expect(file).toContain(
      "DESCRIPTION:Venir sans maquillage\\;\\nsonner au 2e\r\n",
    );
    expect(file.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(file.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("folds long lines at 75 bytes without cutting a letter", () => {
    const file = calendarFile({ ...event, details: "é".repeat(100) });
    const encoder = new TextEncoder();
    for (const line of file.split("\r\n"))
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    const unfolded = file.replace(/\r\n /g, "");
    expect(unfolded).toContain(`DESCRIPTION:${"é".repeat(100)}\r\n`);
  });

  it("leaves out a place or details she did not publish", () => {
    const file = calendarFile({ ...event, location: null, details: "" });
    expect(file).not.toContain("LOCATION");
    expect(file).not.toContain("DESCRIPTION");
  });

  it("opens Google Calendar's form with the same event", () => {
    const url = new URL(googleCalendarHref(event));
    expect(url.origin).toBe("https://calendar.google.com");
    expect(url.searchParams.get("dates")).toBe(
      "20261128T093000Z/20261128T103000Z",
    );
    expect(url.searchParams.get("text")).toBe(event.title);
    expect(url.searchParams.get("location")).toBe(event.location);
  });
});
