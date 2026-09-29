import { describe, expect, it } from "vitest";

import {
  agendaRangeSchema,
  blockInputSchema,
  createAppointmentSchema,
  MAX_AGENDA_RANGE_DAYS,
  setAppointmentStatusSchema,
  updateAppointmentSchema,
} from "./agenda";

const SERVICE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CLIENT = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("agendaRangeSchema", () => {
  it("accepts one day up to the maximum span", () => {
    expect(
      agendaRangeSchema.parse({
        startDate: "2026-10-01",
        endDate: "2026-10-01",
      }),
    ).toEqual({
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      includeCancelled: false,
    });
    expect(
      agendaRangeSchema.safeParse({
        startDate: "2026-10-01",
        endDate: "2026-11-11",
      }).success,
    ).toBe(true);
    expect(MAX_AGENDA_RANGE_DAYS).toBe(42);
  });

  it.each([
    [{ startDate: "2026-10-02", endDate: "2026-10-01" }],
    [{ startDate: "2026-10-01", endDate: "2026-11-12" }],
    [{ startDate: "2026-02-30", endDate: "2026-03-01" }],
    [{ startDate: "2026-10-01T00:00", endDate: "2026-10-02" }],
    [{ startDate: "2026-10-01" }],
  ])("refuses %j", (input) => {
    expect(agendaRangeSchema.safeParse(input).success).toBe(false);
  });
});

describe("createAppointmentSchema", () => {
  const base = { date: "2026-10-20", time: "10:00", serviceId: SERVICE };

  it("strips anything that would shape the schedule from the browser", () => {
    const parsed = createAppointmentSchema.parse({
      ...base,
      client: { type: "existing", clientId: CLIENT },
      businessId: SERVICE,
      durationMinutes: 5,
      endsAt: "2026-10-20T10:05",
    });

    expect(parsed).toEqual({
      ...base,
      client: { type: "existing", clientId: CLIENT },
      internalNotes: null,
    });
  });

  it("normalises a new client and requires only a first name", () => {
    expect(
      createAppointmentSchema.parse({
        ...base,
        client: {
          type: "new",
          firstName: " Inès ",
          email: "INES@X.FR",
          phone: "",
        },
      }).client,
    ).toEqual({
      type: "new",
      firstName: "Inès",
      lastName: null,
      email: "ines@x.fr",
      phone: null,
    });
    expect(
      createAppointmentSchema.safeParse({
        ...base,
        client: { type: "new", firstName: "  " },
      }).success,
    ).toBe(false);
  });

  it.each(["24:00", "9:00", "10:60", "10h00"])("refuses time %s", (time) => {
    expect(
      createAppointmentSchema.safeParse({
        ...base,
        time,
        client: { type: "existing", clientId: CLIENT },
      }).success,
    ).toBe(false);
  });
});

describe("update and status inputs", () => {
  it("require the version the UI loaded", () => {
    const update = {
      appointmentId: SERVICE,
      date: "2026-10-20",
      time: "10:00",
      serviceId: SERVICE,
      clientId: CLIENT,
    };

    expect(updateAppointmentSchema.safeParse(update).success).toBe(false);
    expect(
      updateAppointmentSchema.safeParse({ ...update, expectedVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      updateAppointmentSchema.safeParse({ ...update, expectedVersion: 3 })
        .success,
    ).toBe(true);
  });

  it("accepts only the four V1 statuses", () => {
    const input = { appointmentId: SERVICE, expectedVersion: 1 };

    for (const status of ["confirmed", "completed", "cancelled", "no_show"]) {
      expect(
        setAppointmentStatusSchema.safeParse({ ...input, status }).success,
      ).toBe(true);
    }
    expect(
      setAppointmentStatusSchema.safeParse({ ...input, status: "pending" })
        .success,
    ).toBe(false);
  });
});

describe("blockInputSchema", () => {
  it("accepts a period or whole days", () => {
    expect(
      blockInputSchema.safeParse({
        allDay: false,
        startsAt: "2026-10-20T12:00",
        endsAt: "2026-10-20T14:00",
      }).success,
    ).toBe(true);
    expect(
      blockInputSchema.safeParse({
        allDay: true,
        startDate: "2026-10-20",
        endDate: "2026-10-22",
      }).success,
    ).toBe(true);
  });

  it("refuses inverted periods and days", () => {
    expect(
      blockInputSchema.safeParse({
        allDay: false,
        startsAt: "2026-10-20T14:00",
        endsAt: "2026-10-20T12:00",
      }).success,
    ).toBe(false);
    expect(
      blockInputSchema.safeParse({
        allDay: true,
        startDate: "2026-10-22",
        endDate: "2026-10-20",
      }).success,
    ).toBe(false);
  });
});

describe("malformed dates", () => {
  it("are validation errors, never exceptions", () => {
    expect(
      blockInputSchema.safeParse({
        allDay: true,
        startDate: "2026-10-20T00:00",
        endDate: "nope",
      }).success,
    ).toBe(false);
  });
});

describe("canonical inputs", () => {
  const base = {
    date: "2026-10-20",
    time: "10:00",
    serviceId: SERVICE,
  };

  it("trims and lower-cases an email before validating it", () => {
    const parsed = createAppointmentSchema.parse({
      ...base,
      client: { type: "new", firstName: "Test", email: " Test@Example.com " },
    });

    expect(parsed.client).toMatchObject({ email: "test@example.com" });
    expect(
      createAppointmentSchema.safeParse({
        ...base,
        client: { type: "new", firstName: "Test", email: " pas un email " },
      }).success,
    ).toBe(false);
  });

  it("normalises text to Unicode NFC", () => {
    const composed = "Émilie";
    const decomposed = "Émilie";
    expect(composed).not.toBe(decomposed);

    const parsed = createAppointmentSchema.parse({
      ...base,
      client: {
        type: "new",
        firstName: decomposed,
        lastName: ` ${decomposed} `,
      },
      internalNotes: `Note ${decomposed}`,
    });

    expect(parsed.client).toMatchObject({
      firstName: composed,
      lastName: composed,
    });
    expect(parsed.internalNotes).toBe(`Note ${composed}`);
  });

  it("accepts startOccurrence sent back as is: first, second, null or absent", () => {
    const update = {
      appointmentId: SERVICE,
      expectedVersion: 1,
      date: "2026-10-25",
      time: "02:30",
      serviceId: SERVICE,
      clientId: CLIENT,
    };

    for (const occurrence of ["first", "second"] as const) {
      expect(
        updateAppointmentSchema.parse({ ...update, occurrence }).occurrence,
      ).toBe(occurrence);
    }
    // null (outside the repeated hour) means "not given", like absence.
    expect(
      updateAppointmentSchema.parse({ ...update, occurrence: null }).occurrence,
    ).toBe(undefined);
    expect(updateAppointmentSchema.parse(update).occurrence).toBe(undefined);
    expect(
      createAppointmentSchema.parse({
        ...base,
        occurrence: null,
        client: { type: "existing", clientId: CLIENT },
      }).occurrence,
    ).toBe(undefined);
    expect(
      updateAppointmentSchema.safeParse({ ...update, occurrence: "third" })
        .success,
    ).toBe(false);
  });
});
