import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { paletteFor } from "@/features/appearance/appearance";
import { signaturePresets } from "@/features/appearance/palettes";
import { contrast } from "@/lib/color/contrast";

// Focus must always be visible. Her signature can be any colour — a pale
// yellow vanishes on the page — so no Studio focus ring is drawn with it:
// on the page, her accent (readable by construction); on the ink dock,
// paper; on her signature field, its own ink.

const root = join(process.cwd(), "src/features/dashboard");
const sources = ["components", "agenda"].flatMap((folder) =>
  readdirSync(join(root, folder))
    .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
    .map((file) => join(root, folder, file)),
);

describe("Studio focus rings", () => {
  it.each(sources.map((file) => [file.split("/dashboard/")[1], file]))(
    "%s never draws focus with the raw signature colour",
    (_, file) => {
      expect(readFileSync(file!, "utf8")).not.toMatch(/outline-signature/);
    },
  );

  it("the accent they use stands out from the page (3:1) for any signature", () => {
    const colors = [
      ...signaturePresets.map((preset) => preset.color),
      "#FFEE00",
      "#F2F2F2",
      "#808080",
      "#0A0A0A",
    ];
    for (const mode of ["light", "dark"] as const)
      for (const color of colors) {
        const palette = paletteFor("studio", "atelier", mode, color);
        expect(
          contrast(palette.accent, palette.paper),
          `${mode} ${color}`,
        ).toBeGreaterThanOrEqual(3);
        expect(contrast(palette.paper, palette.ink)).toBeGreaterThanOrEqual(3);
      }
  });
});
