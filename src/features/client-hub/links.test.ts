import { describe, expect, it } from "vitest";
import { hubAppointmentPath, hubSignInHref, safeHubReturnPath } from "./links";

const target = hubAppointmentPath(
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
);

describe("appointment email return route", () => {
  it("keeps the exact appointment across the email-code page", () => {
    const url = new URL(hubSignInHref(target), "https://app.example.test");
    expect(url.pathname).toBe("/espace/connexion");
    expect(url.searchParams.get("next")).toBe(target);
    expect(safeHubReturnPath(url.searchParams.get("next"))).toBe(target);
    expect([...url.searchParams.keys()]).toEqual(["next"]);
  });
  it.each([
    undefined,
    [target],
    1,
    "https://evil.test",
    "//evil.test",
    "/espace/connexion",
    target + "?next=//evil.test",
    target + "#x",
    target + "\n",
    target + "/../x",
    target.replace("/rendez-vous/", "/%2frendez-vous/"),
    "/espace\\evil.test",
  ])("refuses any other destination: %j", (input) => {
    expect(safeHubReturnPath(input)).toBe("/espace");
    expect(hubSignInHref(input)).toBe("/espace/connexion");
  });
});
