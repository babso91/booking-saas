import { describe, expect, it } from "vitest";

import type { GatewayErrorCode } from "./contract";
import {
  describeGatewayError,
  gatewayErrorCopy,
  normalizeGatewayError,
} from "./errors";

describe("normalizeGatewayError", () => {
  it("maps Supabase Auth error codes", () => {
    expect(
      normalizeGatewayError({ code: "invalid_credentials", status: 400 }),
    ).toEqual({ code: "invalid_credentials" });
    expect(normalizeGatewayError({ code: "email_not_confirmed" })).toEqual({
      code: "email_not_confirmed",
    });
    expect(normalizeGatewayError({ code: "user_already_exists" })).toEqual({
      code: "email_taken",
    });
    expect(normalizeGatewayError({ code: "over_request_rate_limit" })).toEqual({
      code: "rate_limited",
    });
  });

  it("treats fetch failures as network errors", () => {
    expect(normalizeGatewayError(new TypeError("Failed to fetch"))).toEqual({
      code: "network",
    });
    expect(normalizeGatewayError({ name: "AuthRetryableFetchError" })).toEqual({
      code: "network",
    });
  });

  it("keeps business codes raised by RPCs", () => {
    expect(
      normalizeGatewayError({ code: "P0001", message: "slug_taken" }),
    ).toEqual({ code: "slug_taken" });
    expect(normalizeGatewayError({ code: "already_onboarded" })).toEqual({
      code: "already_onboarded",
    });
  });

  it("never leaks SQLSTATEs or raw messages", () => {
    const error = normalizeGatewayError({
      code: "23505",
      message:
        'duplicate key value violates unique constraint "businesses_slug_key"',
      details: "Key (slug)=(studio-mila) already exists.",
    });
    expect(error).toEqual({ code: "unknown" });
    expect(normalizeGatewayError("boom")).toEqual({ code: "unknown" });
    expect(normalizeGatewayError(null)).toEqual({ code: "unknown" });
  });

  it("maps HTTP statuses", () => {
    expect(normalizeGatewayError({ status: 401 })).toEqual({
      code: "unauthorized",
    });
    expect(normalizeGatewayError({ status: 429 })).toEqual({
      code: "rate_limited",
    });
  });
});

describe("gatewayErrorCopy", () => {
  it("has short human copy for every code", () => {
    for (const code of Object.keys(gatewayErrorCopy) as GatewayErrorCode[]) {
      const copy = describeGatewayError({ code });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.message.length).toBeLessThan(120);
      expect(copy.message).not.toMatch(/SQL|supabase|error/i);
    }
  });
});
