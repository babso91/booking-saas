import { describe, expect, it } from "vitest";

import { withoutCallbackResult } from "./callback-url";

const origin = "http://localhost:3000";

describe("withoutCallbackResult", () => {
  it.each([
    ["/app/settings/calendar?calendar=connected", "/app/settings/calendar"],
    [
      "/app/settings/calendar?calendar=connected&keep=1",
      "/app/settings/calendar?keep=1",
    ],
    [
      "/app/settings/calendar?calendar=connected&keep=1#availability",
      "/app/settings/calendar?keep=1#availability",
    ],
    [
      "/app/settings/calendar?a=1&calendar=denied&b=two%20words#x",
      "/app/settings/calendar?a=1&b=two+words#x",
    ],
    // Every result uses the same single key (the callback's `calendar`).
    [
      "/app/settings/calendar?calendar=account_mismatch&utm=mail",
      "/app/settings/calendar?utm=mail",
    ],
    ["/app/settings/calendar?calendar=", "/app/settings/calendar"],
  ])("%s → %s", (input, expected) => {
    expect(withoutCallbackResult(`${origin}${input}`)).toBe(expected);
  });

  it("leaves an address without the callback result alone", () => {
    expect(
      withoutCallbackResult(
        `${origin}/app/settings/calendar?keep=1#availability`,
      ),
    ).toBeNull();
    expect(withoutCallbackResult(`${origin}/app/settings/calendar`)).toBeNull();
  });
});
