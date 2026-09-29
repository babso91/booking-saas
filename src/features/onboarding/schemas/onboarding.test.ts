import { describe, expect, it } from "vitest";

import { signInSchema, signUpSchema } from "@/features/auth/schemas/auth";

import { completeOnboardingSchema } from "./onboarding";

const minimal = {
  firstName: "Mila",
  lastName: "Durand",
  businessName: "Studio Mila",
  slug: "Studio Mila",
};

describe("completeOnboardingSchema", () => {
  it("applies the documented defaults", () => {
    expect(completeOnboardingSchema.parse(minimal)).toEqual({
      ...minimal,
      timezone: "Europe/Paris",
      description: undefined,
      contactEmail: undefined,
      phone: undefined,
      location: undefined,
      cancellationPolicy: undefined,
      minimumBookingNoticeMinutes: 120,
      maximumBookingAdvanceDays: 90,
      bufferMinutes: 0,
    });
  });

  it("treats empty optional fields as absent", () => {
    expect(
      completeOnboardingSchema.parse({
        ...minimal,
        phone: "",
        contactEmail: " ",
        location: "",
      }),
    ).toMatchObject({
      phone: undefined,
      contactEmail: undefined,
      location: undefined,
    });
  });

  it.each([
    ["firstName", { firstName: " " }],
    ["timezone", { timezone: "Europe/Atlantis" }],
    ["contactEmail", { contactEmail: "not-an-email" }],
    ["phone", { phone: "call me" }],
    ["maximumBookingAdvanceDays", { maximumBookingAdvanceDays: 0 }],
    ["bufferMinutes", { bufferMinutes: 1.5 }],
  ])("rejects an invalid %s", (field, override) => {
    const result = completeOnboardingSchema.safeParse({
      ...minimal,
      ...override,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe(field);
  });

  it("does not accept any user or owner identifier", () => {
    const parsed = completeOnboardingSchema.parse({
      ...minimal,
      userId: "someone-else",
      ownerUserId: "someone-else",
    });

    expect(parsed).not.toHaveProperty("userId");
    expect(parsed).not.toHaveProperty("ownerUserId");
  });
});

describe("auth schemas", () => {
  it("normalises the email and enforces the password policy on sign-up", () => {
    expect(
      signUpSchema.parse({
        email: " Mila@Example.TEST ",
        password: "0123456789",
      }),
    ).toMatchObject({ email: "mila@example.test" });
    expect(
      signUpSchema.safeParse({ email: "m@x.fr", password: "short" }).success,
    ).toBe(false);
  });

  it("does not reveal the password policy on sign-in", () => {
    expect(
      signInSchema.safeParse({ email: "m@x.fr", password: "short" }).success,
    ).toBe(true);
  });
});
