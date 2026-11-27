import { describe, expect, it } from "vitest";

import { atMostTwice } from "./photo-sizes";

describe("atMostTwice", () => {
  it("gives a dense screen two thirds of each length, before the entries as they were", () => {
    expect(atMostTwice("(min-width: 768px) 50vw, 90vw")).toBe(
      "(min-resolution: 2.5dppx) and (min-width: 768px) calc(50vw * 2 / 3), " +
        "(min-resolution: 2.5dppx) calc(90vw * 2 / 3), " +
        "(min-width: 768px) 50vw, 90vw",
    );
  });

  it("handles a single length", () => {
    expect(atMostTwice("100vw")).toBe(
      "(min-resolution: 2.5dppx) calc(100vw * 2 / 3), 100vw",
    );
    expect(atMostTwice("260px")).toBe(
      "(min-resolution: 2.5dppx) calc(260px * 2 / 3), 260px",
    );
  });
});
