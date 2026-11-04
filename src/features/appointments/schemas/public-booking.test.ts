import { describe, expect, it } from "vitest";

import { createPublicBookingSchema } from "./public-booking";

const valid = {
  slug: "studio-mila",
  serviceId: "5b0b7a0e-6c35-4c8a-9a39-3f4d8c1b2a10",
  startsAt: "2026-10-05T08:00:00.000Z",
  firstName: "Léa",
  email: "lea@example.test",
  requestId: "6c0b7a0e-6c35-4c8a-9a39-3f4d8c1b2a10",
};

describe("createPublicBookingSchema", () => {
  it("requires a request id (UUID), one per booking form", () => {
    const withoutId: Partial<typeof valid> = { ...valid };
    delete withoutId.requestId;
    expect(createPublicBookingSchema.safeParse(withoutId).success).toBe(false);
    expect(
      createPublicBookingSchema.safeParse({ ...valid, requestId: "retry-1" })
        .success,
    ).toBe(false);
  });

  it("requires first name and email only", () => {
    expect(createPublicBookingSchema.parse(valid)).toEqual({
      ...valid,
      lastName: undefined,
      phone: undefined,
      // A client written before options: no answer, as before.
      optionChoiceIds: [],
    });
  });

  it("accepts the chosen answers and what she was shown, nothing malformed", () => {
    const answers = [
      "6f1c1d1e-4a39-4b4f-9a49-1f6b1c4f1a01",
      "6f1c1d1e-4a39-4b4f-9a49-1f6b1c4f1a02",
    ];
    expect(
      createPublicBookingSchema.parse({
        ...valid,
        optionChoiceIds: answers,
        expectedPriceCents: 7500,
        expectedDurationMinutes: 90,
      }),
    ).toMatchObject({
      optionChoiceIds: answers,
      expectedPriceCents: 7500,
      expectedDurationMinutes: 90,
    });
    for (const bad of [
      { optionChoiceIds: ["not-a-uuid"] },
      { optionChoiceIds: [answers[0], answers[0]] },
      { optionChoiceIds: Array.from({ length: 51 }, () => answers[0]) },
      { expectedPriceCents: -1 },
      { expectedPriceCents: 12.5 },
      { expectedDurationMinutes: 721 },
    ]) {
      expect(
        createPublicBookingSchema.safeParse({ ...valid, ...bad }).success,
      ).toBe(false);
    }
  });

  it("normalises email and treats empty optional fields as absent", () => {
    const parsed = createPublicBookingSchema.parse({
      ...valid,
      slug: " Studio-Mila ",
      email: "  Lea@Example.TEST ",
      lastName: "   ",
      phone: "",
    });

    expect(parsed).toMatchObject({
      slug: "studio-mila",
      email: "lea@example.test",
      lastName: undefined,
      phone: undefined,
    });
  });

  it.each([
    ["firstName", { firstName: "  " }],
    ["email", { email: "lea" }],
    ["phone", { phone: "call me" }],
    ["startsAt", { startsAt: "2026-10-05 08:00" }],
    ["serviceId", { serviceId: "42" }],
    ["slug", { slug: "Not a slug" }],
  ])("rejects an invalid %s", (field, override) => {
    const result = createPublicBookingSchema.safeParse({
      ...valid,
      ...override,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });

  it("accepts an explicit offset on startsAt", () => {
    expect(
      createPublicBookingSchema.safeParse({
        ...valid,
        startsAt: "2026-10-05T10:00:00+02:00",
      }).success,
    ).toBe(true);
  });
});
