import { describe, expect, it } from "vitest";

import { destinationFor } from "./session";
import { authCallbackUrl, safeNextPath } from "./redirects";

const user = { id: "u", email: "u@x.fr", emailConfirmed: true };

describe("destinationFor", () => {
  it("sends each state to the only route that accepts it (no loop)", () => {
    expect(destinationFor({ status: "unauthenticated" })).toBe("/login");
    expect(destinationFor({ status: "onboarding_required", user })).toBe(
      "/onboarding",
    );
    expect(
      destinationFor({
        status: "ready",
        user,
        business: { id: "b", slug: "s", name: "n", timezone: "Europe/Paris" },
      }),
    ).toBe("/app");
  });
});

describe("safeNextPath", () => {
  it("accepts known internal paths only", () => {
    expect(safeNextPath("/onboarding")).toBe("/onboarding");
    expect(safeNextPath("/app")).toBe("/app");
  });

  it.each([
    null,
    "",
    "https://evil.example",
    "//evil.example",
    "/app/../admin",
    "/b/x",
  ])("falls back to /app for %s", (value) => {
    expect(safeNextPath(value)).toBe("/app");
  });
});

describe("authCallbackUrl", () => {
  it("builds the callback on the configured origin", () => {
    expect(authCallbackUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/auth/callback",
    );
    expect(authCallbackUrl("https://app.example.com/")).toBe(
      "https://app.example.com/auth/callback",
    );
  });

  it("keeps only the origin of the configured URL", () => {
    expect(authCallbackUrl("https://app.example.com/some/path?x=1")).toBe(
      "https://app.example.com/auth/callback",
    );
  });
});
