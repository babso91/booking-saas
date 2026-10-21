import { describe, expect, it } from "vitest";

import {
  appointmentsQuerySchema,
  encodeAppointmentCursor,
  ledgerQuerySchema,
  verifyCodeSchema,
} from "./client-hub";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("client hub schemas", () => {
  it("round-trips the appointment cursor and refuses a forged one", () => {
    const cursor = encodeAppointmentCursor("2026-10-21T08:00:00.000Z", ID);
    expect(
      appointmentsQuerySchema.parse({ scope: "past", cursor }),
    ).toMatchObject({
      cursor: { startsAt: "2026-10-21T08:00:00.000Z", id: ID },
      limit: 20,
    });
    for (const bad of ["x", Buffer.from("a|b").toString("base64url")]) {
      expect(
        appointmentsQuerySchema.safeParse({ scope: "past", cursor: bad })
          .success,
      ).toBe(false);
    }
  });

  it("bounds pages and scopes", () => {
    expect(appointmentsQuerySchema.safeParse({ scope: "all" }).success).toBe(
      false,
    );
    expect(
      appointmentsQuerySchema.safeParse({ scope: "upcoming", limit: "51" })
        .success,
    ).toBe(false);
    expect(ledgerQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(ledgerQuerySchema.safeParse({ cursor: "01" }).success).toBe(false);
  });

  it("a code is exactly 8 digits", () => {
    const base = { challengeId: ID, email: "a@b.co" };
    expect(
      verifyCodeSchema.safeParse({ ...base, code: " 12345678 " }).success,
    ).toBe(true);
    for (const code of ["123456", "1234567", "123456789", "12a45678", ""]) {
      expect(verifyCodeSchema.safeParse({ ...base, code }).success).toBe(false);
    }
  });
});
