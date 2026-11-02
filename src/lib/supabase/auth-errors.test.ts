import {
  AuthApiError,
  AuthInvalidJwtError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { authFailureOf } from "./auth-errors";

describe("authFailureOf", () => {
  it.each([
    ["no answer (network)", new AuthRetryableFetchError("fetch failed", 0)],
    ["a gateway 502", new AuthRetryableFetchError("Bad Gateway", 502)],
    ["a 503", new AuthRetryableFetchError("unavailable", 503)],
    ["an unreadable answer", new AuthUnknownError("unexpected", null)],
    ["a 500 API error", new AuthApiError("boom", 500, "unexpected_failure")],
    [
      "a rate limit",
      new AuthApiError("slow down", 429, "over_request_rate_limit"),
    ],
    ["a thrown TypeError", new TypeError("fetch failed")],
  ])("%s: unavailable (never a sign-out)", (_label, error) => {
    expect(authFailureOf(error)).toBe("unavailable");
  });

  it.each([
    ["no session", new AuthSessionMissingError()],
    ["a forged token", new AuthApiError("invalid JWT", 403, "bad_jwt")],
    [
      "an unknown user",
      new AuthApiError("User not found", 404, "user_not_found"),
    ],
    [
      "a refresh token refused",
      new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found"),
    ],
    [
      "an expired session",
      new AuthApiError("Session expired", 401, "session_expired"),
    ],
    [
      "an invalid JWT (checked locally)",
      new AuthInvalidJwtError("Invalid JWT signature"),
    ],
  ])("%s: signed out", (_label, error) => {
    expect(authFailureOf(error)).toBe("signed_out");
  });
});
