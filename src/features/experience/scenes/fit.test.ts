import { describe, expect, it } from "vitest";

import { displayWidthEm } from "./fit";

// Widths measured in the browser at 100px (Bodoni Moda, the widest of the
// display faces for these words): the estimate must never be narrower.
const MEASURED_EM: Record<string, number> = {
  Mila: 258 / 133,
  Lumière: 297 / 82,
  Hammam: 405 / 96,
  Maëlys: 294 / 96,
  Wonderlash: 296 / 58,
  MMMMMM: 486 / 96,
};

describe("displayWidthEm", () => {
  it.each(Object.entries(MEASURED_EM))(
    "never underestimates %s",
    (word, measured) => {
      expect(displayWidthEm(word, false)).toBeGreaterThanOrEqual(measured);
    },
  );

  it("keeps a short name like Mila at the universe's own size", () => {
    // 34vw at 390 px is 133 px; the frame is 358 px wide.
    expect(358 / displayWidthEm("Mila", false)).toBeGreaterThan(133);
  });

  it("reads accents as their letter and capitals as wider", () => {
    expect(displayWidthEm("è", false)).toBe(displayWidthEm("e", false));
    expect(displayWidthEm("lumiere", true)).toBeGreaterThan(
      displayWidthEm("lumiere", false),
    );
  });
});
