import { describe, expect, it } from "vitest";

import { outboundEvent, toOutboundStatusDto } from "./outbound";

const raw = {
  connectionStatus: "active" as const,
  writeAuthorized: true,
  status: "active" as const,
  actionCode: null,
  calendarCreated: true,
  lastError: null,
  pendingCount: 0,
  errorCount: 0,
};

describe("outbound status", () => {
  it("separates healthy, pending, retrying and action required", () => {
    expect(toOutboundStatusDto(raw, true)).toMatchObject({
      health: "healthy",
      actionRequired: null,
    });
    expect(toOutboundStatusDto({ ...raw, pendingCount: 2 }, true).health).toBe(
      "pending",
    );
    expect(
      toOutboundStatusDto({ ...raw, pendingCount: 2, errorCount: 1 }, true)
        .health,
    ).toBe("retrying");
    expect(
      toOutboundStatusDto(
        {
          ...raw,
          status: "action_required",
          actionCode: "calendar_deleted",
          calendarCreated: false,
          pendingCount: 3,
        },
        true,
      ),
    ).toMatchObject({
      health: "action_required",
      actionRequired: "reactivate",
      reason: "calendar_deleted",
    });
    expect(
      toOutboundStatusDto({ ...raw, writeAuthorized: false }, true),
    ).toMatchObject({
      health: "action_required",
      actionRequired: "authorize_write",
    });
    expect(
      toOutboundStatusDto(
        { ...raw, connectionStatus: "reauth_required" },
        true,
      ),
    ).toMatchObject({ health: "action_required", actionRequired: "reconnect" });
    expect(
      toOutboundStatusDto(
        { ...raw, status: "disabled", actionCode: "account_changed" },
        true,
      ),
    ).toMatchObject({ health: "disabled", actionRequired: "enable_again" });
    expect(
      toOutboundStatusDto(
        {
          ...raw,
          status: "action_required",
          actionCode: "calendar_creation_uncertain",
          calendarCreated: false,
        },
        true,
      ),
    ).toMatchObject({
      health: "action_required",
      actionRequired: "reactivate",
      reason: "calendar_creation_uncertain",
    });
    expect(
      toOutboundStatusDto({ ...raw, status: "creating" }, true).health,
    ).toBe("pending");
  });
});

describe("outbound event", () => {
  it("carries the instants as given, a first name and a service only", () => {
    expect(
      outboundEvent({
        appointmentId: "a1",
        businessId: "b",
        claimId: "c",
        generation: "g",
        connectionId: "k",
        credentialGeneration: "cg",
        revision: 3,
        eventId: "bk00",
        targetCalendarId: "t",
        previousCalendarId: null,
        active: true,
        startsAt: "2026-10-14T14:00:00+00:00",
        endsAt: "2026-10-14T15:00:00+00:00",
        serviceName: "Coupe",
        clientFirstName: " Léa ",
      }),
    ).toEqual({
      id: "bk00",
      summary: "Léa — Coupe",
      startsAt: "2026-10-14T14:00:00+00:00",
      endsAt: "2026-10-14T15:00:00+00:00",
      privateProperties: {
        origin: "booking-saas",
        appointmentId: "a1",
        revision: "3",
      },
    });
  });
});
