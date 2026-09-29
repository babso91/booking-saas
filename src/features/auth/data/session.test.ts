import { describe, expect, it } from "vitest";

import { destinationFor } from "./session";
import { safeNextPath } from "./redirects";

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
