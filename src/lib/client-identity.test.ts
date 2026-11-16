import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppException } from "@/lib/errors";

import {
  CLIENT_IP_HEADER,
  normalizeAddress,
  PROXY_SECRET_HEADER,
  trustedClientIp,
  VERCEL_FORWARDED_FOR_HEADER,
  VERCEL_ID_HEADER,
  VERCEL_REAL_IP_HEADER,
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

// What Vercel's edge writes on every request it hands to a function.
function edge(ip: string, extra: Record<string, string> = {}) {
  return {
    [VERCEL_ID_HEADER]: "cdg1::iad1::abcde-1730000000000-0123456789ab",
    [VERCEL_FORWARDED_FOR_HEADER]: ip,
    [VERCEL_REAL_IP_HEADER]: ip,
    "x-forwarded-for": ip,
    ...extra,
  };
}

describe("trustedClientIp, BOOKING_TRUSTED_INGRESS=vercel", () => {
  beforeEach(() => {
    process.env.BOOKING_TRUSTED_INGRESS = "vercel";
    process.env.VERCEL = "1";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.BOOKING_TRUSTED_INGRESS;
    delete process.env.VERCEL;
    delete process.env.BOOKING_PROXY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns the address Vercel's edge wrote, IPv4 or canonical IPv6", () => {
    expect(trustedClientIp(request(edge("198.51.100.7")))).toBe("198.51.100.7");
    expect(trustedClientIp(request(edge("2001:0DB8:0:0::0001")))).toBe(
      "2001:db8::1",
    );
    expect(trustedClientIp(request(edge("::ffff:198.51.100.7")))).toBe(
      "198.51.100.7",
    );
  });

  it("accepts two spellings of one address from the edge", () => {
    expect(
      trustedClientIp(
        request(
          edge("2001:db8::1", { [VERCEL_REAL_IP_HEADER]: "2001:DB8:0::1" }),
        ),
      ),
    ).toBe("2001:db8::1");
  });

  it("refuses when the two edge headers disagree (one was not written by the edge)", () => {
    expect(
      refused(edge("198.51.100.7", { [VERCEL_REAL_IP_HEADER]: "203.0.113.9" })),
    ).toBe("booking_unavailable");
    expect(
      refused(
        edge("198.51.100.7", { [VERCEL_FORWARDED_FOR_HEADER]: "203.0.113.9" }),
      ),
    ).toBe("booking_unavailable");
  });

  it("refuses when an edge header is missing", () => {
    const only = (omit: string) => {
      const headers: Record<string, string> = edge("198.51.100.7");
      delete headers[omit];
      return headers;
    };
    expect(refused(only(VERCEL_FORWARDED_FOR_HEADER))).toBe(
      "booking_unavailable",
    );
    expect(refused(only(VERCEL_REAL_IP_HEADER))).toBe("booking_unavailable");
    expect(refused(only(VERCEL_ID_HEADER))).toBe("booking_unavailable");
  });

  it.each([
    "198.51.100.7, 10.0.0.1",
    "198.51.100.7:8080",
    "[2001:db8::1]",
    "fe80::1%eth0",
    "unknown",
    "999.1.1.1",
    "",
  ])("refuses an address that is not one literal IP: %j", (value) => {
    expect(refused(edge(value))).toBe("booking_unavailable");
  });

  it("never reads x-forwarded-for alone, nor the proxy headers, even with a valid secret", () => {
    process.env.BOOKING_PROXY_SECRET = SECRET;
    expect(
      refused({
        [VERCEL_ID_HEADER]: "cdg1::x",
        "x-forwarded-for": "198.51.100.7",
        [PROXY_SECRET_HEADER]: SECRET,
        [CLIENT_IP_HEADER]: "198.51.100.7",
      }),
    ).toBe("booking_unavailable");
    // With the edge headers present, the proxy's address is not the one used.
    expect(
      trustedClientIp(
        request(
          edge("198.51.100.7", {
            [PROXY_SECRET_HEADER]: SECRET,
            [CLIENT_IP_HEADER]: "203.0.113.9",
          }),
        ),
      ),
    ).toBe("198.51.100.7");
  });

  it("refuses outside Vercel (VERCEL is not exactly 1), whatever the headers say", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      if (value === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = value;
      expect(refused(edge("198.51.100.7"))).toBe("booking_unavailable");
    }
    expect(console.error).toHaveBeenCalled();
  });
});

describe("trustedClientIp, mode selection", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.BOOKING_TRUSTED_INGRESS;
    delete process.env.VERCEL;
    delete process.env.BOOKING_PROXY_SECRET;
    vi.restoreAllMocks();
  });

  it("without the Vercel mode, ignores the edge headers even on Vercel (proxy mode, unchanged)", () => {
    process.env.VERCEL = "1";
    expect(refused(edge("198.51.100.7"))).toBe("booking_unavailable");
    process.env.BOOKING_PROXY_SECRET = SECRET;
    expect(refused(edge("198.51.100.7"))).toBe("booking_unavailable");
    expect(
      trustedClientIp(
        request(
          edge("203.0.113.9", {
            [PROXY_SECRET_HEADER]: SECRET,
            [CLIENT_IP_HEADER]: "198.51.100.7",
          }),
        ),
      ),
    ).toBe("198.51.100.7");
  });

  it("BOOKING_TRUSTED_INGRESS=proxy is the default mode", () => {
    process.env.BOOKING_TRUSTED_INGRESS = "proxy";
    process.env.BOOKING_PROXY_SECRET = SECRET;
    expect(
      trustedClientIp(
        request({
          [PROXY_SECRET_HEADER]: SECRET,
          [CLIENT_IP_HEADER]: "198.51.100.7",
        }),
      ),
    ).toBe("198.51.100.7");
  });

  it.each(["Vercel", "VERCEL", "vercel ", "auto", "none"])(
    "an unknown mode %j refuses everything, proxy and edge alike",
    (mode) => {
      process.env.BOOKING_TRUSTED_INGRESS = mode;
      process.env.VERCEL = "1";
      process.env.BOOKING_PROXY_SECRET = SECRET;
      expect(
        refused(
          edge("198.51.100.7", {
            [PROXY_SECRET_HEADER]: SECRET,
            [CLIENT_IP_HEADER]: "198.51.100.7",
          }),
        ),
      ).toBe("booking_unavailable");
      expect(console.error).toHaveBeenCalled();
    },
  );
});
