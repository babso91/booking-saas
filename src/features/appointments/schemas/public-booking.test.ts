import { describe, expect, it } from "vitest";

import { createPublicBookingSchema } from "./public-booking";

const valid = {
  slug: "studio-mila",
  serviceId: "5b0b7a0e-6c35-4c8a-9a39-3f4d8c1b2a10",
  startsAt: "2026-10-05T08:00:00.000Z",
  firstName: "Léa",
  email: "lea@example.test",
};

describe("createPublicBookingSchema", () => {
  it("requires first name and email only", () => {
    expect(createPublicBookingSchema.parse(valid)).toEqual({
      ...valid,
      lastName: undefined,
      phone: undefined,
    });
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
