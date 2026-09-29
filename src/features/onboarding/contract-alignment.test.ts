import { describe, expect, it } from "vitest";

import {
  signInSchema as backendSignIn,
  signUpSchema as backendSignUp,
} from "@/features/auth/schemas/auth";
import { signInSchema, signUpSchema } from "@/features/auth/schemas";
import { completeOnboardingSchema } from "@/features/onboarding/schemas/onboarding";

import { onboardingSchema } from "./schemas";

// The UI validates first for instant feedback; the backend schemas remain
// the authority. Both must agree, except where the UI is stricter on purpose.

const base = {
  firstName: "Mila",
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
};

const accepts = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown,
) => schema.safeParse(value).success;

describe("onboarding validation matches completeOnboardingSchema", () => {
  it.each([
    ["valid input", {}],
    ["first name of 80", { firstName: "a".repeat(80) }],
    ["first name of 81", { firstName: "a".repeat(81) }],
    ["last name of 81", { lastName: "a".repeat(81) }],
    ["empty business name", { businessName: " " }],
    ["business name of 121", { businessName: "a".repeat(121) }],
    ["unknown timezone", { timezone: "Mars/Olympus" }],
    ["phone with symbols", { phone: "+33 (0)6 12-34.56" }],
    ["phone too short", { phone: "12345" }],
    ["phone with letters", { phone: "06 12 AB" }],
    ["location of 201", { location: "a".repeat(201) }],
    ["policy of 2000", { cancellationPolicy: "a".repeat(2000) }],
    ["policy of 2001", { cancellationPolicy: "a".repeat(2001) }],
    ["notice out of range", { minimumBookingNoticeMinutes: 10081 }],
    ["horizon of 0", { maximumBookingAdvanceDays: 0 }],
    ["buffer of 241", { bufferMinutes: 241 }],
  ])("%s", (_, override) => {
    const input = { ...base, ...override };
    expect(accepts(onboardingSchema, input)).toBe(
      accepts(completeOnboardingSchema, input),
    );
  });

  it("is intentionally stricter on the short onboarding description", () => {
    const input = { ...base, description: "a".repeat(301) };
    expect(accepts(completeOnboardingSchema, input)).toBe(true);
    expect(accepts(onboardingSchema, input)).toBe(false);
  });

  it("never lets through a slug the database would refuse", () => {
    for (const slug of ["ab", "login", "!!"]) {
      expect(accepts(onboardingSchema, { ...base, slug })).toBe(false);
    }
  });
});

describe("credential validation matches the auth schemas", () => {
  it.each([
    ["valid", { email: "mila@studio.fr", password: "motdepasse10" }],
    ["password of 9", { email: "mila@studio.fr", password: "a".repeat(9) }],
    ["password of 10", { email: "mila@studio.fr", password: "a".repeat(10) }],
    ["password of 73", { email: "mila@studio.fr", password: "a".repeat(73) }],
    ["invalid email", { email: "mila@", password: "motdepasse10" }],
    [
      "uppercase email",
      { email: " MILA@Studio.FR ", password: "motdepasse10" },
    ],
  ])("sign-up: %s", (_, input) => {
    expect(accepts(signUpSchema, input)).toBe(accepts(backendSignUp, input));
  });

  it.each([
    ["short password", { email: "mila@studio.fr", password: "x" }],
    ["empty password", { email: "mila@studio.fr", password: "" }],
    ["password of 73", { email: "mila@studio.fr", password: "a".repeat(73) }],
  ])("sign-in: %s", (_, input) => {
    expect(accepts(signInSchema, input)).toBe(accepts(backendSignIn, input));
  });

  it("normalises the email exactly like the backend", () => {
    const input = { email: " MILA@Studio.FR ", password: "motdepasse10" };
    expect(signUpSchema.parse(input).email).toBe(
      backendSignUp.parse(input).email,
    );
  });
});
