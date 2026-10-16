import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppException } from "@/lib/errors";

import {
  CLIENT_IP_HEADER,
  normalizeAddress,
  PROXY_SECRET_HEADER,
  trustedClientIp,
} from "./client-identity";

const SECRET = "unit-proxy-secret-0123456789abcdef012345";

function request(headers: Record<string, string>) {
  return new Request("http://localhost/api/bookings", {
    method: "POST",
    headers,
  });
}

function refused(headers: Record<string, string>) {
  try {
    trustedClientIp(request(headers));
  } catch (error) {
    return error instanceof AppException ? error.code : "other";
  }
  return "accepted";
}

describe("normalizeAddress", () => {
  it("accepts one literal IPv4 or IPv6 address, canonical; IPv4-mapped is IPv4", () => {
    expect(normalizeAddress("198.51.100.7")).toBe("198.51.100.7");
    expect(normalizeAddress("2001:0DB8:0000::0001")).toBe("2001:db8::1");
    expect(normalizeAddress("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(normalizeAddress("::1")).toBe("::1");
  });

  it.each([
    null,
    "",
    "198.51.100.7, 10.0.0.1",
    "198.51.100.7:8080",
    "[2001:db8::1]",
    "fe80::1%eth0",
    "localhost",
    "999.1.1.1",
    "unknown",
    "198.51.100.7\u0000",
    "a".repeat(46),
  ])("refuses %j", (value) => {
    expect(normalizeAddress(value)).toBeNull();
  });
});

describe("trustedClientIp", () => {
  beforeEach(() => {
    process.env.BOOKING_PROXY_SECRET = SECRET;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.BOOKING_PROXY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns the address written by the proxy that proved its secret", () => {
    expect(
      trustedClientIp(
        request({
          [PROXY_SECRET_HEADER]: SECRET,
          [CLIENT_IP_HEADER]: "198.51.100.7",
          "x-forwarded-for": "203.0.113.9",
          "x-real-ip": "203.0.113.10",
        }),
      ),
    ).toBe("198.51.100.7");
  });

  it("never reads x-forwarded-for or x-real-ip, even when nothing else is given", () => {
    expect(
      refused({
        [PROXY_SECRET_HEADER]: SECRET,
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.10",
      }),
    ).toBe("booking_unavailable");
  });

  it("refuses without the secret, with a wrong one, or when none is configured (fail closed)", () => {
    const ip = { [CLIENT_IP_HEADER]: "198.51.100.7" };
    expect(refused(ip)).toBe("booking_unavailable");
    expect(refused({ ...ip, [PROXY_SECRET_HEADER]: "x" })).toBe(
      "booking_unavailable",
    );
    process.env.BOOKING_PROXY_SECRET = "too-short";
    expect(refused({ ...ip, [PROXY_SECRET_HEADER]: "too-short" })).toBe(
      "booking_unavailable",
    );
    delete process.env.BOOKING_PROXY_SECRET;
    expect(refused({ ...ip, [PROXY_SECRET_HEADER]: "" })).toBe(
      "booking_unavailable",
    );
  });
});
