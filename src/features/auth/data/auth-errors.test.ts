import { describe, expect, it } from "vitest";

import { toAppError } from "@/lib/errors";

import { authErrorCode, authException } from "./auth-errors";

describe("authErrorCode", () => {
  it.each([
    ["invalid_credentials", "invalid_credentials"],
    ["email_not_confirmed", "email_not_confirmed"],
    ["user_already_exists", "email_taken"],
    ["email_exists", "email_taken"],
    ["weak_password", "validation_error"],
    ["over_request_rate_limit", "rate_limited"],
    ["session_not_found", "unauthenticated"],
    ["signup_disabled", "forbidden"],
  ])("maps %s to %s", (code, expected) => {
    expect(authErrorCode({ code })).toBe(expected);
  });

  it("maps HTTP 429 without code to rate_limited", () => {
    expect(authErrorCode({ status: 429 })).toBe("rate_limited");
  });

  it("hides unknown provider errors behind internal", () => {
    expect(
      toAppError(authException({ code: "something_new", message: "x" })),
    ).toEqual({
      code: "internal",
      message: "Une erreur inattendue est survenue. Merci de réessayer.",
    });
  });

  it("points weak passwords at the password field", () => {
    expect(authException({ code: "weak_password" }).fieldErrors).toEqual({
      password: ["Ce mot de passe est trop faible."],
    });
  });
});
