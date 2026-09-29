import { describe, expect, it } from "vitest";

import {
  detailsStepSchema,
  identityStepSchema,
  onboardingSchema,
} from "./schemas";

const valid = {
  firstName: " Mila ",
  lastName: "Laurent",
  businessName: "Studio Mila",
  slug: "studio-mila",
  timezone: "Europe/Paris",
  minimumBookingNoticeMinutes: 120,
  maximumBookingAdvanceDays: 90,
  bufferMinutes: 10,
  phone: "",
  location: "",
  description: "",
  cancellationPolicy: "",
  slugEdited: true,
};

describe("onboardingSchema", () => {
  it("trims values, drops empty optional fields and UI-only keys", () => {
    const result = onboardingSchema.parse(valid);
    expect(result.firstName).toBe("Mila");
    expect(result.phone).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect("slugEdited" in result).toBe(false);
  });

  it("rejects an unusable slug and an unknown timezone", () => {
    const result = onboardingSchema.safeParse({
      ...valid,
      slug: "ab",
      timezone: "Mars/Olympus",
    });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path[0]);
    expect(paths).toContain("slug");
    expect(paths).toContain("timezone");
  });
});

describe("step schemas", () => {
  it("requires the identity fields", () => {
    const result = identityStepSchema.safeParse({
      firstName: "",
      lastName: " ",
      businessName: "",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(3);
  });

  it("validates optional details only when filled", () => {
    expect(detailsStepSchema.safeParse({ phone: "" }).success).toBe(true);
    expect(
      detailsStepSchema.safeParse({ phone: "06 12 34 56 78" }).success,
    ).toBe(true);
    expect(
      detailsStepSchema.safeParse({ phone: "+33 (0)6 12-34.56" }).success,
    ).toBe(true);
    expect(detailsStepSchema.safeParse({ phone: "abc" }).success).toBe(false);
    expect(detailsStepSchema.safeParse({ phone: "12345" }).success).toBe(false);
    expect(
      detailsStepSchema.safeParse({ description: "x".repeat(301) }).success,
    ).toBe(false);
  });
});
