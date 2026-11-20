import { afterEach, describe, expect, it, vi } from "vitest";

import { getCronSecret } from "@/lib/env/server";

import { GET, POST } from "./route";

const SECRET = "s".repeat(40);

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(authorization?: string) {
  return new Request("http://localhost/api/cron/emails", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

describe("/api/cron/emails", () => {
  it("refuses any call without the exact cron secret", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const authorization of [
      undefined,
      "Bearer wrong",
      `Bearer ${SECRET}x`,
      SECRET,
      `bearer ${SECRET}`,
    ]) {
      const response = await POST(request(authorization));
      expect(response.status, String(authorization)).toBe(401);
    }
  });

  it("refuses every call when no secret is configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(request("Bearer "))).status).toBe(401);
  });

  it.each(["\n", "\r\n", " "])(
    "accepts a configured secret copied with surrounding whitespace %j",
    async (padding) => {
      vi.stubEnv("CRON_SECRET", `${padding}${SECRET}${padding}`);
      vi.stubEnv("EMAIL_TRANSPORT", "");
      const response = await GET(request(`Bearer ${SECRET}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: { skipped: "not_configured" },
      });
    },
  );

  it("keeps the minimum secret length after removing copied padding", () => {
    vi.stubEnv("CRON_SECRET", ` ${"s".repeat(31)}\n`);
    expect(getCronSecret()).toBeNull();
  });

  it("claims nothing when no transport is configured", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("EMAIL_TRANSPORT", "");
    const response = await POST(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { skipped: "not_configured" },
    });
  });
});
